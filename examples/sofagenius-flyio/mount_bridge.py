#!/usr/bin/env python3
"""Mount the bridge router into SofaGenius's FastAPI app.

This script patches SofaGenius's main.py at deploy time to include the
bridge router, without modifying the SofaGenius repo itself.

Run after SofaGenius is cloned:
    python3 /app/examples/sofagenius-flyio/mount_bridge.py

What it does:
1. Copies bridge_router.py into the SofaGenius backend directory
2. Appends a router import + mount to SofaGenius's main.py
"""

import shutil
import sys
from pathlib import Path

SOFAGENIUS_DIR = Path("/opt/sofagenius")
BRIDGE_ROUTER_SRC = Path(__file__).parent / "bridge_router.py"
BRIDGE_ROUTER_DST = SOFAGENIUS_DIR / "backend" / "bridge_router.py"
MAIN_PY = SOFAGENIUS_DIR / "backend" / "main.py"

MOUNT_SNIPPET = """
# --- OpenClaw bridge router (auto-mounted) ---
try:
    from backend.bridge_router import router as bridge_router
    app.include_router(bridge_router)
    print("[bridge] OpenClaw bridge router mounted at /api/*")
except Exception as e:
    print(f"[bridge] Could not mount bridge router: {e}")
# --- end bridge router ---
"""


def main():
    if not SOFAGENIUS_DIR.exists():
        print(f"SofaGenius not found at {SOFAGENIUS_DIR}", file=sys.stderr)
        sys.exit(1)

    if not MAIN_PY.exists():
        print(f"SofaGenius main.py not found at {MAIN_PY}", file=sys.stderr)
        sys.exit(1)

    # Copy bridge_router.py into SofaGenius backend
    shutil.copy2(BRIDGE_ROUTER_SRC, BRIDGE_ROUTER_DST)
    print(f"Copied bridge_router.py → {BRIDGE_ROUTER_DST}")

    # Check if already mounted
    main_content = MAIN_PY.read_text()
    if "bridge_router" in main_content:
        print("Bridge router already mounted in main.py — skipping")
        return

    # Append mount snippet to main.py
    with open(MAIN_PY, "a") as f:
        f.write(MOUNT_SNIPPET)
    print(f"Mounted bridge router in {MAIN_PY}")
    print("Bridge endpoints available at /api/training/*, /api/data/*, /api/scout/*, /api/feedback/*")


if __name__ == "__main__":
    main()
