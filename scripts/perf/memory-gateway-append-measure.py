"""Measure the Linux Gateway while five new Markdown files become searchable.

Requires a built OpenClaw checkout, Node 24.22.1 on PATH, Linux /proc and
inotify, iproute2 (ss), GNU cp, Python 3.10+, and a private fixture on /tmp.
Initialize once with "init full" (or "init smoke", add --sibling for the
separate correctness case). Run "index FIXTURE CHECKOUT" on the baseline,
then "run FIXTURE CHECKOUT" once per build. The same checkpoint and absolute
workspace path are used for each run. Run only trusted checkouts.
"""
import argparse
import ctypes
import fcntl
import json
import os
import re
import secrets
import select
import shutil
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

PREFIX = "gateway-current-200227."
SIBLING_OLD = b"silverquarry sibling note\n"
SIBLING_NEW = b"goldenquarry sibling note\n"
SAMPLE_SECONDS = 0.1
MAX_SAMPLE_GAP = 1.0
UTILITY_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
HZ = os.sysconf("SC_CLK_TCK")


class ProofError(Exception):
    pass


def require(value, message):
    if not value:
        raise ProofError(message)


def log(phase, **data):
    print(json.dumps({"phase": phase, **data}), flush=True)


def identity(info):
    return [info.st_dev, info.st_ino]


def private_regular(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if not (stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0):
        os.close(fd)
        raise ProofError("fixture control file is not private")
    return fd


def initialize(kind, sibling):
    root = Path(tempfile.mkdtemp(dir="/tmp", prefix=PREFIX))
    for name in ("home", "corpus"):
        (root / name).mkdir(mode=0o700)
    (root / "lock").touch(mode=0o600, exist_ok=False)
    marker = {"version": 1, "root": identity(root.stat()), "kind": kind, "sibling": sibling}
    with (root / "owner.json").open("x") as f:
        json.dump(marker, f)
    print(root)


@contextmanager
def lease(root):
    require(root.parent == Path("/tmp") and root.name.startswith(PREFIX), "invalid fixture location")
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
            "fixture must be a private owned directory")
    with os.fdopen(private_regular(root / "lock", os.O_RDWR), "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ProofError("another run owns this fixture") from None
        with os.fdopen(private_regular(root / "owner.json", os.O_RDONLY)) as f:
            marker = json.load(f)
        require(marker.get("version") == 1 and marker.get("root") == identity(info)
                and marker.get("kind") in ("smoke", "full") and isinstance(marker.get("sibling"), bool),
                "fixture marker mismatch")
        yield marker


def layout(root, kind):
    corpus = root / "corpus"
    n, nd = (3, 1) if kind == "smoke" else (101_963, 7713)
    def directory(i):
        d = i % nd
        return corpus / f"folder-{d % 64:02d}" / f"doc-{d:05d}"
    observed = [corpus, *(corpus / f"folder-{i:02d}" for i in range(min(64, nd))),
                *(directory(i) for i in range(nd))]
    return corpus, n, nd, directory, observed


def create_corpus(root, marker):
    corpus, n, nd, directory, observed = layout(root, marker["kind"])
    require(not any(corpus.iterdir()), "index requires a fresh, empty fixture corpus")
    for d in observed[1:]:
        d.mkdir()
    for i in range(n):
        with (directory(i) / f"page-{i // nd:03d}.md").open("x") as f:
            f.write("initial lindenharbor search marker\n" if i == 0 else f"observation page {i}\n")
    if marker["sibling"]:
        hidden = corpus / ".venv"
        hidden.mkdir()
        with (hidden / "prior.md").open("xb") as f:
            f.write(SIBLING_OLD)
            sibling_id = identity(os.fstat(f.fileno()))
        with (root / "sibling-id.json").open("x") as f:
            json.dump(sibling_id, f)


@contextmanager
def state_for(root, marker, indexing):
    state = root / marker["kind"]
    checkpoint = root / "checkpoint"
    require(not os.path.lexists(state), "fixture state already exists; preserve it for inspection")
    if indexing:
        require(not os.path.lexists(checkpoint), "fixture already has an index checkpoint")
    else:
        require(stat.S_ISDIR(checkpoint.lstat().st_mode), "missing index checkpoint")
    state.mkdir()
    owned = identity(state.stat())
    try:
        if not indexing:
            subprocess.run(["/usr/bin/cp", "-a", "--reflink=auto", str(checkpoint) + "/.", str(state)],
                           check=True, env=UTILITY_ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            db = Path("agents/main/agent/openclaw-agent.sqlite")
            subprocess.run(["/usr/bin/cmp", "-s", checkpoint / db, state / db], check=True, env=UTILITY_ENV)
        yield state
        if indexing:
            state.rename(checkpoint)
    finally:
        if os.path.lexists(state):
            require(identity(state.lstat()) == owned, "state identity changed; leaving it intact")
            shutil.rmtree(state)


def fixture_cli(root, state, repo, corpus, port, token):
    node = shutil.which("node")
    require(node and (repo / "openclaw.mjs").is_file() and (repo / "dist").is_dir(),
            "expected pinned Node and a built OpenClaw checkout")
    work = state / "workspace"
    work.mkdir(exist_ok=True)
    cfg = state / "openclaw.json"
    cfg.write_text(json.dumps({
        "gateway": {"mode": "local", "bind": "loopback", "port": port, "auth": {"mode": "token"},
                    "controlUi": {"enabled": False}, "tailscale": {"mode": "off"}},
        "discovery": {"mdns": {"mode": "off"}}, "cron": {"enabled": False},
        "browser": {"enabled": False}, "update": {"checkOnStart": False},
        "agents": {"entries": {"main": {"workspace": str(work)}}},
        "memory": {"search": {"provider": "none", "fallback": "none", "sources": ["memory"],
                              "extraPaths": [str(corpus)], "store": {"vector": {"enabled": False}}}}
    }))
    env = {"CI": "1", "HOME": str(root / "home"), "PATH": f"{Path(node).parent}:/usr/bin:/bin",
           "OPENCLAW_STATE_DIR": str(state), "OPENCLAW_CONFIG_PATH": str(cfg),
           "OPENCLAW_GATEWAY_TOKEN": token, "OPENCLAW_GATEWAY_PORT": str(port),
           "OPENCLAW_DISABLE_BONJOUR": "1", "NO_COLOR": "1"}
    require(subprocess.check_output([node, "--version"], env=env).strip() == b"v24.22.1",
            "expected Node 24.22.1")
    return [node, str(repo / "openclaw.mjs")], env, work


def cli_call(cli, env, repo, args, timeout):
    result = subprocess.run(cli + args, env=env, cwd=repo, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout)
    require(result.returncode == 0, f"fixture CLI exited {result.returncode}")
    return result.stdout


def scalar(db, sql, params=()):
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=2) as connection:
        return connection.execute(sql, params).fetchone()[0]


def proc_stat(file):
    data = file.read_text()
    fields = data[data.rindex(")") + 2:].split()
    return int(fields[11]) + int(fields[12]), int(fields[19])


class GatewayPID:
    def __init__(self, process, pid):
        self.process, self.pid = process, pid
        self.root = Path("/proc") / str(pid)
        self.start = proc_stat(self.root / "stat")[1]
        self.check()

    def check(self):
        require(self.process.poll() is None and os.getpgid(self.pid) == self.process.pid
                and proc_stat(self.root / "stat")[1] == self.start, "Gateway listener identity changed")

    def sample(self):
        self.check()
        main, _ = proc_stat(self.root / "task" / str(self.pid) / "stat")
        total, _ = proc_stat(self.root / "stat")
        rss = next(int(line.split()[1]) for line in (self.root / "status").read_text().splitlines()
                   if line.startswith("VmRSS:"))
        return (time.monotonic(), main, total, rss)

    def registrations(self):
        count = 0
        for f in (self.root / "fdinfo").iterdir():
            try:
                count += f.read_text().count("inotify wd:")
            except FileNotFoundError:
                pass
        return count


def ready_listener(process, port, opener):
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        require(process.poll() is None, "Gateway exited before readiness")
        sockets = subprocess.check_output(["/usr/bin/ss", "-ltnpH", "sport = :" + str(port)], text=True, env=UTILITY_ENV, stderr=subprocess.DEVNULL)
        pids = set(map(int, re.findall(r"pid=(\d+)", sockets)))
        if pids:
            require(len(pids) == 1, "ambiguous listener on fixture port")
            owner = GatewayPID(process, pids.pop())
            try:
                with opener.open(f"http://127.0.0.1:{port}/readyz", timeout=2) as r:
                    if r.status == 200:
                        owner.check()
                        return owner
            except OSError:
                pass
        time.sleep(0.5)
    raise ProofError("Gateway readiness timeout")


class Sampler:
    def __init__(self, owner):
        self.owner, self.samples, self.failed = owner, [], False
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.collect)

    def collect(self):
        next_tick = time.monotonic()
        try:
            while not self.stop.is_set():
                self.samples.append(self.owner.sample())
                next_tick += SAMPLE_SECONDS
                self.stop.wait(max(0, next_tick - time.monotonic()))
        except Exception:
            self.failed = True

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join()

    def interval(self, name, begin, end, coverage=False):
        inside = [s for s in self.samples if begin[0] < s[0] < end[0]]
        points = [begin, *inside, end]
        gap = max(v[0] - u[0] for u, v in zip(points, points[1:]))
        require(not self.failed and (not coverage or (inside and gap <= MAX_SAMPLE_GAP)),
                "insufficient independent RSS sample coverage for " + name)
        log(name, wallSec=round(end[0]-begin[0], 3), mainCpuMs=round(1000*(end[1]-begin[1])/HZ),
            totalCpuMs=round(1000*(end[2]-begin[2])/HZ), rssKiB=end[3],
            peakRssKiB=max(s[3] for s in points), independentSamples=len(inside), maxGapMs=round(gap*1000, 1))


class ReadObserver:
    def __init__(self, directories):
        self.directories = directories
        self.lock, self.stop = threading.Lock(), threading.Event()
        self.thread = threading.Thread(target=self.collect)
        self.unique, self.accesses, self.overflows = set(), 0, 0
        self.failed = False

    def __enter__(self):
        libc = ctypes.CDLL(None, use_errno=True)
        self.fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        require(self.fd >= 0, "cannot open inotify observer")
        try:
            for directory in self.directories:
                require(directory.resolve(strict=True) == directory, "unexpected symlink in corpus")
                watch = libc.inotify_add_watch(self.fd, os.fsencode(directory), 0x01000001)
                require(watch >= 0, "cannot register all corpus directories with inotify")
            self.thread.start()
        except BaseException:
            os.close(self.fd)
            raise
        return self

    def collect(self):
        try:
            while not self.stop.is_set():
                if not select.select([self.fd], [], [], 0.15)[0]:
                    continue
                data = os.read(self.fd, 1048576)
                pos = 0
                with self.lock:
                    while pos < len(data):
                        watch, mask, _, size = struct.unpack_from("iIII", data, pos)
                        name = data[pos + 16:pos + 16 + size].rstrip(b"\0")
                        pos += 16 + size
                        if mask & 0x4000:
                            self.overflows += 1
                        if mask & 1 and not mask & 0x40000000 and name.endswith(b".md"):
                            self.unique.add((watch, name))
                            self.accesses += 1
        except Exception:
            self.failed = True

    def snapshot(self, reset=False):
        with self.lock:
            require(not self.failed and self.overflows == 0, "inotify observer lost coverage")
            values = dict(distinctMarkdownRead=len(self.unique), accessEvents=self.accesses,
                          queueOverflows=self.overflows)
            if reset:
                self.unique.clear()
                self.accesses = 0
            return values

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join()
        os.close(self.fd)


def quiet(owner, observer, earliest, limit=300):
    previous = owner.sample()
    stable = last = None
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        time.sleep(0.5)
        now = owner.sample()
        seen = observer.snapshot()["accessEvents"]
        busy = (now[2] - previous[2]) / HZ > 0.25 * (now[0] - previous[0])
        if last != seen or now[0] < earliest or busy:
            stable = None
        elif stable is None:
            stable = now[0]
        elif now[0] - stable >= 20:
            return now
        last, previous = seen, now
    raise ProofError("Gateway did not settle within the measurement window")


NAMES = ["newly-created.md", *[f"appended-{i}.md" for i in range(1, 5)]]


@contextmanager
def append_pages(first):
    require(first.resolve(strict=True) == first, "append directory identity mismatch")
    folder = os.open(first, os.O_DIRECTORY | os.O_NOFOLLOW)
    owned = {}
    try:
        for name in NAMES:
            try:
                os.stat(name, dir_fd=folder, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise ProofError("an append filename is already occupied")
        def write(i):
            name = NAMES[i]
            fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600,
                         dir_fd=folder)
            owned[name] = fd
            with os.fdopen(os.dup(fd), "wb") as page:
                page.write(f"new searchable foxglovepier page {i}\n".encode())
        yield write
    finally:
        changed = False
        try:
            for name, handle in owned.items():
                try:
                    info = os.stat(name, dir_fd=folder, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if identity(info) == identity(os.fstat(handle)):
                    os.unlink(name, dir_fd=folder)
                else:
                    changed = True
        finally:
            for handle in owned.values():
                os.close(handle)
            os.close(folder)
        require(not changed, "an append file was replaced; preserved its replacement")


@contextmanager
def sibling_edit(root, enabled):
    if not enabled:
        yield lambda: None
        return
    path = root / "corpus/.venv/prior.md"
    require(path.resolve(strict=True) == path, "sibling path changed")
    with os.fdopen(private_regular(root / "sibling-id.json", os.O_RDONLY)) as f:
        original = json.load(f)
    with os.fdopen(private_regular(path, os.O_RDWR), "r+b", buffering=0) as page:
        info = os.fstat(page.fileno())
        require(identity(info) == original and page.read() == SIBLING_OLD, "sibling checkpoint changed")
        times = (info.st_atime_ns, info.st_mtime_ns)
        edited = False
        def write(content):
            page.seek(0)
            require(page.write(content) == info.st_size, "short sibling write")
            os.utime(page.fileno(), ns=times)
        def edit():
            nonlocal edited
            write(SIBLING_NEW)
            edited = True
            after = os.fstat(page.fileno())
            require(after.st_size == info.st_size and after.st_mtime_ns == info.st_mtime_ns,
                    "sibling edit must preserve size and mtime")
        try:
            yield edit
        finally:
            if edited:
                page.seek(0)
                require(page.read() == SIBLING_NEW, "sibling changed during run; preserving contents")
                write(SIBLING_OLD)


def gateway_search(cli, env, repo, query):
    args = {"query": query, "agentId": "main", "maxResults": 8 if query == "foxglovepier" else 2,
            "minScore": 0}
    output = cli_call(cli, env, repo, ["gateway", "call", "memory.search", "--params", json.dumps(args),
                                      "--json", "--timeout", "600000"], 640)
    return {item["path"] for item in json.loads(output)["results"]
            if query in item.get("snippet", "").lower()}


def resident_search(opener, token, port):
    body = {"tool": "memory_search", "sessionKey": "agent:main:main",
            "args": {"query": "lindenharbor", "minScore": 0, "maxResults": 2}}
    req = urllib.request.Request(f"http://127.0.0.1:{port}/tools/invoke", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with opener.open(req, timeout=600) as response:
        result = json.load(response)
    rendered = json.dumps(result.get("result", {})).lower()
    require(result.get("ok") and "lindenharbor" in rendered and "page-000.md" in rendered,
            "resident tool did not return the indexed seed")
    log("resident-search", hit="page-000.md")


def measure(root, marker, repo, db, cli, env, work, port, token):
    _, _, _, directory, observed = layout(root, marker["kind"])
    first = directory(0)
    expected = [os.path.relpath(first / name, work) for name in NAMES]
    seed = os.path.relpath(first / "page-000.md", work)
    sibling = os.path.relpath(root / "corpus/.venv/prior.md", work)
    def added_count():
        return scalar(db, "select count(distinct path) from memory_index_chunks where source='memory' "
                          "and path in (?,?,?,?,?) and text like ?", (*expected, "%foxglovepier%"))
    small = marker["kind"] == "smoke"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with append_pages(first) as append, sibling_edit(root, marker["sibling"]) as edit:
        proc = subprocess.Popen(cli + ["gateway", "run", "--allow-unconfigured", "--bind", "loopback",
                                "--port", str(port)], env=env, cwd=repo, start_new_session=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            owner = ready_listener(proc, port, opener)
            with Sampler(owner) as sampler:
                require(seed in gateway_search(cli, env, repo, "lindenharbor"), "seed RPC missed")
                log("search-existing", hit="page-000.md", listenerPid=owner.pid, group=proc.pid,
                    startTicks=owner.start, samplePeriodMs=100)
                t = time.monotonic()
                with ReadObserver(observed) as reads:
                    time.sleep(max(0, t + (0 if small else 75) - time.monotonic()))
                    resident_search(opener, token, port)
                    reads.snapshot(reset=True)
                    start = owner.sample()
                    settled = quiet(owner, reads, t + (0 if small else 120))
                    sampler.interval("warmup-through-quiet", start, settled, coverage=True)
                    watches = owner.registrations()
                    require(watches >= len(observed), "Gateway did not register the expected corpus watches")
                    log("settled-start", registrations=watches, observedDirectories=len(observed),
                        **reads.snapshot(reset=True))
                    start = owner.sample()
                    edit()
                    for i in range(5):
                        append(i)
                        time.sleep(6)
                    sampler.interval("five-new-pages", start, owner.sample(), coverage=True)
                    deadline = time.monotonic() + 360
                    while added_count() != 5 and time.monotonic() < deadline:
                        time.sleep(0.5)
                    require(added_count() == 5, "five appended files were not published before RPC")
                    if marker["sibling"]:
                        require(scalar(db, "select exists(select 1 from memory_index_chunks where source='memory' "
                                           "and path=? and text like ?)", (sibling, "%goldenquarry%")),
                                "same-size sibling edit was not indexed before RPC")
                    sampler.interval("five-pages-published", start, owner.sample(), coverage=True)
                    log("before-next-search", indexed=5, **reads.snapshot())
                    rpc = owner.sample()
                    hits = gateway_search(cli, env, repo, "foxglovepier")
                    end = owner.sample()
                    require(hits == set(expected), "appended search returned the wrong paths")
                    sampler.interval("search-rpc", rpc, end, coverage=True)
                    sampler.interval("through-successful-search", start, end, coverage=True)
                    log("search-new", hits=sorted(Path(hit).name for hit in hits))
                    if marker["sibling"]:
                        require(sibling in gateway_search(cli, env, repo, "goldenquarry"), "sibling RPC missed")
                        log("search-sibling", hit=".venv/prior.md", preservedMtime=True)
                    settled = quiet(owner, reads, time.monotonic())
                    sampler.interval("writes-through-settled-search", start, settled, coverage=True)
                    log("settled-output", indexed=added_count(), **reads.snapshot())
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("kind", choices=["smoke", "full"])
    init.add_argument("--sibling", action="store_true")
    for name in ("index", "run"):
        sub = commands.add_parser(name)
        sub.add_argument("fixture", type=Path)
        sub.add_argument("checkout", type=Path)
    args = parser.parse_args()
    if args.command == "init":
        initialize(args.kind, args.sibling)
        return
    root, repo = args.fixture.absolute(), args.checkout.resolve(strict=True)
    indexing = args.command == "index"
    with lease(root) as marker, state_for(root, marker, indexing) as state:
        corpus, count, _, _, _ = layout(root, marker["kind"])
        if indexing:
            create_corpus(root, marker)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        token = secrets.token_hex(32)
        cli, env, work = fixture_cli(root, state, repo, corpus, port, token)
        db = state / "agents/main/agent/openclaw-agent.sqlite"
        if indexing:
            cli_call(cli, env, repo, ["memory", "index", "--agent", "main", "--force"], 3600)
        rows = scalar(db, "select count(*) from memory_index_sources where source='memory'")
        require(rows == count + int(marker["sibling"]), "indexed fixture row count mismatch")
        log("initial-index" if indexing else "reuse-verified-index", sources=rows)
        if not indexing:
            measure(root, marker, repo, db, cli, env, work, port, token)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        detail = str(error) if isinstance(error, ProofError) else type(error).__name__
        log("failed", error=detail)
        sys.exit(1)
