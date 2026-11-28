#!/usr/bin/env python3
"""Private root observer for an unprivileged synthetic btrfs checkpoint benchmark."""
import argparse
import ctypes
import os
from pathlib import Path
import signal
import socket
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--socket", type=Path, required=True)
args = parser.parse_args()
assert os.geteuid() == 0
root = args.root.resolve(strict=True)
owner = root.stat()
descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
libc = ctypes.CDLL(None, use_errno=True)
libc.syncfs.argtypes = [ctypes.c_int]
libc.syncfs.restype = ctypes.c_int
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(str(args.socket))  # Refuse an existing socket or unrelated file.
os.chown(args.socket, owner.st_uid, owner.st_gid)
os.chmod(args.socket, 0o600)
server.listen(1)


def stop(_signal, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
try:
    while True:
        connection, _ = server.accept()
        with connection:
            connection.settimeout(10)
            try:
                with connection.makefile("rb") as incoming:
                    request = incoming.read(16)
                if request != b"settle\n":
                    raise ValueError("Invalid settlement request")
                if libc.syncfs(descriptor):
                    error = ctypes.get_errno()
                    raise OSError(error, os.strerror(error))
                subprocess.run(["btrfs", "subvolume", "sync", str(root)],
                               check=True, stdout=subprocess.DEVNULL)
                connection.sendall(b"settled\n")
            except Exception as error:
                connection.sendall(f"error: {error}\n".encode())
finally:
    os.close(descriptor)
    server.close()
    args.socket.unlink()
