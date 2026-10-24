"""Read one frozen task container through bound directory descriptors."""

import hashlib
import json
import os
import re
import stat
import sys
import time

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
REGULAR = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
FILE_LIMIT = 32 * 1024 * 1024
TOTAL_LIMIT = 256 * 1024 * 1024


def require(value, message):
    if not value:
        raise ValueError(message)


def read_fd(fd, limit):
    before = os.fstat(fd)
    require(stat.S_ISREG(before.st_mode), "Evidence must be a regular file")
    require(0 <= before.st_size <= limit, "Evidence size limit exceeded")
    chunks = []
    size = 0
    while True:
        chunk = os.read(fd, min(65536, limit + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        require(size <= limit, "Evidence byte limit exceeded")
        chunks.append(chunk)
    after = os.fstat(fd)
    require(
        (before.st_dev, before.st_ino, before.st_size)
        == (after.st_dev, after.st_ino, after.st_size)
        and size == before.st_size,
        "Evidence changed during frozen read",
    )
    return b"".join(chunks)


def open_beneath(root, relative, directory=False):
    parts = relative.split("/")
    require(parts and all(part not in ("", ".", "..") for part in parts), "Invalid evidence path")
    current = os.dup(root)
    try:
        # Every ancestor is opened without following links, not only the leaf.
        for part in parts[:-1]:
            child = os.open(part, DIRECTORY, dir_fd=current)
            os.close(current)
            current = child
        return os.open(parts[-1], DIRECTORY if directory else REGULAR, dir_fd=current)
    finally:
        os.close(current)


def bounded_text(file, limit=65536):
    with open(file, "rb") as source:
        value = source.read(limit + 1)
    require(len(value) <= limit, "Kernel observation exceeded its bound")
    return value.decode("ascii")


def process_identity(pid):
    value = bounded_text(f"/proc/{pid}/stat")
    fields = value[value.rindex(")") + 2 :].split()
    require(len(fields) > 19 and fields[19].isdigit(), "Missing PID start identity")
    return fields[19]


def counters(text):
    result = {}
    for line in text.splitlines():
        key, value = line.split()
        require(key not in result and value.isdigit(), "Malformed cgroup counters")
        result[key] = int(value)
    return result


def kernel_path(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)


def snapshot(pid, expected_start):
    require(process_identity(pid) == expected_start, "Container PID identity changed")
    memberships = bounded_text(f"/proc/{pid}/cgroup").splitlines()
    require(len(memberships) == 1 and memberships[0].startswith("0::/"), "Require cgroup v2")
    membership = memberships[0][3:]
    mounts = []
    for line in bounded_text("/proc/self/mountinfo", 1024 * 1024).splitlines():
        fields = line.split()
        separator = fields.index("-")
        if fields[separator + 1] != "cgroup2":
            continue
        options = fields[5].split(",") + fields[separator + 3].split(",")
        require("memory_localevents" not in options, "Local OOM counters")
        mount_root, mount = kernel_path(fields[3]), kernel_path(fields[4])
        if membership == mount_root or membership.startswith(mount_root.rstrip("/") + "/"):
            mounts.append((mount_root, mount))
    require(len(mounts) == 1, "Ambiguous host cgroup mapping")
    mount_root, mount = mounts[0]
    relative = os.path.relpath(membership, mount_root)
    require(relative != "." and not relative.startswith(".."), "Container lacks a private cgroup")
    mount_fd = os.open(mount, DIRECTORY)
    try:
        group_fd = open_beneath(mount_fd, relative, directory=True)
    finally:
        os.close(mount_fd)
    try:
        identity = os.fstat(group_fd)
        names = os.listdir(group_fd)
        require(len(names) <= 256, "Unexpected cgroup inventory")
        require(
            not any(stat.S_ISDIR(os.stat(name, dir_fd=group_fd, follow_symlinks=False).st_mode) for name in names),
            "Unexpected child cgroup",
        )

        def read(name):
            fd = os.open(name, REGULAR, dir_fd=group_fd)
            try:
                # Kernel virtual files report size zero; read with a byte bound.
                data = os.read(fd, 65537)
                require(len(data) <= 65536, "Oversized cgroup observation")
                return data.decode("ascii")
            finally:
                os.close(fd)

        deadline = time.monotonic() + 5
        while counters(read("cgroup.events")).get("frozen") != 1:
            require(time.monotonic() < deadline, "Container was not frozen")
            time.sleep(0.025)
        require(read("cgroup.procs").split() == [str(pid)], "Frozen row descendants remain")
        events = counters(read("memory.events"))
        selected = {key: events[key] for key in ("oom", "oom_kill", "oom_group_kill")}
        result = {
            "identity": {"pid": pid, "device": identity.st_dev, "inode": identity.st_ino, "startTicks": expected_start},
            "frozen": True,
            "supervisorOnly": True,
            "hierarchical": True,
            "childCgroups": 0,
            "memoryBytes": int(read("memory.max")),
            "swapBytes": int(read("memory.swap.max")),
            "cpuSet": read("cpuset.cpus.effective").strip(),
            "oomGroup": int(read("memory.oom.group")),
            "events": selected,
        }
        require(process_identity(pid) == expected_start, "Container PID changed during snapshot")
        require(bounded_text(f"/proc/{pid}/cgroup").splitlines() == memberships, "Container moved cgroups")
        return result
    finally:
        os.close(group_fd)


def evidence(pid, expected_start, expected_mount, initial, cache_paths):
    require(process_identity(pid) == expected_start, "Container PID identity changed")
    # /proc/PID/root is the one intentional kernel magic link. All paths below
    # this bound root, including every writable ancestor, use openat nofollow.
    root = os.open(f"/proc/{pid}/root", os.O_RDONLY | os.O_DIRECTORY)
    try:
        artifacts = open_beneath(root, "work/.artifacts", directory=True)
    finally:
        os.close(root)
    try:
        identity = os.fstat(artifacts)
        mount = {"device": identity.st_dev, "inode": identity.st_ino}
        require(expected_mount is None or mount == expected_mount, "Artifact mount identity changed")
        require(set(os.listdir(artifacts)) == {"kysely", "tsgo-cache", "row-metrics", "dist-artifacts.lock"}, "Unexpected artifact directory")
        result = {"mount": mount, "generated": [], "cache": [], "metrics": [], "totalBytes": 0}
        generated = open_beneath(artifacts, "kysely", directory=True)
        try:
            expected = ["inputs.sha256", "openclaw-agent-db.generated.ts", "openclaw-state-db.generated.ts"]
            require(sorted(os.listdir(generated)) == expected, "Unexpected generated inputs")
            for name in expected:
                file_fd = open_beneath(generated, name)
                try:
                    value = read_fd(file_fd, 1024 * 1024)
                    require(value, "Empty generated input")
                finally:
                    os.close(file_fd)
                result["generated"].append({"path": ".artifacts/kysely/" + name, "bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()})
        finally:
            os.close(generated)
        count = 0
        for directory in ("tsgo-cache", "row-metrics", "dist-artifacts.lock"):
            fd = open_beneath(artifacts, directory, directory=True)
            try:
                require(os.fstat(fd).st_dev == identity.st_dev, "Unexpected writable child mount")
                names = sorted(os.listdir(fd))
                require(len(names) <= 38, "Too many row artifacts")
                require(not names if initial or directory == "dist-artifacts.lock" else True, "Cold cache or lock is not empty")
                for name in names:
                    relative = f".artifacts/{directory}/{name}"
                    if directory == "tsgo-cache":
                        require(relative in cache_paths, "Unplanned build-info path")
                    else:
                        require(re.fullmatch(r"tsgo-[a-f0-9-]{36}\.json", name) is not None, "Unexpected metric path")
                    file_fd = open_beneath(fd, name)
                    try:
                        require(os.fstat(file_fd).st_dev == identity.st_dev, "Unexpected evidence mount")
                        value = read_fd(file_fd, FILE_LIMIT if directory == "tsgo-cache" else 1024 * 1024)
                    finally:
                        os.close(file_fd)
                    count += 1
                    result["totalBytes"] += len(value)
                    require(count <= 76 and result["totalBytes"] <= TOTAL_LIMIT, "Aggregate row evidence limit")
                    require(value, "Empty row evidence")
                    record = {"path": relative, "bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
                    if directory == "tsgo-cache":
                        info = json.loads(value)
                        files = info.get("fileNames")
                        require(isinstance(files, list) and 0 < len(files) <= 100000, "Missing build-info inputs")
                        require(all(isinstance(file, str) and 0 < len(file) <= 4096 for file in files), "Invalid build-info input")
                        record["fileNames"] = files
                        result["cache"].append(record)
                    else:
                        record["text"] = value.decode("utf8")
                        result["metrics"].append(record)
            finally:
                os.close(fd)
        require(process_identity(pid) == expected_start, "Container PID changed during export")
        return result
    finally:
        os.close(artifacts)


def main():
    raw = sys.stdin.buffer.read(65537)
    require(len(raw) <= 65536, "Oversized host request")
    request = json.loads(raw)
    pid = request["pid"]
    require(isinstance(pid, int) and pid > 1, "Invalid container PID")
    start = request["startTicks"]
    require(isinstance(start, str) and start.isdigit(), "Invalid PID identity")
    state = snapshot(pid, start)
    output = {"snapshot": state}
    if request.get("files"):
        output["files"] = evidence(pid, start, request.get("mount"), request["initial"], request["cachePaths"])
    encoded = json.dumps(output, separators=(",", ":"))
    require(len(encoded.encode()) <= 32 * 1024 * 1024, "Host receipt output limit")
    print(encoded)


if __name__ == "__main__":
    main()
