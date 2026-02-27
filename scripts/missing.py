#!/usr/bin/env python3
"""
missing.py - runtime script integrity checker & restorer

Checks: existence, permissions, and sha256 of critical runtime scripts.
Can restore from a backup directory or via `git checkout -- <file>` if available.

Usage examples:
  python3 scripts/missing.py --self-check
  python3 scripts/missing.py --restore-from /path/to/backups --use-git

"""
import argparse
import hashlib
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

# Define critical files and expected sha256 (empty means unknown/skip hash check)
CRITICAL = {
    "scripts/autopilot_sweeper.py": "",
    "scripts/health_check.py": "",
    "scripts/missing.py": "",
}

ROOT = Path(__file__).resolve().parents[1]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def check_file(relpath: str):
    path = ROOT / relpath
    ok = True
    reasons = []
    if not path.exists():
        ok = False
        reasons.append("missing")
        return ok, reasons
    # perms: owner executable for scripts
    mode = path.stat().st_mode
    if not (mode & stat.S_IXUSR):
        ok = False
        reasons.append("not-executable")
    # sha256 check if expected provided
    exp = CRITICAL.get(relpath, "")
    if exp:
        try:
            h = sha256_of(path)
            if h != exp:
                ok = False
                reasons.append(f"sha256-mismatch (actual={h})")
        except Exception as e:
            ok = False
            reasons.append(f"sha-check-error:{e}")
    return ok, reasons


def restore_from_backup(relpath: str, backup_dir: Path) -> bool:
    src = backup_dir / relpath
    dst = ROOT / relpath
    if not src.exists():
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    # try to restore executable bit
    try:
        dst.chmod(dst.stat().st_mode | stat.S_IXUSR)
    except Exception:
        pass
    return True


def restore_from_git(relpath: str) -> bool:
    # run: git checkout -- <relpath>
    try:
        subprocess.run(["git", "checkout", "--", relpath], cwd=ROOT, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except Exception:
        return False


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--self-check", action="store_true", help="Run checks and print report")
    p.add_argument("--restore-from", type=str, default=None, help="Backup directory root to restore from")
    p.add_argument("--use-git", action="store_true", help="Attempt `git checkout` restore when available")
    p.add_argument("--fix-perms", action="store_true", help="Fix permissions for non-executable scripts")
    args = p.parse_args()

    backup_dir = Path(args.restore_from) if args.restore_from else None

    report = {}
    for rel in CRITICAL.keys():
        ok, reasons = check_file(rel)
        report[rel] = {"ok": ok, "reasons": reasons}

    # If self-check only, print and exit with non-zero if any failed
    if args.self_check:
        print("Self-check report:")
        failed = 0
        for rel, r in report.items():
            status = "OK" if r["ok"] else "FAIL"
            print(f" - {rel}: {status}")
            if r["reasons"]:
                print(f"    reasons: {', '.join(r['reasons'])}")
            if not r["ok"]:
                failed += 1
        sys.exit(0 if failed == 0 else 2)

    any_changes = False
    for rel, r in report.items():
        if r["ok"]:
            continue
        print(f"Restoring {rel}: reasons={r['reasons']}")
        restored = False
        if backup_dir:
            try:
                restored = restore_from_backup(rel, backup_dir)
                if restored:
                    print(f" - restored from backup: {backup_dir}")
            except Exception as e:
                print(f" - backup restore error: {e}")
        if not restored and args.use_git:
            restored = restore_from_git(rel)
            if restored:
                print(" - restored via git checkout")
        if restored:
            any_changes = True
            # re-run check and optionally fix perms
            if args.fix_perms:
                pth = ROOT / rel
                try:
                    pth.chmod(pth.stat().st_mode | stat.S_IXUSR)
                except Exception:
                    pass
        else:
            # If file exists but only permissions are wrong, and user requested fix-perms, try that
            if args.fix_perms and (ROOT / rel).exists():
                try:
                    pth = ROOT / rel
                    pth.chmod(pth.stat().st_mode | stat.S_IXUSR)
                    print(f" - fixed permissions on existing file: {rel}")
                    any_changes = True
                except Exception as e:
                    print(f" - could not fix perms: {e}")
            else:
                print(" - could not restore")

    if any_changes:
        print("Restoration attempted. Re-running checks:")
        for rel in CRITICAL.keys():
            ok, reasons = check_file(rel)
            print(f" - {rel}: {'OK' if ok else 'FAIL'}")
    else:
        print("No restoration performed.")


if __name__ == '__main__':
    main()
