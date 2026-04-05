#!/usr/bin/env python3
"""
Hook Health Check — verify all hooks can execute without errors.
Run: python3 .claude/hooks/health-check.py
"""
import subprocess, sys, os, json, time

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))

# List of hooks to test (just import/syntax check, don't actually run logic)
HOOKS = [
    "ci-watch.py",
    "ci-status-inject.py",
    "perception-dispatch.py",
    "guard-openclaw-config.py",
    "trace-hook.py",
    "session-snapshot.py",
    "memory-rag-retrieve.py",
    "tg-scan.py",
    "eyes-scan.py",
    "ears-check.py",
    "line-scan.py",
    "voice-loop-hook.py",
]

def check_hook(name):
    path = os.path.join(HOOKS_DIR, name)
    if not os.path.exists(path):
        return {"name": name, "status": "missing", "error": "file not found"}

    try:
        # Syntax check only (don't execute)
        result = subprocess.run(
            [sys.executable, "-c", f"import py_compile; py_compile.compile('{path}', doraise=True)"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            return {"name": name, "status": "ok"}
        else:
            return {"name": name, "status": "error", "error": result.stderr.strip()[:200]}
    except subprocess.TimeoutExpired:
        return {"name": name, "status": "timeout"}
    except Exception as e:
        return {"name": name, "status": "error", "error": str(e)[:200]}

def main():
    results = [check_hook(h) for h in HOOKS]
    ok = sum(1 for r in results if r["status"] == "ok")
    total = len(results)

    print(f"Hook Health Check: {ok}/{total} passed")
    for r in results:
        icon = "✅" if r["status"] == "ok" else "❌" if r["status"] == "error" else "⚠️"
        msg = f"  {icon} {r['name']}: {r['status']}"
        if "error" in r:
            msg += f" — {r['error']}"
        print(msg)

    sys.exit(0 if ok == total else 1)

if __name__ == "__main__":
    main()
