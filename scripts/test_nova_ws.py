#!/usr/bin/env python3
"""
E2E test for the Nova WebSocket channel.

Sends a message to the bot via the API Gateway Management API and reads
the bot's response from the session transcript on the EC2 instance.

Usage:
  pip install websockets boto3
  python scripts/test_nova_ws.py [--message "your test message"]

Requires:
  - AWS credentials with access to account 585578473840
  - SSH key at ~/.ssh/HyperionBotServiceEc2.pem
  - The bot's gateway must be running and connected on the EC2
"""

import argparse
import asyncio
import json
import subprocess
import time
import uuid

import boto3
import websockets

# --- Configuration ---
WS_ENDPOINT = "wss://ws.nova-claw.agi.amazon.dev"
APIGW_MANAGEMENT_URL = "https://3x0jx6dr52.execute-api.us-east-1.amazonaws.com/prod"
DDB_TABLE = "nova-personal-connections-prod"
REGION = "us-east-1"

# Auth
API_KEY = "608a34f3-69fd-4dd4-aa88-cb467f2ccb68"

# EC2 connection
EC2_HOST = "ec2-user@ec2-3-235-188-241.compute-1.amazonaws.com"
SSH_KEY = "~/.ssh/HyperionBotServiceEc2.pem"
BOT_SOURCE_IP = "3.235.188.241"

# Test user identity
TEST_USER_ID = "test-user"
TEST_DEVICE_ID = str(uuid.uuid4())


def ssh_cmd(cmd: str, timeout: int = 15) -> str:
    """Run a command on the EC2 via SSH."""
    result = subprocess.run(
        ["ssh", "-i", SSH_KEY, "-o", "StrictHostKeyChecking=no", EC2_HOST, cmd],
        capture_output=True, text=True, timeout=timeout,
    )
    return result.stdout.strip()


def get_bot_connection_id() -> str:
    """Look up the bot's connectionId from DynamoDB by its EC2 IP."""
    ddb = boto3.client("dynamodb", region_name=REGION)
    resp = ddb.scan(TableName=DDB_TABLE)
    for item in resp.get("Items", []):
        device_id = item.get("deviceId", {}).get("S", "")
        source_ip = (
            item.get("metadata", {}).get("M", {}).get("sourceIp", {}).get("S", "")
        )
        conn_id = item.get("connectionId", {}).get("S", "")
        if source_ip == BOT_SOURCE_IP and conn_id:
            print(f"  connectionId:  {conn_id}")
            print(f"  deviceId:      {device_id}")
            print(f"  sourceIp:      {source_ip}")
            print(f"  connectedAt:   {item.get('connectedAt', {}).get('S', '')}")
            return conn_id
    raise RuntimeError(f"No bot connection found (sourceIp={BOT_SOURCE_IP})")


def send_to_bot(connection_id: str, message: dict):
    """Post a message to the bot's connection via the Management API."""
    client = boto3.client(
        "apigatewaymanagementapi",
        endpoint_url=APIGW_MANAGEMENT_URL,
        region_name=REGION,
    )
    client.post_to_connection(
        ConnectionId=connection_id,
        Data=json.dumps(message).encode("utf-8"),
    )


def count_assistant_messages(session_dir: str = "/home/ec2-user/.openclaw/agents/main/sessions") -> dict[str, int]:
    """Count assistant messages per session file on EC2."""
    raw = ssh_cmd(
        f'for f in {session_dir}/*.jsonl; do '
        f'  n=$(grep -c \'"role":"assistant"\' "$f" 2>/dev/null || echo 0); '
        f'  echo "$(basename "$f" .jsonl) $n"; '
        f'done'
    )
    counts: dict[str, int] = {}
    for line in raw.splitlines():
        parts = line.strip().split()
        if len(parts) == 2:
            counts[parts[0]] = int(parts[1])
    return counts


def read_last_assistant_response(
    session_dir: str = "/home/ec2-user/.openclaw/agents/main/sessions",
) -> tuple[str | None, str | None]:
    """Read the most recent assistant response from any session on EC2."""
    raw = ssh_cmd(
        f"ls -t {session_dir}/*.jsonl 2>/dev/null | head -1"
    )
    if not raw or not raw.endswith(".jsonl"):
        return None, None
    session_id = raw.rsplit("/", 1)[-1].replace(".jsonl", "")
    path = f"{session_dir}/{session_id}.jsonl"
    content = ssh_cmd(f"cat {path} 2>/dev/null")
    if not content:
        return session_id, None

    last_response = None
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "message":
            msg = entry.get("message", {})
            if msg.get("role") == "assistant":
                parts = msg.get("content", [])
                text = "".join(
                    p.get("text", "") for p in parts if p.get("type") == "text"
                )
                if text:
                    last_response = text
    return session_id, last_response


def wait_for_bot_response(
    pre_counts: dict[str, int], timeout_secs: int = 60, poll_interval: float = 2.0
) -> tuple[str | None, str | None]:
    """Poll until a new assistant message appears in any session."""
    start = time.time()
    while time.time() - start < timeout_secs:
        elapsed = int(time.time() - start)
        if elapsed > 0 and elapsed % 5 == 0:
            print(f"  ... polling ({elapsed}s)")
        current = count_assistant_messages()
        for sid, count in current.items():
            prev = pre_counts.get(sid, 0)
            if count > prev:
                # New assistant message — read it
                time.sleep(1)  # let the file finish writing
                _, response = read_last_assistant_response()
                if response:
                    return sid, response
        time.sleep(poll_interval)
    return None, None


async def run_test(test_message: str, timeout_secs: int):
    """Run the E2E test."""
    print("=" * 60)
    print("Nova WebSocket E2E Test")
    print("=" * 60)

    # Step 1: Snapshot existing assistant message counts
    print("\n[1] Snapshotting session state on EC2...")
    pre_counts = count_assistant_messages()
    total = sum(pre_counts.values())
    print(f"  {len(pre_counts)} session(s), {total} assistant message(s)")

    # Step 2: Find the bot's connection
    print("\n[2] Looking up bot connection from DynamoDB...")
    bot_conn_id = get_bot_connection_id()

    # Step 3: Send message to bot
    message_id = str(uuid.uuid4())
    inbound = {
        "action": "message",
        "userId": TEST_USER_ID,
        "text": test_message,
        "messageId": message_id,
        "timestamp": int(time.time() * 1000),
    }

    print(f"\n[3] Sending message to bot...")
    print(f"  messageId: {message_id}")
    print(f"  text:      {test_message}")

    try:
        send_to_bot(bot_conn_id, inbound)
        print("  Sent successfully!")
    except Exception as e:
        print(f"  ERROR: {e}")
        return

    # Step 4: Wait for response
    print(f"\n[4] Waiting for bot response (polling EC2 sessions, timeout {timeout_secs}s)...")
    print("-" * 60)

    session_id, response = wait_for_bot_response(pre_counts, timeout_secs)

    print("-" * 60)
    if response:
        print(f"\n[Result] Session: {session_id}")
        print(f"\nBot response:")
        print(response)
    else:
        print("\n[Result] No response within timeout.")
        print("  Check bot logs:")
        print(f"    ssh -i {SSH_KEY} {EC2_HOST} \\")
        print("      'grep nova /tmp/openclaw/openclaw-*.log | tail -20'")

    print("\n" + "=" * 60)
    print("Test complete.")


def main():
    parser = argparse.ArgumentParser(description="Test Nova WebSocket E2E")
    parser.add_argument(
        "--message", "-m",
        default="Hello! What is 2 + 2?",
        help="Message to send to the bot",
    )
    parser.add_argument(
        "--timeout", "-t",
        type=int,
        default=60,
        help="Seconds to wait for response (default: 60)",
    )
    args = parser.parse_args()
    asyncio.run(run_test(args.message, args.timeout))


if __name__ == "__main__":
    main()
