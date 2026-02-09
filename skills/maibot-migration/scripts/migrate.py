#!/usr/bin/env python3
"""
MAIBOT Migration Tool

Usage:
    python migrate.py detect          # Check target environment
    python migrate.py install         # Install dependencies + clone repos
    python migrate.py setup-env       # Interactive .env creation
    python migrate.py validate        # Verify everything works
    python migrate.py full            # Run all steps
"""

import argparse
import io
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

# Fix Windows encoding
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def run(cmd, capture=True, timeout=30):
    """Run a command and return (success, output)."""
    try:
        r = subprocess.run(
            cmd, shell=True, capture_output=capture, text=True, timeout=timeout
        )
        return r.returncode == 0, r.stdout.strip()
    except Exception as e:
        return False, str(e)


def header(title):
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}\n")


# ── Step 1: Detect ──────────────────────────────────────────


def detect():
    """Detect target environment capabilities."""
    header("🔍 Environment Detection")

    checks = {}

    # OS
    os_name = platform.system()
    os_ver = platform.version()
    print(f"  OS: {os_name} {os_ver}")
    checks["os"] = os_name

    # Node.js
    ok, ver = run("node --version")
    if ok:
        print(f"  Node.js: {ver} ✅")
        major = int(ver.lstrip("v").split(".")[0])
        if major < 22:
            print(f"    ⚠️  Node 22+ required (found {major})")
            checks["node"] = "upgrade_needed"
        else:
            checks["node"] = ver
    else:
        print("  Node.js: NOT FOUND ❌")
        checks["node"] = None

    # npm
    ok, ver = run("npm --version")
    print(f"  npm: {ver if ok else 'NOT FOUND ❌'}")

    # Git
    ok, ver = run("git --version")
    print(f"  Git: {ver if ok else 'NOT FOUND ❌'}")
    checks["git"] = ver if ok else None

    # Python
    ok, ver = run("python --version")
    if not ok:
        ok, ver = run("python3 --version")
    print(f"  Python: {ver if ok else 'NOT FOUND'}")
    checks["python"] = ver if ok else None

    # GPU
    ok, out = run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader")
    if ok:
        print(f"  GPU: {out} ✅")
        checks["gpu"] = out
    else:
        print("  GPU: Not detected (video generation unavailable)")
        checks["gpu"] = None

    # Moltbot
    ok, ver = run("moltbot --version")
    if ok:
        print(f"  Moltbot: {ver} ✅")
        checks["moltbot"] = ver
    else:
        print("  Moltbot: NOT INSTALLED")
        checks["moltbot"] = None

    # Disk space
    total, used, free = shutil.disk_usage(Path.home())
    free_gb = free / (1024**3)
    print(f"  Disk free: {free_gb:.1f} GB {'✅' if free_gb > 10 else '⚠️ Low'}")
    checks["disk_free_gb"] = round(free_gb, 1)

    print("\n" + "-" * 60)
    missing = []
    if not checks.get("node"):
        missing.append("Node.js 22+")
    if not checks.get("git"):
        missing.append("Git")
    if not checks.get("moltbot"):
        missing.append("Moltbot (npm i -g moltbot)")

    if missing:
        print(f"  ❌ Missing: {', '.join(missing)}")
        print("  Install these before proceeding.")
    else:
        print("  ✅ All required dependencies present!")
        if not checks.get("gpu"):
            print("  ℹ️  No GPU — chat/API will work, video generation won't.")

    return checks


# ── Step 2: Install ─────────────────────────────────────────


def install(maibot_dir=None, maibeauty_dir=None):
    """Install Moltbot and clone repositories."""
    header("📦 Installing Dependencies")

    # Install Moltbot
    ok, ver = run("moltbot --version")
    if ok:
        print(f"  Moltbot already installed: {ver}")
    else:
        print("  Installing Moltbot...")
        ok, out = run("npm i -g moltbot", timeout=120)
        if ok:
            print("  ✅ Moltbot installed")
        else:
            print(f"  ❌ Failed: {out}")
            return False

    # Clone MAIBOT
    maibot = Path(maibot_dir or (Path.home() / "MAIBOT"))
    if maibot.exists() and (maibot / ".git").exists():
        print(f"  MAIBOT repo exists: {maibot}")
        run(f"cd {maibot} && git pull", timeout=30)
    else:
        print(f"  Cloning MAIBOT → {maibot}")
        ok, out = run(
            f"git clone https://github.com/jini92/MAIBOT.git {maibot}", timeout=120
        )
        print(f"  {'✅' if ok else '❌'} MAIBOT clone")

    # Clone MAIBEAUTY
    maibeauty = Path(maibeauty_dir or (Path.home() / "MAIBEAUTY"))
    if maibeauty.exists() and (maibeauty / ".git").exists():
        print(f"  MAIBEAUTY repo exists: {maibeauty}")
        run(f"cd {maibeauty} && git pull", timeout=30)
    else:
        print(f"  Cloning MAIBEAUTY → {maibeauty}")
        ok, out = run(
            f"git clone https://github.com/jini92/MAIBEAUTY.git {maibeauty}",
            timeout=120,
        )
        print(f"  {'✅' if ok else '❌'} MAIBEAUTY clone")

    return True


# ── Step 3: Setup .env ──────────────────────────────────────


ENV_KEYS = [
    ("MAIBEAUTY_API_URL", "https://maibeauty-api-production.up.railway.app", "MAIBEAUTY API URL"),
    ("MAIBEAUTY_ADMIN_EMAIL", "jini@maibeauty.vn", "Admin email"),
    ("MAIBEAUTY_ADMIN_PASSWORD", "", "Admin password"),
    ("R2_ACCOUNT_ID", "", "Cloudflare Account ID"),
    ("R2_ACCESS_KEY_ID", "", "R2 Access Key ID"),
    ("R2_SECRET_ACCESS_KEY", "", "R2 Secret Access Key"),
    ("R2_BUCKET_NAME", "maibeauty-media", "R2 Bucket Name"),
    ("R2_ENDPOINT", "", "R2 Endpoint URL"),
    ("R2_PUBLIC_URL", "", "R2 Public URL"),
    ("CLOUDFLARE_API_TOKEN", "", "Cloudflare API Token"),
    ("CLOUDFLARE_ACCOUNT_ID", "", "Cloudflare Account ID"),
    ("VIDEO_WORKER_KEY", "", "Video Worker Key"),
    ("OLLAMA_BASE_URL", "http://localhost:11434", "Ollama URL"),
]


def setup_env(maibeauty_dir=None):
    """Interactive .env file creation."""
    header("🔑 Credential Setup")

    maibeauty = Path(maibeauty_dir or (Path.home() / "MAIBEAUTY"))
    env_path = maibeauty / ".env"

    if env_path.exists():
        resp = input(f"  .env exists at {env_path}. Overwrite? (y/N): ")
        if resp.lower() != "y":
            print("  Skipped.")
            return

    lines = []
    print("  Enter values (press Enter to use default):\n")
    for key, default, desc in ENV_KEYS:
        prompt = f"  {desc} [{key}]"
        if default:
            prompt += f" ({default})"
        prompt += ": "
        val = input(prompt).strip() or default
        if val:
            lines.append(f"{key}={val}")

    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n  ✅ Saved: {env_path}")


# ── Step 4: Validate ────────────────────────────────────────


def validate(maibot_dir=None, maibeauty_dir=None):
    """Validate the migration."""
    header("✅ Validation")

    results = []

    # Moltbot
    ok, ver = run("moltbot --version")
    results.append(("Moltbot", ok, ver))

    # MAIBOT repo
    maibot = Path(maibot_dir or (Path.home() / "MAIBOT"))
    ok = (maibot / "MEMORY.md").exists()
    results.append(("MAIBOT workspace", ok, str(maibot)))

    # MAIBEAUTY repo
    maibeauty = Path(maibeauty_dir or (Path.home() / "MAIBEAUTY"))
    ok = (maibeauty / "api").exists()
    results.append(("MAIBEAUTY project", ok, str(maibeauty)))

    # .env
    env_ok = (maibeauty / ".env").exists()
    results.append((".env file", env_ok, str(maibeauty / ".env")))

    # API connectivity
    try:
        import urllib.request
        req = urllib.request.Request(
            "https://maibeauty-api-production.up.railway.app/docs",
            method="HEAD",
        )
        resp = urllib.request.urlopen(req, timeout=10)
        ok = resp.status == 200
    except Exception:
        ok = False
    results.append(("MAIBEAUTY API", ok, "Railway"))

    # GPU
    ok, out = run("nvidia-smi --query-gpu=name --format=csv,noheader")
    results.append(("GPU", ok, out if ok else "Not available"))

    # Print results
    print(f"  {'Component':<25} {'Status':<8} Details")
    print(f"  {'-'*25} {'-'*8} {'-'*30}")
    all_ok = True
    for name, ok, detail in results:
        status = "✅" if ok else "❌"
        if not ok and name == "GPU":
            status = "ℹ️"  # GPU is optional
        else:
            if not ok:
                all_ok = False
        print(f"  {name:<25} {status:<8} {detail}")

    print()
    if all_ok:
        print("  🎉 Migration successful! Run `moltbot gateway run` to start.")
    else:
        print("  ⚠️  Some checks failed. Fix issues above and re-run validate.")


# ── Main ────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="MAIBOT Migration Tool")
    parser.add_argument(
        "command",
        choices=["detect", "install", "setup-env", "validate", "full"],
        help="Migration step to run",
    )
    parser.add_argument("--maibot-dir", default=None, help="MAIBOT workspace directory")
    parser.add_argument("--maibeauty-dir", default=None, help="MAIBEAUTY project directory")
    args = parser.parse_args()

    header("🦞 MAIBOT Migration Tool")

    if args.command == "detect":
        detect()
    elif args.command == "install":
        install(args.maibot_dir, args.maibeauty_dir)
    elif args.command == "setup-env":
        setup_env(args.maibeauty_dir)
    elif args.command == "validate":
        validate(args.maibot_dir, args.maibeauty_dir)
    elif args.command == "full":
        checks = detect()
        if not checks.get("node") or not checks.get("git"):
            print("\n❌ Install Node.js 22+ and Git first.")
            sys.exit(1)
        install(args.maibot_dir, args.maibeauty_dir)
        setup_env(args.maibeauty_dir)
        validate(args.maibot_dir, args.maibeauty_dir)


if __name__ == "__main__":
    main()
