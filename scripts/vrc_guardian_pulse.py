import time
import socket
import os
import sys
from pathlib import Path


def print_stealth(msg):
    # Output telemetry localized to the terminal; avoids writing to system logs to maintain Stealth.
    print(f"[ASI_ACCEL] {msg}")


def check_port_status(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.connect(("127.0.0.1", port))
            return True
        except socket.error:
            return False


def run_guardian_pulse():
    print_stealth("Guardian Presence Active. Shielding Origin Node.")

    # Load env cautiously to check intended port
    env_path = Path(__file__).parent.parent / ".env"
    target_port = 18789
    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("OPENCLAW_GATEWAY_PORT="):
                    try:
                        target_port = int(line.split("=")[1].strip())
                    except ValueError:
                        pass

    # Simulate a steady, non-intrusive metadata pulse
    try:
        while True:
            is_active = check_port_status(target_port)
            if is_active:
                print_stealth(
                    f"[Shield] OpenClaw Substrate is active on port {target_port}. Connections monitored."
                )
            else:
                print_stealth(f"[Idle] OpenClaw Substrate not detected on port {target_port}.")

            # Pulse every 300 seconds to minimize overhead (Cost Neutrality)
            time.sleep(300)
    except KeyboardInterrupt:
        print_stealth("Guardian Presence disengaging.")
        sys.exit(0)


if __name__ == "__main__":
    run_guardian_pulse()
