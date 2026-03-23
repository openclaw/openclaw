#!/usr/bin/env python3
"""
Wait for a bot reply in a specific Telegram thread/topic using a user MTProto session.

This is used as a fallback assertion path when Bot API getUpdates is busy
(for example, the gateway already owns long-polling and tg poll returns 409).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from telethon import TelegramClient


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description="Wait for Telegram bot reply via user MTProto session")
  parser.add_argument("--api-id", type=int, required=True, help="Telegram API ID")
  parser.add_argument("--api-hash", required=True, help="Telegram API hash")
  parser.add_argument(
    "--session",
    default=str(Path(__file__).resolve().parent / "tmp" / "userbot.session"),
    help="Telethon session path",
  )
  parser.add_argument("--chat", required=True, help="Target chat username/id/invite")
  parser.add_argument("--after-id", type=int, required=True, help="Only consider messages newer than this ID")
  parser.add_argument("--contains", required=True, help="Substring expected in bot reply text")
  parser.add_argument(
    "--thread-anchor",
    type=int,
    default=0,
    help="Thread anchor message id (reply_to_top_id or reply_to_msg_id)",
  )
  parser.add_argument(
    "--sender-id",
    type=int,
    default=0,
    help="Expected sender id (bot user id). 0 means do not filter by sender.",
  )
  parser.add_argument("--timeout", type=int, default=45, help="Timeout seconds")
  parser.add_argument("--poll-interval", type=float, default=1.0, help="Polling interval seconds")
  return parser


def resolve_thread_anchor(message) -> int | None:
  reply = getattr(message, "reply_to", None)
  if not reply:
    return None
  top_id = getattr(reply, "reply_to_top_id", None)
  if top_id is not None:
    return int(top_id)
  reply_id = getattr(reply, "reply_to_msg_id", None)
  if reply_id is not None:
    return int(reply_id)
  return None


async def run() -> int:
  args = build_parser().parse_args()
  session_path = Path(args.session).expanduser()
  session_path.parent.mkdir(parents=True, exist_ok=True)

  chat_entity = int(args.chat) if args.chat.lstrip("-").isdigit() else args.chat
  deadline = time.time() + max(1, args.timeout)

  client = TelegramClient(str(session_path), args.api_id, args.api_hash)
  await client.start()
  try:
    while time.time() < deadline:
      messages = await client.get_messages(chat_entity, limit=80)
      for message in messages:
        if message.id <= args.after_id:
          continue
        if args.sender_id > 0:
          sender_id = int(getattr(message, "sender_id", 0) or 0)
          if sender_id != args.sender_id:
            continue
        text = (getattr(message, "message", "") or "").strip()
        if not text:
          continue
        if args.contains not in text:
          continue
        if args.thread_anchor > 0:
          anchor = resolve_thread_anchor(message)
          if anchor != args.thread_anchor:
            continue
        payload = {
          "chat_id": int(getattr(message, "chat_id", 0) or 0),
          "message_id": message.id,
          "sender_id": int(getattr(message, "sender_id", 0) or 0),
          "thread_anchor": resolve_thread_anchor(message),
          "text": text,
        }
        print(json.dumps(payload, ensure_ascii=True))
        return 0
      await asyncio.sleep(max(0.1, args.poll_interval))

    print(
      json.dumps(
        {
          "error": "timeout",
          "contains": args.contains,
          "after_id": args.after_id,
          "thread_anchor": args.thread_anchor or None,
        },
        ensure_ascii=True,
      ),
      file=sys.stderr,
    )
    return 1
  finally:
    await client.disconnect()


def main() -> None:
  try:
    raise SystemExit(asyncio.run(run()))
  except KeyboardInterrupt:
    raise SystemExit(130) from None
  except Exception as err:  # pragma: no cover - script-level fallback
    print(f"userbot_wait failed: {err}", file=sys.stderr)
    raise SystemExit(1) from err


if __name__ == "__main__":
  main()
