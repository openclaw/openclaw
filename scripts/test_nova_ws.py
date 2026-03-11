#!/usr/bin/env python3
"""
E2E test for the Nova WebSocket channel.

Connects as a user via WebSocket, sends a message to a bot via the
API Gateway Management API, and waits for the bot's response on the
WebSocket.  Works with any bot — no SSH or EC2 access required.

Usage:
  pip install websockets boto3
  python scripts/test_nova_ws.py [--message "your test message"]
  python scripts/test_nova_ws.py --device-id <uuid>
  python scripts/test_nova_ws.py --connection-id <id>
  python scripts/test_nova_ws.py --list

Requires:
  - AWS credentials with access to the DynamoDB table and APIGW Management API
"""

import argparse
import asyncio
import json
import os
import time
import uuid

import boto3
import websockets

# --- Configuration ---
WS_ENDPOINT = "wss://ws.nova-claw.agi.amazon.dev"
APIGW_MANAGEMENT_URL = "https://3x0jx6dr52.execute-api.us-east-1.amazonaws.com/prod"
DDB_TABLE = "nova-personal-connections-prod"
REGION = "us-east-1"

# Auth – set NOVA_API_KEY in your environment or .env file
API_KEY = os.environ.get("NOVA_API_KEY", "")

# Test user identity
TEST_USER_ID = "test-user"
TEST_DEVICE_ID = str(uuid.uuid4())


def list_connections() -> list[dict]:
    """List all active connections from DynamoDB."""
    ddb = boto3.client("dynamodb", region_name=REGION)
    resp = ddb.scan(TableName=DDB_TABLE)
    connections = []
    for item in resp.get("Items", []):
        conn = {
            "connectionId": item.get("connectionId", {}).get("S", ""),
            "deviceId": item.get("deviceId", {}).get("S", ""),
            "userId": item.get("userId", {}).get("S", ""),
            "sourceIp": (
                item.get("metadata", {}).get("M", {}).get("sourceIp", {}).get("S", "")
            ),
            "connectedAt": item.get("connectedAt", {}).get("S", ""),
        }
        if conn["connectionId"]:
            connections.append(conn)
    # Sort by connectedAt descending (most recent first)
    connections.sort(key=lambda c: c["connectedAt"], reverse=True)
    return connections


def find_connection(
    connection_id: str | None = None,
    device_id: str | None = None,
    user_id: str | None = None,
    source_ip: str | None = None,
) -> dict:
    """Find a bot connection by connectionId, deviceId, userId, or sourceIp."""
    connections = list_connections()
    if not connections:
        raise RuntimeError("No connections found in DynamoDB")

    if connection_id:
        for c in connections:
            if c["connectionId"] == connection_id:
                return c
        raise RuntimeError(f"No connection found with connectionId={connection_id}")

    if user_id:
        for c in connections:
            if c["userId"] == user_id:
                return c
        raise RuntimeError(f"No connection found with userId={user_id}")

    if device_id:
        for c in connections:
            if c["deviceId"] == device_id:
                return c
        raise RuntimeError(f"No connection found with deviceId={device_id}")

    if source_ip:
        for c in connections:
            if c["sourceIp"] == source_ip:
                return c
        raise RuntimeError(f"No connection found with sourceIp={source_ip}")

    # Default: return the most recent connection
    return connections[0]


def print_connections(connections: list[dict]):
    """Pretty-print a list of connections."""
    if not connections:
        print("  (no connections)")
        return
    for i, c in enumerate(connections):
        print(f"  [{i}] connectionId: {c['connectionId']}")
        print(f"      userId:       {c['userId'] or '(not set)'}")
        print(f"      deviceId:     {c['deviceId']}")
        print(f"      sourceIp:     {c['sourceIp']}")
        print(f"      connectedAt:  {c['connectedAt']}")
        if i < len(connections) - 1:
            print()


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


async def run_test(
    test_message: str,
    timeout_secs: int,
    connection_id: str | None,
    device_id: str | None,
    user_id: str | None,
    source_ip: str | None,
):
    """Run the E2E test."""
    print("=" * 60)
    print("Nova WebSocket E2E Test")
    print("=" * 60)

    # Step 1: Find the bot's connection
    print("\n[1] Looking up bot connection from DynamoDB...")
    conn = find_connection(connection_id, device_id, user_id, source_ip)
    bot_conn_id = conn["connectionId"]
    print(f"  connectionId: {conn['connectionId']}")
    print(f"  userId:       {conn['userId'] or '(not set)'}")
    print(f"  deviceId:     {conn['deviceId']}")
    print(f"  sourceIp:     {conn['sourceIp']}")
    print(f"  connectedAt:  {conn['connectedAt']}")

    # Step 2: Connect as a user via WebSocket
    print("\n[2] Connecting as test user via WebSocket...")
    ws_url = f"{WS_ENDPOINT}?userId={TEST_USER_ID}&deviceId={TEST_DEVICE_ID}"
    ws = await websockets.connect(
        ws_url,
        additional_headers={"Authorization": f"Bearer {API_KEY}"},
    )
    print(f"  Connected (userId={TEST_USER_ID}, deviceId={TEST_DEVICE_ID})")

    try:
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

        # Step 4: Wait for response on WebSocket
        print(f"\n[4] Waiting for bot response on WebSocket (timeout {timeout_secs}s)...")
        print("-" * 60)

        chunks: list[str] = []
        start = time.time()

        try:
            while time.time() - start < timeout_secs:
                remaining = timeout_secs - (time.time() - start)
                if remaining <= 0:
                    break
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=min(remaining, 5.0))
                except asyncio.TimeoutError:
                    elapsed = int(time.time() - start)
                    if elapsed > 0 and elapsed % 10 == 0:
                        print(f"  ... waiting ({elapsed}s)")
                    continue

                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                action = frame.get("action", "")
                frame_type = frame.get("type", "")
                reply_to = frame.get("replyTo", "")
                text = frame.get("text", "")

                # Only process response frames for our message
                if action == "response" and reply_to == message_id:
                    if text:
                        chunks.append(text)
                    if frame_type == "done":
                        break
                elif action == "ping":
                    # Ignore heartbeats
                    continue
                else:
                    # Log unexpected frames for debugging
                    print(f"  [debug] frame: action={action} type={frame_type} replyTo={reply_to}")

        except websockets.ConnectionClosed:
            print("  WebSocket connection closed unexpectedly")

        print("-" * 60)
        if chunks:
            response = "".join(chunks)
            print(f"\nBot response:")
            print(response)
        else:
            print("\n[Result] No response within timeout.")
            print("  The bot may not be running or may not have processed the message.")

    finally:
        await ws.close()

    print("\n" + "=" * 60)
    print("Test complete.")


async def run_list():
    """List all active connections."""
    print("=" * 60)
    print("Active Nova WebSocket Connections")
    print("=" * 60)
    print()
    connections = list_connections()
    print_connections(connections)
    print()
    print(f"Total: {len(connections)} connection(s)")


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
    parser.add_argument(
        "--connection-id",
        help="Target bot's connectionId (from DynamoDB)",
    )
    parser.add_argument(
        "--device-id",
        help="Target bot's deviceId (from DynamoDB)",
    )
    parser.add_argument(
        "--user-id",
        help="Target bot's userId (from DynamoDB) — stable across reconnects",
    )
    parser.add_argument(
        "--source-ip",
        help="Target bot's source IP (from DynamoDB)",
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List all active connections and exit",
    )
    args = parser.parse_args()

    if args.list:
        asyncio.run(run_list())
    else:
        asyncio.run(run_test(
            args.message,
            args.timeout,
            args.connection_id,
            args.device_id,
            args.user_id,
            args.source_ip,
        ))


if __name__ == "__main__":
    main()
