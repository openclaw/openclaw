#!/usr/bin/env python3
"""Q-owned Docker boundary. C receives only its private volume, never host paths.

Requires the local rootful Docker Engine (iptables backend) on Ubuntu 24.04.
The image, command, network policy and resource lifetime are qualification-owned.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import threading
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

IMAGE = "node:24.22.1-trixie@sha256:e8bc2eedd0e82fb45a4d9a68aff03d1fbe478fc5794a67d7dc06b72a2caaa2ec"
LABEL = "org.openclaw.native-candidate"
DOCKER = shutil.which("docker") or "/usr/bin/docker"
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C.UTF-8"}
# Special-purpose IPv4: includes metadata, CGNAT, multicast and documentation.
SPECIAL = ("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
           "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
           "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
           "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4")
# Docker DNAT presents a bridge peer to the Gateway. Keep the published port
# outside the Gateway socket so local Q backend calls retain loopback identity.
# The private Docker bridge is the container's only non-loopback interface.
# This relay has one fixed destination and shares C's existing private boundary.
RUNTIME_INGRESS = r"""
const net = require("node:net");
const os = require("node:os");
const port = Number(process.argv[1]);
if (!port) {
  setInterval(() => {}, 2147483647);
} else {
  const address = Object.values(os.networkInterfaces()).flat()
    .find(item => item.family === "IPv4" && !item.internal).address;
  net.createServer(client => {
    const upstream = net.connect(port, "127.0.0.1");
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  }).listen(port, address);
}
"""
FLAGS = ("VITEST", "OPENCLAW_TEST_MINIMAL_GATEWAY", "OPENCLAW_SKIP_CHANNELS",
         "OPENCLAW_SKIP_PROVIDERS", "OPENCLAW_SKIP_GMAIL_WATCHER", "OPENCLAW_SKIP_CRON",
         "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "OPENCLAW_SKIP_CANVAS_HOST",
         "OPENCLAW_DEBUG_MODEL_TRANSPORT")


def command(*args, input=None, check=True):
    result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=ENV, check=False)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): " +
                           result.stderr.decode("utf-8", "replace"))
    return result


def docker(*args, **kwargs):
    return command(DOCKER, "--host=unix:///var/run/docker.sock", *args, **kwargs)


def iptables(*args, check=True):
    prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
    return command(*prefix, "iptables", "--wait", "10", *args, check=check)


def inspect(kind, name):
    result = docker(kind, "inspect", name, check=False)
    if result.returncode:
        docker("info", "--format", "{{.OSType}}")
        if b"no such" not in result.stderr.lower() and b"not found" not in result.stderr.lower():
            raise RuntimeError(result.stderr.decode("utf-8", "replace"))
        return None
    return json.loads(result.stdout)[0]


def root_path(value):
    path = Path(value).absolute()
    return path.parent.resolve() / path.name


def check_root(root):
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("metadata root must be a private Q-owned directory")


def metadata(root):
    check_root(root)
    fd = os.open(root / "boundary.json", os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("boundary metadata must be private and Q-owned")
        data = json.load(stream)
    if data.get("version") != 1 or not re.fullmatch(r"[0-9a-f]{24}", data.get("owner", "")):
        raise ValueError("invalid Docker boundary metadata")
    return data


def names(data):
    owner = data["owner"]
    return "ocnc-" + owner, "ocn" + owner[:10], "OCNI_" + owner[:16], "OCNF_" + owner[:16]


def remove_container(name, owner):
    info = inspect("container", name)
    if info is None:
        return
    if info["Config"].get("Labels", {}).get(LABEL) != owner:
        raise RuntimeError("refusing to remove a container not owned by this boundary")
    docker("container", "rm", "--force", name)
    if inspect("container", name) is not None:
        raise RuntimeError("candidate container survived removal")


def firewall(data, build=False):
    _, bridge, incoming, forwarded = names(data)
    # Replaced only after build container removal: its established connections
    # and install-time daemons cannot survive into runtime.
    for chain in (incoming, forwarded):
        if iptables("-S", chain, check=False).returncode:
            iptables("-N", chain)
        iptables("-F", chain)
    iptables("-A", incoming, "-i", bridge, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
    iptables("-A", incoming, "-i", bridge, "-j", "DROP")
    iptables("-A", incoming, "-j", "RETURN")
    iptables("-A", forwarded, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
    if build:
        iptables("-A", forwarded, "-i", bridge, "-m", "addrtype", "--dst-type", "LOCAL", "-j", "DROP")
        for block in SPECIAL:
            iptables("-A", forwarded, "-i", bridge, "-d", block, "-j", "DROP")
        # Only default-route uplinks, never other bridges. DNS is public/pinned.
        uplinks = {route["dev"] for route in json.loads(command("ip", "-j", "-4", "route", "show", "default").stdout)}
        bridges = {link["ifname"] for link in json.loads(command("ip", "-j", "link", "show", "type", "bridge").stdout)}
        for uplink in sorted(uplinks - bridges):
            iptables("-A", forwarded, "-i", bridge, "-o", uplink, "-p", "tcp", "--dport", "443", "-j", "ACCEPT")
            for protocol in ("udp", "tcp"):
                iptables("-A", forwarded, "-i", bridge, "-o", uplink, "-d", "1.1.1.1", "-p", protocol, "--dport", "53", "-j", "ACCEPT")
    iptables("-A", forwarded, "-j", "DROP")
    for parent, rule in (("INPUT", ["-i", bridge, "-j", incoming]),
                         ("INPUT", ["-d", data["gateway"], "-j", incoming]),
                         ("DOCKER-USER", ["-i", bridge, "-j", forwarded]),
                         ("DOCKER-USER", ["-o", bridge, "-j", forwarded])):
        if iptables("-C", parent, *rule, check=False).returncode:
            iptables("-I", parent, "1", *rule)


def create_container(data, name, argv, env, port=None, build=False):
    resource, _, _, _ = names(data)
    args = ["create", "--name", name, "--label", LABEL + "=" + data["owner"],
            "--user", "1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--read-only", "--pids-limit=1024", "--init", "--stop-timeout=3",
            "--mount", f"type=volume,src={resource},dst=/candidate",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
            "--workdir", "/candidate/source", "--network", resource,
            "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
            "--sysctl", "net.ipv6.conf.default.disable_ipv6=1",
            "--dns", "1.1.1.1" if build else "127.0.0.1"]
    if port is not None:
        args += ["--publish", f"127.0.0.1:{port}:{port}/tcp"]
    for key, value in env.items():
        args += ["--env", key + "=" + value]
    docker(*args, IMAGE, *argv)


def environment(home):
    return {"HOME": home, "TMPDIR": "/tmp", "CI": "1", "NODE_DISABLE_COMPILE_CACHE": "1",
            "npm_config_cache": home + "/npm-cache", "npm_config_userconfig": home + "/npmrc",
            "npm_config_registry": "https://registry.npmjs.org/", "OPENCLAW_NO_RESPAWN": "1"}


def stream(*args, timeout=None, build=False):
    proc = subprocess.Popen([DOCKER, "--host=unix:///var/run/docker.sock", *args], env=ENV,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT if build else subprocess.PIPE)
    try:
        deadline = time.monotonic() + timeout if timeout else None
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ, sys.stdout.buffer)
            if proc.stderr is not None:
                selector.register(proc.stderr, selectors.EVENT_READ, sys.stderr.buffer)
            while selector.get_map():
                if deadline and time.monotonic() >= deadline:
                    raise TimeoutError("candidate command timed out")
                for key, _ in selector.select(1):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fd)
                    else:
                        if build:
                            # Build bytes are forwarded to Actions; escape its command syntax.
                            print("[candidate] " + json.dumps(chunk.decode("utf-8", "replace")), flush=True)
                        else:
                            # Runtime is captured by Q, including CLI JSON consumers.
                            key.data.write(chunk)
                            key.data.flush()
        return proc.wait()
    finally:
        if proc.poll() is None:
            # Attached Docker clients can proxy TERM to C and then wait forever
            # if C ignores it. Kill the client; the owner then removes C itself.
            proc.kill()
        proc.wait()


def stage_source(args, root, container):
    archive = root / "source.tar"
    try:
        with archive.open("xb") as output:
            result = subprocess.run(["git", "-C", args.source_dir, "archive", "--format=tar", args.target_sha],
                                    stdout=output, stderr=subprocess.PIPE, env=ENV)
            if result.returncode:
                raise RuntimeError("git archive failed: " + result.stderr.decode("utf-8", "replace"))
        # Never extract C paths on the host. Docker extracts this archive into
        # its private volume; even C symlinks cannot point into the host.
        staged = root / "staged.tar"
        try:
            with tarfile.open(archive) as source, tarfile.open(staged, "w") as target:
                for directory in ("source", "homes", "build-home"):
                    entry = tarfile.TarInfo(directory)
                    entry.type, entry.mode, entry.uid, entry.gid = tarfile.DIRTYPE, 0o700, 1000, 1000
                    target.addfile(entry)
                for entry in source:
                    if entry.name.startswith("/") or ".." in Path(entry.name).parts:
                        raise ValueError("unsafe git archive path")
                    if not (entry.isfile() or entry.isdir() or entry.issym()):
                        raise ValueError("unsupported git archive entry")
                    content = source.extractfile(entry) if entry.isfile() else None
                    entry.name = "source/" + entry.name
                    entry.uid, entry.gid, entry.uname, entry.gname = 1000, 1000, "", ""
                    target.addfile(entry, content)
            with staged.open("rb") as source:
                proc = subprocess.run([DOCKER, "--host=unix:///var/run/docker.sock", "cp", "--archive", "-", container + ":/candidate"],
                                      stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV)
                if proc.returncode:
                    raise RuntimeError("candidate staging failed: " + proc.stderr.decode("utf-8", "replace"))
        finally:
            staged.unlink(missing_ok=True)
    finally:
        archive.unlink(missing_ok=True)


def build(args):
    if not re.fullmatch(r"[0-9a-f]{40}", args.target_sha):
        raise ValueError("target SHA must be an exact lowercase commit")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.pnpm_version):
        raise ValueError("pnpm version must be pinned")
    root = root_path(args.root)
    root.mkdir(mode=0o700, exist_ok=True)
    check_root(root)
    if any(root.iterdir()):
        raise ValueError("build requires a fresh empty metadata root")
    info = json.loads(docker("info", "--format", "{{json .}}").stdout)
    if info["OSType"] != "linux" or any("rootless" in option for option in info.get("SecurityOptions", [])):
        raise RuntimeError("requires a local rootful Linux Docker Engine")
    iptables("-S", "DOCKER-USER")
    data = {"version": 1, "owner": uuid.uuid4().hex[:24], "targetSha": args.target_sha}
    resource, bridge, _, _ = names(data)
    # Q resource manifest, written before creating resources for failed-build cleanup.
    fd = os.open(root / "boundary.json", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(data, output)
    docker("pull", IMAGE)
    docker("volume", "create", "--label", LABEL + "=" + data["owner"], resource)
    docker("network", "create", "--driver", "bridge", "--ipv6=false", "--label", LABEL + "=" + data["owner"],
           "--opt", "com.docker.network.bridge.name=" + bridge,
           "--opt", "com.docker.network.bridge.enable_icc=false", resource)
    network = inspect("network", resource)
    data["gateway"] = network["IPAM"]["Config"][0]["Gateway"]
    with (root / "boundary.json").open("w") as output:
        json.dump(data, output)
    firewall(data, build=True)
    container = resource + "-build"
    env = environment("/candidate/build-home")
    env["GIT_COMMIT"] = args.target_sha
    pnpm = f"npm exec --yes --package=pnpm@{args.pnpm_version} -- pnpm"
    create_container(data, container, ["/bin/sh", "-c", pnpm + " install --frozen-lockfile && " + pnpm + " run build:runtime"], env, build=True)
    try:
        stage_source(args, root, container)
        code = stream("start", "--attach", container, timeout=1200, build=True)
    finally:
        remove_container(container, data["owner"])
    firewall(data, build=False)
    return code


class Relay:
    """TCP forwarding with a fixed Q-selected loopback destination."""
    def __init__(self, gateway, target):
        self.target = target
        self.listener = socket.socket()
        self.listener.bind((gateway, 0))
        self.listener.settimeout(0.2)
        self.port = self.listener.getsockname()[1]
        self.stopped = threading.Event()
        # C can open sockets cheaply; do not create unbounded host threads.
        self.slots = threading.BoundedSemaphore(64)
        self.thread = threading.Thread(target=self.accept, daemon=True)

    def start(self):
        # The listener becomes reachable only after its INPUT rules exist.
        self.listener.listen(32)
        self.thread.start()

    def accept(self):
        while not self.stopped.is_set():
            try:
                connection, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if self.slots.acquire(blocking=False):
                threading.Thread(target=self.forward, args=(connection,), daemon=True).start()
            else:
                connection.close()

    def forward(self, connection):
        try:
            with connection, socket.create_connection(self.target, timeout=10) as upstream:
                with selectors.DefaultSelector() as selector:
                    selector.register(connection, selectors.EVENT_READ, upstream)
                    selector.register(upstream, selectors.EVENT_READ, connection)
                    while not self.stopped.is_set():
                        for key, _ in selector.select(0.2):
                            chunk = key.fileobj.recv(65536)
                            if not chunk:
                                return
                            key.data.sendall(chunk)
        except OSError:
            connection.close()
        finally:
            self.slots.release()

    def close(self):
        self.stopped.set()
        self.listener.close()
        if self.thread.ident is not None:
            self.thread.join()


def relay_rule(data, port, install):
    _, bridge, incoming, _ = names(data)
    allowed = ["-i", bridge, "-p", "tcp", "--dport", str(port), "-j", "ACCEPT"]
    denied = ["-p", "tcp", "--dport", str(port), "-j", "DROP"]
    # The gateway-address INPUT jump also denies other bridges access to Q relays.
    for rule in (denied, allowed) if install else (allowed, denied):
        iptables("-I" if install else "-D", incoming, *(["1"] if install else []), *rule)


WRITE_CONFIG = """
const fs = require('fs');
const config = fs.readFileSync(0, 'utf8');
const home = process.argv[1];
fs.mkdirSync(home + '/state', {recursive:true});
fs.writeFileSync(home + '/state/.config-new', config, {mode:0o600});
fs.renameSync(home + '/state/.config-new', home + '/state/openclaw.json');
"""


def runtime(args):
    root = root_path(args.root)
    data = metadata(root)
    resource, _, _, _ = names(data)
    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text())
    key = hashlib.sha256(str(config_path).encode()).hexdigest()
    home = "/candidate/homes/" + key
    container = resource + "-" + key[:16]
    cli = args.cli[1:] if args.cli[:1] == ["--"] else args.cli
    port = config.get("gateway", {}).get("port")
    for index, value in enumerate(cli):
        if value == "--port":
            if index + 1 == len(cli):
                raise ValueError("--port requires a value")
            port = int(cli[index + 1])
        elif value.startswith("--port="):
            port = int(value.split("=", 1)[1])
    if port is not None and (type(port) is not int or not 1 <= port <= 65535):
        raise ValueError("invalid synthetic Gateway port")
    env = environment(home)
    env.update({"OPENCLAW_HOME": home, "OPENCLAW_STATE_DIR": home + "/state",
                "OPENCLAW_CONFIG_PATH": home + "/state/openclaw.json"})
    env.update({key: os.environ[key] for key in FLAGS if key in os.environ})
    if "OPENAI_API_KEY" in os.environ:
        if not os.environ["OPENAI_API_KEY"].endswith("synthetic-key"):
            raise ValueError("runtime requires a synthetic provider credential")
        env["OPENAI_API_KEY"] = os.environ["OPENAI_API_KEY"]
    relays = []
    owner = False
    try:
        # CLI calls share the active Gateway's network namespace and loopback.
        # A short startup lock is Q-only; no lock is held while C runs.
        with (root / "runtime.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            existing = inspect("container", container)
            if existing and existing["Config"].get("Labels", {}).get(LABEL) != data["owner"]:
                raise RuntimeError("runtime container ownership mismatch")
            if existing and not existing["State"]["Running"]:
                raise RuntimeError("stale candidate runtime; cleanup is required")
            if not existing:
                for provider in config.get("models", {}).get("providers", {}).values():
                    endpoint = urlsplit(provider["baseUrl"])
                    if (endpoint.scheme != "http" or endpoint.hostname not in ("localhost", "127.0.0.1", "::1")
                            or endpoint.username or endpoint.password):
                        raise ValueError("synthetic providers must use loopback HTTP")
                    relay = Relay(data["gateway"], (endpoint.hostname, endpoint.port or 80))
                    relays.append(relay)
                    relay_rule(data, relay.port, True)
                    relay.start()
                    provider["baseUrl"] = urlunsplit((endpoint.scheme, f"{data['gateway']}:{relay.port}", endpoint.path, endpoint.query, endpoint.fragment))
                config.setdefault("gateway", {})["bind"] = "loopback"
                create_container(data, container, ["node", "-e", RUNTIME_INGRESS, str(port or 0)], env, port)
                owner = True
                docker("start", container)
                docker("exec", "-i", container, "node", "-e", WRITE_CONFIG, home,
                       input=json.dumps(config).encode())
        # Only the fixed ingress relay binds eth0; Gateway/CLI share loopback.
        cli = list(cli)
        for index, value in enumerate(cli):
            if value == "--bind" and index + 1 < len(cli):
                cli[index + 1] = "loopback"
            elif value.startswith("--bind="):
                cli[index] = "--bind=loopback"
        exec_args = ["exec"]
        for key, value in env.items():
            exec_args += ["--env", key + "=" + value]
        return stream(*exec_args, container, "node", "/candidate/source/openclaw.mjs", *cli)
    finally:
        if owner:
            remove_container(container, data["owner"])
        for relay in relays:
            relay.close()
            relay_rule(data, relay.port, False)


def cleanup(args):
    root = root_path(args.root)
    if not root.exists() and not root.is_symlink():
        return 0
    check_root(root)
    if not (root / "boundary.json").exists() and not any(root.iterdir()):
        root.rmdir()
        return 0
    data = metadata(root)
    # Fail visibly if privilege/iptables access was lost; an unchecked -C error
    # must never be mistaken for an already-removed rule.
    iptables("-S", "INPUT")
    resource, bridge, incoming, forwarded = names(data)
    containers = docker("ps", "--all", "--quiet", "--filter", "label=" + LABEL + "=" + data["owner"]).stdout.decode().split()
    for container in containers:
        remove_container(container, data["owner"])
    for kind in ("network", "volume"):
        info = inspect(kind, resource)
        if info is not None:
            if info.get("Labels", {}).get(LABEL) != data["owner"]:
                raise RuntimeError("refusing to remove an unrelated " + kind)
            docker(kind, "rm", resource)
            if inspect(kind, resource) is not None:
                raise RuntimeError("candidate " + kind + " survived removal")
    for parent, rule in (("INPUT", ["-i", bridge, "-j", incoming]),
                         ("INPUT", ["-d", data.get("gateway", "0.0.0.0"), "-j", incoming]),
                         ("DOCKER-USER", ["-i", bridge, "-j", forwarded]),
                         ("DOCKER-USER", ["-o", bridge, "-j", forwarded])):
        if not iptables("-C", parent, *rule, check=False).returncode:
            iptables("-D", parent, *rule)
    for chain in (incoming, forwarded):
        if not iptables("-S", chain, check=False).returncode:
            iptables("-F", chain)
            iptables("-X", chain)
            if not iptables("-S", chain, check=False).returncode:
                raise RuntimeError("candidate firewall chain survived removal")
    # No C content lives here. Remove only known Q-owned artifacts.
    for name in ("source.tar", "staged.tar", "runtime.lock", "boundary.json"):
        (root / name).unlink(missing_ok=True)
    root.rmdir()
    return 0


def main():
    if sys.platform != "linux":
        raise RuntimeError("Linux candidate boundary requires Linux")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    for name in ("source-dir", "target-sha", "root", "node", "npm-dir", "pnpm-version"):
        build_parser.add_argument("--" + name, required=True)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("--root", required=True)
    run_parser.add_argument("--config", required=True)
    run_parser.add_argument("cli", nargs=argparse.REMAINDER)
    cleanup_parser = commands.add_parser("cleanup")
    cleanup_parser.add_argument("--root", required=True)
    args = parser.parse_args()
    def interrupted(number, _frame):
        raise InterruptedError("candidate launcher interrupted by signal " + str(number))
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupted)
    return {"build": build, "run": runtime, "cleanup": cleanup}[args.command](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("native candidate boundary: " + json.dumps(str(error)), file=sys.stderr)
        sys.exit(1)
