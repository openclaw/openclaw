"""Kernel leases and bounded retirement for the PR dependency lifetime owner."""

import datetime
import errno
import fcntl
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import time


DAY_SECONDS = 24 * 60 * 60


def matches(value, expected):
    return all(str(getattr(value, "st_" + key)) == str(expected[key])
               for key in ("dev", "ino", "uid", "mode"))


def physical(path):
    if not os.path.isabs(path) or os.path.realpath(path) != path:
        raise ValueError("aliased-path")
    return os.lstat(path)


def lease_file(value):
    if (not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid()
            or stat.S_IMODE(value.st_mode) != 0o600 or value.st_nlink != 1):
        raise ValueError("unsafe-lease")


def shared(fd):
    lease_file(os.fstat(fd))
    # flock belongs to the inherited open-file description. The shell retains
    # this shared lock after the helper exits and passes it to operation children.
    fcntl.flock(fd, fcntl.LOCK_SH)


def reference(path, target):
    path = path.removesuffix(" (deleted)")
    return path == target or path.startswith(target + "/")


def linux_scan(targets):
    with open("/proc/stat", encoding="ascii") as source:
        boot = next(int(line.split()[1]) for line in source if line.startswith("btime "))
    ticks = os.sysconf("SC_CLK_TCK")
    processes = {}
    references = set()
    for name in os.listdir("/proc"):
        if not name.isdecimal():
            continue
        root = "/proc/" + name
        try:
            if os.stat(root).st_uid != os.getuid():
                continue
            with open(root + "/stat", encoding="utf8") as source:
                fields = source.read().rsplit(")", 1)[1].split()
            processes[int(name)] = None if fields[0] == "Z" else (boot + int(fields[19]) / ticks) * 1000
            paths = []
            try:
                paths.append(os.readlink(root + "/cwd"))
            except FileNotFoundError:
                pass
            for fd in os.listdir(root + "/fd"):
                try:
                    paths.append(os.readlink(root + "/fd/" + fd))
                except FileNotFoundError:
                    pass
            with open(root + "/maps", encoding="utf8") as source:
                for line in source:
                    row = line.split(None, 5)
                    if len(row) == 6 and row[5].startswith("/"):
                        paths.append(re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), row[5].rstrip("\n")))
            references.update(target for target in targets if any(reference(path, target) for path in paths))
        except (FileNotFoundError, ProcessLookupError):
            # A reaped process cannot retain a mapping, cwd or descriptor.
            continue
    return processes, references


def darwin_scan(targets):
    env = {**os.environ, "LC_ALL": "C", "TZ": "UTC0"}
    census = subprocess.run(["ps", "-axo", "pid=,uid=,lstart="], capture_output=True,
                            text=True, check=True, timeout=15, env=env)
    processes = {}
    for line in census.stdout.splitlines():
        pid, uid, started = line.split(None, 2)
        if int(uid) == os.getuid():
            birth = datetime.datetime.strptime(started.strip(), "%a %b %d %H:%M:%S %Y")
            processes[int(pid)] = birth.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000
    if os.getpid() not in processes:
        raise ValueError("incomplete-process-census")
    files = subprocess.run(["lsof", "-nP", "-Fpn"], capture_output=True,
                           text=True, check=True, timeout=15)
    if not files.stdout:
        raise ValueError("incomplete-file-census")
    references = set()
    for line in files.stdout.splitlines():
        if line.startswith("n"):
            references.update(target for target in targets if reference(line[1:], target))
    return processes, references


def process_scan(targets):
    if sys.platform == "linux":
        return linux_scan(targets)
    if sys.platform == "darwin":
        return darwin_scan(targets)
    raise ValueError("unsupported-process-census")


def newest_mtime(path, initial):
    newest = initial.st_mtime
    pending = [path]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                value = entry.stat(follow_symlinks=False)
                newest = max(newest, value.st_mtime)
                if stat.S_ISDIR(value.st_mode):
                    pending.append(entry.path)
    return newest


def retire(candidate, scan, now):
    path = candidate["path"]
    lease_fd = None
    try:
        pending = candidate.get("pending")
        if pending is not None:
            # Before SH registration no operation has started. An absent creator
            # incarnation plus an empty census closes the file-creation window;
            # a file that exists must additionally grant EX below.
            if scan is None:
                raise ValueError("process-census-unavailable")
            processes, references = scan
            if any(target in references for target in candidate["targets"]):
                raise ValueError("process-references")
            start = processes.get(int(pending["pid"]))
            if start is not None and math.floor(start / 1000) <= math.floor(pending["createdMs"] / 1000):
                raise ValueError("creator-live")
        lease = candidate.get("lease")
        if lease is not None:
            value = physical(lease["path"])
            lease_file(value)
            if not matches(value, lease):
                raise ValueError("changed-lease")
            lease_fd = os.open(lease["path"], os.O_RDWR | os.O_NOFOLLOW)
            held = os.fstat(lease_fd)
            lease_file(held)
            if not matches(held, lease):
                raise ValueError("changed-lease")
            fcntl.flock(lease_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            value = physical(path)
        except FileNotFoundError:
            value = None
        if value is not None and (
                not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid()
                or stat.S_IMODE(value.st_mode) != 0o700
                or not matches(value, candidate["identity"])):
            raise ValueError("changed-directory")
        if lease is None and pending is None:
            if scan is None:
                raise ValueError("process-census-unavailable")
            processes, references = scan
            if any(target in references for target in candidate["targets"]):
                raise ValueError("process-references")
            legacy = candidate.get("legacy")
            if candidate.get("orphan"):
                modified = newest_mtime(path, value) if value is not None else now
            elif legacy is not None:
                recorded = legacy.get("createdMs")
                recorded = recorded if isinstance(recorded, (int, float)) and math.isfinite(recorded) and recorded > 0 else None
                modified = value.st_mtime if value is not None else legacy.get("modifiedMs", 0) / 1000
                if value is None and (recorded is None or modified <= 0):
                    raise ValueError("missing-anchor-timestamp")
                created = getattr(value, "st_birthtime", None) if value is not None else None
                created_ms = created * 1000 if created else (recorded or modified * 1000)
                start = processes.get(int(legacy["pid"]))
                # A later incarnation cannot own this older anchor. Seconds that
                # overlap remain ambiguous, including Darwin's second precision.
                if start is not None and math.floor(start / 1000) <= math.floor(created_ms / 1000):
                    raise ValueError("creator-live")
            else:
                raise ValueError("missing-retirement-evidence")
            if not math.isfinite(modified) or now - modified <= DAY_SECONDS:
                raise ValueError("recent-directory")
        if value is not None:
            if not matches(physical(path), candidate["identity"]):
                raise ValueError("changed-directory")
            # rmtree unlinks child symlinks; it never traverses their targets.
            shutil.rmtree(path)
        return {"id": candidate["id"], "state": "retired"}
    except BlockingIOError:
        return {"id": candidate["id"], "state": "blocked", "reason": "lease-held"}
    except (OSError, ValueError) as error:
        reason = str(error) if isinstance(error, ValueError) else errno.errorcode.get(error.errno, "filesystem-error")
        return {"id": candidate["id"], "state": "blocked", "reason": reason}
    finally:
        if lease_fd is not None:
            os.close(lease_fd)


def batch(request):
    candidates = request["candidates"]
    targets = {target for item in candidates if item.get("lease") is None or item.get("pending") is not None for target in item["targets"]}
    scan = None
    if targets:
        try:
            scan = process_scan(targets)
        except (OSError, ValueError, StopIteration, IndexError, subprocess.SubprocessError):
            pass
    results = []
    removed = 0
    for item in candidates:
        if removed >= request.get("limit", 4):
            results.append({"id": item["id"], "state": "blocked", "reason": "batch-budget"})
            continue
        result = retire(item, scan, time.time())
        removed += result["state"] == "retired"
        results.append(result)
    return {"results": results}


def main(args):
    if len(args) == 2 and args[0] == "shared":
        shared(int(args[1]))
    elif args == ["retire"]:
        print(json.dumps(batch(json.load(sys.stdin))))
    else:
        raise ValueError("expected shared FD or retire")


if __name__ == "__main__":
    main(sys.argv[1:])
