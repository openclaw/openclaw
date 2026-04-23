#!/usr/bin/env python3
"""User-space TCP forwarder so docker bridge containers can reach host Ollama.

Listens on the docker bridge IP and forwards to 127.0.0.1:11435 (Ollama).
"""
import socket
import sys
import threading

LISTEN_HOST = "172.18.0.1"
LISTEN_PORT = 11436
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 11435


def pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client: socket.socket) -> None:
    upstream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        upstream.connect((TARGET_HOST, TARGET_PORT))
    except OSError as exc:
        print(f"upstream connect failed: {exc}", file=sys.stderr)
        client.close()
        return
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


def main() -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LISTEN_HOST, LISTEN_PORT))
    server.listen(64)
    print(f"ollama-bridge listening on {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}", flush=True)
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
