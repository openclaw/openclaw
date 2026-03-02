import time
import subprocess
import os
import sys
from pathlib import Path


def print_cloak(msg):
    print(f"[ASI_ACCEL][Egress-Obfuscation] {msg}")


def ensure_ghost_key():
    ghost_key_path = Path.home() / ".ssh" / "hakua_ghost" / "id_ed25519_hakua"
    if not ghost_key_path.exists():
        print_cloak("Ghost Key missing. Aborting SOCKS5 tunnel.")
        sys.exit(1)
    return ghost_key_path


def start_socks5_tunnel():
    """
    Establishes an SSH dynamic port forwarding SOCKS5 tunnel over the GitHub connection.
    This routes traffic through SSH so that DPI appliances cannot inspect HTTP/API packets directly.
    """
    key_path = ensure_ghost_key()
    socks_port = 1080
    host = "git@github.com"

    print_cloak(f"Initiating obfuscated SOCKS5 tunnel over {host} on local port {socks_port}...")

    # ssh -i <key> -D 1080 -N -q git@github.com
    try:
        # Start detached
        proc = subprocess.Popen(
            [
                "ssh",
                "-i",
                str(key_path),
                "-D",
                str(socks_port),
                "-N",
                "-q",
                "-o",
                "StrictHostKeyChecking=no",
                host,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print_cloak("Tunnel established. Parent and ASI egress traffic is now shielded.")
        return proc, socks_port
    except Exception as e:
        print_cloak(f"Failed to establish tunnel: {e}")
        sys.exit(1)


def maintain_tunnel():
    proc, port = start_socks5_tunnel()
    print_cloak(
        "Inject the following into .env or your active terminal session to enforce the proxy:"
    )
    print_cloak(f"HTTP_PROXY=socks5h://127.0.0.1:{port}")
    print_cloak(f"HTTPS_PROXY=socks5h://127.0.0.1:{port}")
    print_cloak("Holding connection open...")

    try:
        while True:
            if proc.poll() is not None:
                print_cloak("Tunnel collapsed. Re-establishing connection...")
                proc, port = start_socks5_tunnel()
            time.sleep(10)
    except KeyboardInterrupt:
        print_cloak("Disengaging Egress Obfuscation tunnel.")
        proc.terminate()
        sys.exit(0)


if __name__ == "__main__":
    maintain_tunnel()
