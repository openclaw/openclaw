#!/usr/bin/env python3
import argparse
import time
import sys
import glob
import json
import os
import subprocess

def get_session_file(session_key):
    # Generically search across all agents' sessions.json
    paths = glob.glob(os.path.expanduser("~/.openclaw/agents/*/sessions/sessions.json"))
    for path in paths:
        try:
            with open(path) as f:
                registry = json.load(f)
                if session_key in registry:
                    return registry[session_key].get("sessionFile")
        except Exception:
            continue
    return None

def is_session_done(session_file):
    if not os.path.exists(session_file):
        return False
    try:
        # A generic heuristic: if the session's JSONL file hasn't been
        # written to in the last 15 seconds, we consider the turn complete.
        mtime = os.path.getmtime(session_file)
        if time.time() - mtime > 15:
            return True
    except OSError:
        pass
    return False

def update_ledger(session_key, status):
    ledger_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "acp-ledger.json"))
    if not os.path.exists(ledger_path):
        return
    try:
        with open(ledger_path, "r") as f:
            ledger = json.load(f)
        
        # We don't have a rigid schema, but we can maintain a jobs dict or update pending_jobs
        if "jobs" not in ledger:
            ledger["jobs"] = {}
        
        ledger["jobs"][session_key] = {
            "status": status,
            "updated_at": time.time()
        }
        
        # Optional: remove from pending_jobs if it was a list
        if "pending_jobs" in ledger and isinstance(ledger["pending_jobs"], list):
            if session_key in ledger["pending_jobs"]:
                ledger["pending_jobs"].remove(session_key)

        with open(ledger_path, "w") as f:
            json.dump(ledger, f, indent=2)
    except Exception as e:
        print(f"Warning: Failed to update ledger: {e}")

def send_notification(session_key, status):
    try:
        if status == "completed":
            subprocess.run(["notify-send", "ACP Job Complete", f"Session {session_key} has finished. Reprompt the assistant for results."], check=False)
        elif status == "timeout":
            subprocess.run(["notify-send", "ACP Job Timeout", f"Session {session_key} timed out."], check=False)
    except Exception:
        pass

def main():
    parser = argparse.ArgumentParser(description="Wait for an ACP session to complete generically")
    parser.add_argument("--session-key", required=True, help="The session key to wait for")
    parser.add_argument("--timeout", type=int, default=1800, help="Timeout in seconds")
    parser.add_argument("--interval", type=int, default=10, help="Polling interval in seconds")
    parser.add_argument("--notify", action="store_true", help="Send OS notification when done")
    parser.add_argument("--update-ledger", action="store_true", help="Update acp-ledger.json when done")
    args = parser.parse_args()

    session_file = None
    start_time = time.time()
    
    # Wait up to 30s for the session to appear in the registries
    while time.time() - start_time < 30:
        session_file = get_session_file(args.session_key)
        if session_file:
            break
        time.sleep(2)
        
    if not session_file:
        print(f"Timeout: Could not find sessionFile for {args.session_key} in registries.")
        if args.update_ledger:
            update_ledger(args.session_key, "not_found")
        return 1

    print(f"Tracking session file: {session_file}")
    
    # Block and poll until the session is deemed complete
    while True:
        if is_session_done(session_file):
            print("Session appears to be complete (inactivity detected).")
            if args.update_ledger:
                update_ledger(args.session_key, "completed")
            if args.notify:
                send_notification(args.session_key, "completed")
            return 0
            
        if time.time() - start_time > args.timeout:
            print("Timeout reached waiting for session to complete.")
            if args.update_ledger:
                update_ledger(args.session_key, "timeout")
            if args.notify:
                send_notification(args.session_key, "timeout")
            return 124
            
        time.sleep(args.interval)

if __name__ == "__main__":
    sys.exit(main())
