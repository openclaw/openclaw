#!/usr/bin/env python3
"""Run untrusted source under a private UID and default-deny Seatbelt.

This launcher and its caller are qualification-owned (Q). Only candidate/ is
candidate-writable (C). Even npm/pnpm lifecycle scripts run inside the boundary.
"""
import argparse
import ctypes
import grp
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import selectors
import shlex
import signal
import socket
import shutil
import stat
import subprocess
import sys
import tarfile
import threading
import time
from urllib.parse import urlsplit

BUILD_TIMEOUT = 1800
PYTHON = str(Path(sys.executable).resolve())
HELPER = str(Path(__file__).resolve())
SYSTEM_ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"}


def sudo(*args, **kwargs):
    return subprocess.run(["/usr/bin/sudo", "-n", *args], env=SYSTEM_ENV,
                          check=True, **kwargs)


def root_path(value):
    # Resolve only the parent, not a candidate-replaced final component.
    path = Path(value).absolute()
    return path.parent.resolve() / path.name


def check_root(root):
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError("install root must be Q-owned and not writable by others")


def metadata(root):
    check_root(root)
    fd = os.open(root / "boundary.json", os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("boundary metadata must be private and Q-owned")
        data = json.load(stream)
    if data.get("version") != 1 or not 55000 <= data.get("uid", 0) < 60000:
        raise ValueError("invalid boundary metadata")
    return data


def reserve_uid():
    occupied = {entry.pw_uid for entry in pwd.getpwall()}
    occupied.update(entry.gr_gid for entry in grp.getgrall())
    occupied.update(int(uid) for uid in subprocess.check_output(
        ["/bin/ps", "-axo", "uid="], text=True, env=SYSTEM_ENV).split())
    for uid in range(55000, 60000):
        if uid in occupied:
            continue
        lease = Path(f"/private/tmp/openclaw-native-candidate-uid-{uid}")
        try:
            lease.mkdir(mode=0o700)
            return uid
        except FileExistsError:
            continue
    raise RuntimeError("no unused candidate UID available")


def kill_uid(uid):
    result = subprocess.run(["/usr/bin/sudo", "-n", "/usr/bin/pkill", "-KILL", "-U", str(uid)],
                            env=SYSTEM_ENV)
    if result.returncode not in (0, 1):
        raise RuntimeError("could not stop candidate UID processes")
    for _ in range(100):
        active = subprocess.check_output(["/bin/ps", "-axo", "uid="], text=True, env=SYSTEM_ENV)
        if str(uid) not in active.split():
            return
        time.sleep(0.05)
    raise RuntimeError("candidate processes did not exit; retaining root and UID reservation")


# Keep Python 3.9's older special-address table conservative, including IPv6
# transition mechanisms that can conceal an IPv4 destination.
NONPUBLIC_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "192.0.0.0/24", "192.88.99.0/24", "2001::/23", "2002::/16", "3fff::/20",
))


def public_address(value, host_addresses):
    address = ipaddress.ip_address(value)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    if (address in host_addresses or not address.is_global or address.is_private
            or address.is_loopback or address.is_link_local or address.is_multicast
            or address.is_reserved or address.is_unspecified
            or (address.version == 6 and address not in ipaddress.ip_network("2000::/3"))
            or any(address in network for network in NONPUBLIC_NETWORKS)):
        raise ValueError("dependency destination is not public")
    return address


def host_interface_addresses():
    output = subprocess.check_output(["/sbin/ifconfig", "-a"], env=SYSTEM_ENV,
                                     text=True, timeout=5)
    addresses = set()
    for value in re.findall(r"^\s*inet6?\s+(\S+)", output, re.MULTILINE):
        address = ipaddress.ip_address(value.split("%", 1)[0])
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        addresses.add(address)
    if not addresses:
        raise RuntimeError("could not enumerate host interface addresses")
    # Qualification does not change host network interfaces during a build.
    return addresses


class DependencyProxy:
    """Q-owned CONNECT-only relay; no candidate files, credentials, or request logs."""

    def __enter__(self):
        self.host_addresses = host_interface_addresses()
        self.stopping = threading.Event()
        self.slots = threading.BoundedSemaphore(64)
        self.lock = threading.Lock()
        self.workers = {}
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(64)
        self.listener.settimeout(0.2)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self.serve)
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.stopping.set()
        self.listener.close()
        self.thread.join()
        with self.lock:
            workers = list(self.workers.items())
        for client, _thread in workers:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for _client, thread in workers:
            thread.join()

    def serve(self):
        while not self.stopping.is_set():
            # Backpressure concurrent package fetches rather than resetting them.
            if not self.slots.acquire(timeout=0.2):
                continue
            try:
                client, _peer = self.listener.accept()
            except socket.timeout:
                self.slots.release()
                continue
            except OSError:
                self.slots.release()
                return
            thread = threading.Thread(target=self.handle, args=(client,))
            with self.lock:
                self.workers[client] = thread
            thread.start()

    def resolve(self, host):
        try:
            addresses = [str(ipaddress.ip_address(host))]
        except ValueError:
            # getaddrinfo has no timeout. A bounded Q subprocess avoids orphan
            # DNS threads and returns only numeric addresses, never C code.
            script = ("import json,socket,sys; "
                      "addresses=list(dict.fromkeys(x[4][0] for x in "
                      "socket.getaddrinfo(sys.argv[1],443,type=socket.SOCK_STREAM))); "
                      "assert 0 < len(addresses) <= 64; print(json.dumps(addresses))")
            output = subprocess.check_output([PYTHON, "-I", "-c", script, host],
                                             env=SYSTEM_ENV, stderr=subprocess.DEVNULL,
                                             text=True, timeout=5)
            addresses = json.loads(output)
        if not addresses:
            raise ValueError("dependency destination has no addresses")
        # Reject mixed public/private answers as well as direct numeric targets.
        return [public_address(value, self.host_addresses) for value in addresses]

    def handle(self, client):
        upstream = None
        connected = False
        try:
            header = bytearray()
            deadline = time.monotonic() + 5
            while b"\r\n\r\n" not in header:
                client.settimeout(max(0.001, deadline - time.monotonic()))
                chunk = client.recv(8192 - len(header))
                if not chunk or time.monotonic() >= deadline:
                    raise ValueError("incomplete proxy header")
                header.extend(chunk)
                if len(header) >= 8192:
                    raise ValueError("proxy header too large")
            head, pending = bytes(header).split(b"\r\n\r\n", 1)
            request = head.split(b"\r\n", 1)[0].decode("ascii")
            match = re.fullmatch(r"CONNECT (?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]{1,253})):443 HTTP/1\.[01]",
                                 request)
            if match is None:
                raise ValueError("only CONNECT to port 443 is permitted")
            addresses = self.resolve(match.group(1) or match.group(2))
            deadline = time.monotonic() + 5
            for address in addresses:
                if self.stopping.is_set() or time.monotonic() >= deadline:
                    raise TimeoutError("dependency connection expired")
                upstream = socket.socket(socket.AF_INET if address.version == 4 else socket.AF_INET6,
                                         socket.SOCK_STREAM)
                upstream.settimeout(max(0.001, deadline - time.monotonic()))
                try:
                    # Numeric address only: never resolve again after validation.
                    upstream.connect((str(address), 443))
                    break
                except OSError:
                    upstream.close()
                    upstream = None
            if upstream is None or self.stopping.is_set():
                raise OSError("dependency connection failed")
            client.settimeout(5)
            upstream.settimeout(5)
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            connected = True
            if pending:
                upstream.sendall(pending)
            deadline = time.monotonic() + 300
            idle_deadline = time.monotonic() + 30
            with selectors.DefaultSelector() as selector:
                selector.register(client, selectors.EVENT_READ, upstream)
                selector.register(upstream, selectors.EVENT_READ, client)
                while not self.stopping.is_set():
                    remaining = min(deadline, idle_deadline) - time.monotonic()
                    if remaining <= 0:
                        return
                    for key, _events in selector.select(min(0.2, remaining)):
                        data = key.fileobj.recv(65536)
                        if not data:
                            return
                        key.data.sendall(data)
                        idle_deadline = time.monotonic() + 30
        except (OSError, ValueError, subprocess.SubprocessError):
            if not connected:
                try:
                    client.settimeout(1)
                    client.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                except OSError:
                    pass
        finally:
            if upstream is not None:
                upstream.close()
            client.close()
            with self.lock:
                del self.workers[client]
            self.slots.release()


def profile(candidate, build=False, ports=(), gateway_port=None, proxy_port=None):
    quoted = json.dumps(str(candidate))
    rules = ['''(version 1)
(deny default)
(allow process-exec process-fork)
(deny process-exec (literal "/usr/bin/sudo"))
(allow signal process-info* (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-read* file-map-executable
  (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share")
  (subpath "/usr/bin") (subpath "/bin") (subpath "/Library/Developer")
  (subpath "/Applications/Xcode.app") (subpath "/Library/Apple")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
  (literal "/private/etc/passwd") (literal "/private/etc/localtime")
  (literal "/private/var/select/sh"))
; The system loader reads the directory itself, not its descendants.
(allow file-read-data (literal "/"))
(allow file-read-metadata (literal "/") (literal "/private")
  (literal "/private/tmp") (literal "/dev"))
(allow file-write-data (literal "/dev/null"))
''', f"(allow file-read* file-write* file-map-executable (subpath {quoted}))\n"]
    for parent in candidate.parents:
        rules.append(f"(allow file-read-metadata (literal {json.dumps(str(parent))}))\n")
    if build:
        if proxy_port is None:
            raise ValueError("build requires a dependency proxy")
        # Only TLS trust services; DNS and Internet sockets belong to Q's proxy.
        rules.append('''(allow mach-lookup
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent"))
(allow file-read* (subpath "/System/Library/Keychains"))
''')
        rules.append(f'(allow network-outbound (remote tcp "localhost:{proxy_port}"))\n')
    else:
        for port in sorted(set(ports)):
            rules.append(f'(allow network-outbound (remote tcp "localhost:{port}"))\n')
        if gateway_port is not None:
            rules.append(f'(allow network-bind network-inbound (local tcp "localhost:{gateway_port}"))\n')
    return "".join(rules)


def environment(candidate, home, proxy_port=None):
    # No host npm config, proxy settings, NODE_OPTIONS, tokens, or SSH agents.
    env = {**SYSTEM_ENV, "PATH": f"{candidate}/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(home), "TMPDIR": str(home / "tmp"), "CI": "1",
            # pnpm v12 deliberately ignores TMPDIR for store-operation locks.
            "XDG_RUNTIME_DIR": str(home),
            "npm_config_cache": str(home / "npm-cache"),
            "npm_config_userconfig": str(home / "npmrc"),
            "npm_config_registry": "https://registry.npmjs.org/",
            "NODE_DISABLE_COMPILE_CACHE": "1", "OPENCLAW_NO_RESPAWN": "1",
            "OPENCLAW_SKIP_CHANNELS": "1", "OPENCLAW_SKIP_CRON": "1",
            "OPENCLAW_SKIP_GMAIL_WATCHER": "1"}
    if proxy_port is not None:
        proxy = f"http://127.0.0.1:{proxy_port}"
        # Node global fetch does not honor these URLs without its explicit opt-in.
        env.update({"NODE_USE_ENV_PROXY": "1", "HTTPS_PROXY": proxy, "HTTP_PROXY": proxy,
                    "https_proxy": proxy, "http_proxy": proxy,
                    "npm_config_https_proxy": proxy, "npm_config_proxy": proxy})
    return env


def child(payload):
    if os.geteuid() != 0:
        raise RuntimeError("boundary launcher requires sudo")
    uid = payload["uid"]
    os.setgroups([uid])
    os.setgid(uid)
    os.setuid(uid)
    # Darwin Python getgroups() may use the account-directory extension.
    # Inspect the actual kernel group vector via the unsuffixed libc symbol.
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    libc.getgroups.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
    libc.getgroups.restype = ctypes.c_int
    count = libc.getgroups(0, None)
    groups = (ctypes.c_uint32 * max(count, 0))()
    if (count < 0 or libc.getgroups(count, groups) != count or list(groups) != [uid]
            or os.getuid() != uid or os.geteuid() != uid
            or os.getgid() != uid or os.getegid() != uid):
        raise RuntimeError("candidate credential drop failed")
    os.umask(0o077)
    # Before exec the trusted launcher writes only via no-follow directory FDs.
    # C may have replaced any of these paths during an earlier invocation.
    candidate = Path(payload["cwd"]).parent
    fd = os.open(candidate, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in Path(payload["env"]["HOME"]).relative_to(candidate).parts:
            try:
                os.mkdir(part, mode=0o700, dir_fd=fd)
            except FileExistsError:
                pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        for part in ("tmp", "state"):
            try:
                os.mkdir(part, mode=0o700, dir_fd=fd)
            except FileExistsError:
                pass
        if "config" in payload:
            state_fd = os.open("state", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                temporary = f".config-{os.getpid()}"
                config_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                    0o600, dir_fd=state_fd)
                with os.fdopen(config_fd, "w") as stream:
                    stream.write(payload["config"])
                # Replace, never truncate a C-planted hardlink or symlink.
                os.rename(temporary, "openclaw.json", src_dir_fd=state_fd, dst_dir_fd=state_fd)
            finally:
                os.close(state_fd)
    finally:
        os.close(fd)
    os.chdir(payload["cwd"])
    os.execve("/usr/bin/sandbox-exec",
              ["/usr/bin/sandbox-exec", "-p", payload["profile"], *payload["argv"]],
              payload["env"])


def launch(payload, build=False):
    proc = subprocess.Popen(["/usr/bin/sudo", "-n", PYTHON, "-I", HELPER, "__child"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE if build else None,
                            stderr=subprocess.STDOUT if build else None,
                            env=SYSTEM_ENV, close_fds=True)
    previous = {}
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        previous[sig] = signal.signal(sig, lambda number, _frame: proc.send_signal(number))
    try:
        proc.stdin.write(json.dumps(payload).encode())
        proc.stdin.close()
        if not build:
            return proc.wait()
        deadline = time.monotonic() + BUILD_TIMEOUT
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise TimeoutError("candidate install/build exceeded 1800 seconds")
                for key, _ in selector.select(min(1, max(0, deadline - time.monotonic()))):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fd)
                    else:
                        # Escaping prevents CR/ANSI/newline-prefixed Actions commands.
                        print("[candidate build] " + json.dumps(chunk.decode("utf-8", "replace")), flush=True)
        return proc.wait(timeout=max(0.1, deadline - time.monotonic()))
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if build:
            kill_uid(payload["uid"])
            if proc.poll() is None:
                proc.terminate()
            proc.wait()


def stage_archive(source, sha, root, destination):
    archive = root / "source.tar"
    with archive.open("xb") as stream:
        subprocess.run(["/usr/bin/git", "-C", str(source), "archive", "--format=tar", sha],
                       stdout=stream, env=SYSTEM_ENV, check=True)
    with tarfile.open(archive) as tar:
        links = []
        for entry in tar:
            parts = PurePosixPath(entry.name).parts
            if not parts or entry.name.startswith("/") or ".." in parts or parts[0] == ".git":
                raise ValueError("unsafe git archive path")
            path = destination.joinpath(*parts)
            if entry.issym():
                links.append((path, entry.linkname))
            elif entry.isdir():
                path.mkdir(parents=True, exist_ok=True)
            elif entry.isfile():
                path.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(entry) as source_file, path.open("xb") as output:
                    shutil.copyfileobj(source_file, output)
                path.chmod(entry.mode & 0o777)
            else:
                raise ValueError("unsupported git archive entry")
        # Deferred symlinks keep Q extraction from traversing candidate links.
        for path, target in links:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)
    archive.unlink()


def build(args):
    if not re.fullmatch(r"[0-9a-fA-F]{40}", args.target_sha):
        raise ValueError("target SHA must be 40 hexadecimal characters")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.pnpm_version):
        raise ValueError("pnpm version must be a pinned numeric version")
    root = root_path(args.root)
    root.mkdir(mode=0o755, exist_ok=True)
    check_root(root)
    if any(root.iterdir()):
        raise ValueError("build requires a fresh empty install root")
    root.chmod(0o755)
    uid = reserve_uid()
    data = {"version": 1, "uid": uid, "targetSha": args.target_sha.lower(),
            "pnpmVersion": args.pnpm_version}
    fd = os.open(root / "boundary.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(data, stream)
    candidate = root / "candidate"
    candidate.mkdir(mode=0o700)
    source = candidate / "source"
    source.mkdir()
    stage_archive(Path(args.source_dir).resolve(), data["targetSha"], root, source)
    (candidate / "bin").mkdir()
    shutil.copy2(Path(args.node).resolve(), candidate / "bin" / "node")
    shutil.copytree(Path(args.npm_dir).resolve(), candidate / "npm", symlinks=False)
    # Last Q write beneath candidate/. -P never dereferences source links.
    sudo("/usr/sbin/chown", "-R", "-P", f"{uid}:{uid}", str(candidate))
    home = candidate / "build-home"
    with DependencyProxy() as proxy:
        env = environment(candidate, home, proxy_port=proxy.port)
        # build-identity.mts/write-build-info.ts own GIT_COMMIT (not OPENCLAW_BUILD_COMMIT).
        env["GIT_COMMIT"] = data["targetSha"]
        npm = [str(candidate / "bin" / "node"), str(candidate / "npm/bin/npm-cli.js"),
               "exec", "--yes", f"--package=pnpm@{args.pnpm_version}", "--", "pnpm"]
        command = shlex.join([*npm, "install", "--frozen-lockfile"])
        command += " && " + shlex.join([*npm, "run", "build:runtime"])
        return launch({"uid": uid, "cwd": str(source), "env": env,
                       "profile": profile(candidate, build=True, proxy_port=proxy.port),
                       "argv": ["/bin/sh", "-c", command]}, build=True)


def runtime(args):
    root = root_path(args.root)
    data = metadata(root)
    config_path = Path(args.config).resolve()
    config_text = config_path.read_text()
    config = json.loads(config_text)
    ports = []
    for provider in config.get("models", {}).get("providers", {}).values():
        endpoint = urlsplit(provider["baseUrl"])
        if endpoint.scheme not in ("http", "https") or endpoint.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("synthetic provider endpoints must be loopback HTTP(S)")
        ports.append(endpoint.port or (443 if endpoint.scheme == "https" else 80))
    gateway_port = config.get("gateway", {}).get("port")
    cli = args.cli[1:] if args.cli[:1] == ["--"] else args.cli
    for index, value in enumerate(cli):
        if value == "--port":
            if index + 1 == len(cli):
                raise ValueError("--port requires a value")
            gateway_port = int(cli[index + 1])
        elif value.startswith("--port="):
            gateway_port = int(value.split("=", 1)[1])
    if gateway_port is not None:
        if type(gateway_port) is not int or not 1 <= gateway_port <= 65535:
            raise ValueError("invalid synthetic Gateway port")
        ports.append(gateway_port)
    candidate = root / "candidate"
    home = candidate / "homes" / hashlib.sha256(str(config_path).encode()).hexdigest()
    env = environment(candidate, home)
    env.update({"OPENCLAW_HOME": str(home), "OPENCLAW_STATE_DIR": str(home / "state"),
                "OPENCLAW_CONFIG_PATH": str(home / "state/openclaw.json")})
    for key in ("VITEST", "OPENCLAW_TEST_MINIMAL_GATEWAY", "OPENCLAW_SKIP_CHANNELS",
                "OPENCLAW_SKIP_PROVIDERS", "OPENCLAW_SKIP_GMAIL_WATCHER", "OPENCLAW_SKIP_CRON",
                "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "OPENCLAW_SKIP_CANVAS_HOST",
                "OPENCLAW_DEBUG_MODEL_TRANSPORT"):
        if key in os.environ:
            env[key] = os.environ[key]
    if "OPENAI_API_KEY" in os.environ:
        if not os.environ["OPENAI_API_KEY"].endswith("synthetic-key"):
            raise ValueError("runtime requires a synthetic provider credential")
        env["OPENAI_API_KEY"] = os.environ["OPENAI_API_KEY"]
    return launch({"uid": data["uid"], "cwd": str(candidate / "source"),
                   "env": env, "profile": profile(candidate, ports=ports, gateway_port=gateway_port),
                   "config": config_text,
                   "argv": [str(candidate / "bin/node"), str(candidate / "source/openclaw.mjs"), *cli]})


def cleanup(args):
    root = root_path(args.root)
    try:
        root.lstat()
    except FileNotFoundError:
        return 0
    data = metadata(root)
    kill_uid(data["uid"])
    # BSD rm does not traverse symlinks; root itself was checked with lstat.
    sudo("/bin/rm", "-rf", "--", str(root))
    Path(f"/private/tmp/openclaw-native-candidate-uid-{data['uid']}").rmdir()
    return 0


def main():
    if sys.platform != "darwin":
        raise RuntimeError("native candidate macOS boundary requires Darwin")
    if sys.argv[1:2] == ["__child"]:
        child(json.load(sys.stdin))
        return 0
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
    return {"build": build, "run": runtime, "cleanup": cleanup}[args.command](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"native candidate boundary: {error}", file=sys.stderr)
        sys.exit(1)
