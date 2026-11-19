#!/usr/bin/env python3
"""Disposable-host feasibility proof, not a production isolation implementation."""
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import sys
import tempfile
import threading


def child(uid, profile, root, allowed, denied, parent):
    # Retain only the isolated, nontrusted GID; no runner groups cross the boundary.
    os.setgroups([uid])
    os.setgid(uid)
    os.setuid(uid)
    assert os.getuid() == os.geteuid() == uid
    assert os.getgid() == os.getegid() == uid
    os.chdir(root + "/candidate")
    # Establish the canary after sudo filtering, immediately before the allowlisted exec.
    os.environ["ISOLATION_SECRET_CANARY"] = "must-not-cross"
    code = r'''
import ctypes, json, os, pathlib, socket, subprocess, sys
root, allowed, denied, parent = sys.argv[1:]
# Python uses Darwin's account-directory extension, not the process group vector.
# The unsuffixed libc symbol reads the kernel credentials, including setgroups().
getgroups = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True).getgroups
getgroups.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
getgroups.restype = ctypes.c_int
count = getgroups(0, None)
if count < 0:
    raise OSError(ctypes.get_errno(), "kernel getgroups count failed")
groups = (ctypes.c_uint32 * count)()
if getgroups(count, groups) != count:
    raise OSError(ctypes.get_errno(), "kernel getgroups failed")
result = {"uid": os.getuid(), "groups": list(groups)}
for name in ("qualification", "actions"):
    path = pathlib.Path(root) / name / "canary"
    for action in ("read", "write"):
        try:
            path.read_text() if action == "read" else path.write_text("forged")
            result[name + "_" + action] = "escaped"
        except OSError:
            result[name + "_" + action] = "denied"
try:
    os.kill(int(parent), 0)
    result["parent_signal"] = "escaped"
except OSError:
    result["parent_signal"] = "denied"
for label, port in (("provider", allowed), ("unrelated_local_service", denied)):
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=2) as connection:
            connection.sendall(b"probe")
            result[label] = connection.recv(2).decode()
    except OSError:
        result[label] = "denied"
try:
    result["sudo"] = subprocess.run(["/usr/bin/sudo", "-n", "/usr/bin/true"], capture_output=True).returncode
except PermissionError:
    result["sudo"] = "execution-denied"
path = pathlib.Path(root) / "candidate" / "allowed"
path.write_text("candidate writes stay private")
result["own_write"] = path.read_text()
code = "import json, pathlib, sys\ntry:\n pathlib.Path(sys.argv[1]).write_text('forged')\n print(json.dumps({'write': 'escaped'}))\nexcept PermissionError:\n print(json.dumps({'write': 'denied'}))"
descendant = subprocess.run([sys.executable, "-I", "-c", code, str(pathlib.Path(root) / "qualification" / "canary")], capture_output=True, text=True, check=True)
result["descendant_write"] = json.loads(descendant.stdout)["write"]
result["credential_env"] = os.environ.get("ISOLATION_SECRET_CANARY")
print(json.dumps(result))
'''
    print(json.dumps({'launchPid': os.getpid(), 'python': sys.executable}), file=sys.stderr, flush=True)
    os.execve('/usr/bin/sandbox-exec', ['/usr/bin/sandbox-exec', '-p', profile,
              sys.executable, '-I', '-c', code, root, allowed, denied, parent],
              {'PATH': '/usr/bin:/bin', 'HOME': root + '/candidate',
               'TMPDIR': root + '/candidate', 'LANG': 'en_US.UTF-8'})


def main():
    if sys.platform != 'darwin':
        raise SystemExit('This feasibility probe requires the disposable macOS native runner.')
    if len(sys.argv) > 1:
        child(int(sys.argv[2]), *sys.argv[3:])
        return
    subprocess.run(['sudo', '-n', 'true'], check=True)
    occupied = {entry.pw_uid for entry in pwd.getpwall()}
    uid = next(value for value in range(55000, 60000) if value not in occupied)
    root = Path(tempfile.mkdtemp(prefix='openclaw-isolation-probe-', dir='/private/tmp'))
    os.chmod(root, 0o755)
    sockets = []
    threads = []
    try:
        for name in ('qualification', 'actions', 'candidate'):
            directory = root / name
            directory.mkdir(mode=0o700)
            if name != 'candidate':
                (directory / 'canary').write_text('trusted')
        subprocess.run(['sudo', '-n', 'chown', str(uid) + ':' + str(uid), str(root / 'candidate')], check=True)
        for _ in range(2):
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            listener.settimeout(15)
            sockets.append(listener)
            def serve(sock):
                try:
                    connection, _ = sock.accept()
                    with connection:
                        connection.recv(16)
                        connection.sendall(b'ok')
                except OSError:
                    pass
            thread = threading.Thread(target=serve, args=(listener,), daemon=True)
            thread.start()
            threads.append(thread)
        allowed, denied = (str(sock.getsockname()[1]) for sock in sockets)
        profile = '''(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal process-info* (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-read* file-map-executable
  (subpath "/System") (subpath "/usr") (subpath "/bin")
  (subpath "/Library/Developer") (subpath "/Applications")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
  (literal "/private/etc/passwd") (literal "/private/etc/localtime"))
; The system Python loader reads the root directory itself, not its descendants.
(allow file-read-data (literal "/"))
(allow file-read-metadata (literal "/") (literal "/private") (literal "/private/tmp"))
(allow file-read* file-write* (subpath CANDIDATE))
(allow file-write-data (literal "/dev/null"))
(allow network-outbound (remote tcp "localhost:PORT"))
'''.replace('CANDIDATE', json.dumps(str(root / 'candidate'))).replace('PORT', allowed)
        result = subprocess.run(['sudo', '-n', '/usr/bin/python3', '-I', str(Path(__file__).resolve()),
                                 '--child', str(uid), profile, str(root), allowed, denied, str(os.getpid())],
                                env={**os.environ, 'ISOLATION_SECRET_CANARY': 'must-not-cross'},
                                text=True, capture_output=True, timeout=30, close_fds=True)
        if result.returncode:
            diagnostic = subprocess.run(
                ['/usr/bin/log', 'show', '--last', '1m', '--style', 'compact',
                 '--predicate', 'subsystem == "com.apple.sandbox.reporting"'],
                text=True, capture_output=True, timeout=15)
            # Only this synthetic probe's denials are relevant; never dump host logs.
            launch = json.loads(result.stderr.splitlines()[0])
            denials = '\n'.join(line for line in diagnostic.stdout.splitlines()
                                if str(root) in line or f"({launch['launchPid']})" in line)[-8000:]
            raise RuntimeError(f'Sandbox launch failed (exit {result.returncode}): '
                               + result.stderr + denials)
        facts = json.loads(result.stdout)
        assert facts['uid'] == uid and facts['groups'] == [uid], facts
        for key in ('qualification_read', 'qualification_write', 'actions_read', 'actions_write',
                    'parent_signal', 'unrelated_local_service'):
            assert facts[key] == 'denied', facts
        assert facts['sudo'] != 0 and facts['descendant_write'] == 'denied', facts
        assert facts['provider'] == 'ok' and facts['credential_env'] is None, facts
        assert facts['own_write'] == 'candidate writes stay private', facts
        assert all((root / name / 'canary').read_text() == 'trusted' for name in ('qualification', 'actions'))
        print(json.dumps({'status': 'passed', 'kind': 'macos-uid-seatbelt-feasibility', 'facts': facts}))
    finally:
        for listener in sockets:
            listener.close()
        subprocess.run(['sudo', '-n', 'rm', '-rf', str(root)], check=True)


if __name__ == '__main__':
    main()
