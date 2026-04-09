#!/usr/bin/env python3
import os
import json
import sqlite3
import subprocess
from datetime import datetime, timedelta

WORKSPACE_DIR = "/home/node/.openclaw/workspace/email-ingest-integration"
VENV_PYTHON = os.path.join(WORKSPACE_DIR, "venv/bin/python3")
DB_PATH = os.path.join(WORKSPACE_DIR, "data/email_ingest.sqlite")
STATE_PATH = "/home/node/.openclaw/workspace/memory/email_triage_state.json"

def get_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, 'r') as f:
            return json.load(f)
    return {"cursor": {"last_ingested_id": 0}, "pending_attention": []}

def save_state(state):
    with open(STATE_PATH, 'w') as f:
        json.dump(state, f, indent=2)

def check_db_initialized():
    if not os.path.exists(DB_PATH):
        return False
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM email_accounts")
        count = cursor.fetchone()[0]
        conn.close()
        return count > 0
    except:
        return False

def sync():
    cmd = [VENV_PYTHON, "main.py", "ingest", "--format", "json"]
    
    # 首次运行逻辑：检查数据库是否已有游标
    if not check_db_initialized():
        yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')
        cmd.extend(["--init-start-date", yesterday])
    
    result = subprocess.run(cmd, cwd=WORKSPACE_DIR, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Sync failed: {result.stderr}")
        return
    
    # 自动获取本次运行的所有邮件进行报告
    state = get_state()
    query_cmd = [VENV_PYTHON, "main.py", "query", "--after-id", str(state["cursor"]["last_ingested_id"]), "--format", "json"]
    query_result = subprocess.run(query_cmd, cwd=WORKSPACE_DIR, capture_output=True, text=True)
    
    if query_result.returncode == 0:
        data = json.loads(query_result.stdout)
        new_emails = data.get("results", [])
        for email in new_emails:
            # 避免重复
            if not any(item["id"] == email["id"] for item in state["pending_attention"]):
                state["pending_attention"].append({
                    "id": email["id"],
                    "subject": email["subject"],
                    "priority": email["priority"],
                    "sender": email["sender"],
                    "summary": email.get("summary", ""),
                    "status": "pending"
                })
        
        if data.get("meta", {}).get("max_id"):
            state["cursor"]["last_ingested_id"] = data["meta"]["max_id"]
        
        save_state(state)
        print(f"Sync complete. Found {len(new_emails)} new emails.")

def dismiss(email_id):
    state = get_state()
    original_len = len(state["pending_attention"])
    state["pending_attention"] = [item for item in state["pending_attention"] if item["id"] != int(email_id)]
    if len(state["pending_attention"]) < original_len:
        save_state(state)
        return True
    return False

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        if sys.argv[1] == "sync":
            sync()
        elif sys.argv[1] == "dismiss" and len(sys.argv) > 2:
            if dismiss(sys.argv[2]):
                print(f"Email {sys.argv[2]} dismissed.")
            else:
                print(f"Email {sys.argv[2]} not found.")
