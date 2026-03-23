#!/usr/bin/env python3
"""
Minimal MTProto user-send helper for Telegram E2E flows.

This script intentionally sends messages as a user account (not Bot API).
Thread/topic targeting is done by replying to a known message ID that belongs
to the target thread/topic.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from telethon import TelegramClient


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description="Send Telegram message via user MTProto session")
  parser.add_argument("--api-id", type=int, required=True, help="Telegram API ID")
  parser.add_argument("--api-hash", required=True, help="Telegram API hash")
  parser.add_argument(
    "--session",
    default=str(Path(__file__).resolve().parent / "tmp" / "userbot.session"),
    help="Telethon session path",
  )
  parser.add_argument("--chat", required=True, help="Target chat username/id/invite")
  parser.add_argument("--text", required=True, help="Message text")
  parser.add_argument(
    "--reply-to",
    type=int,
    default=0,
    help="Reply-to message id (used to target a thread/topic)",
  )
  return parser


async def run() -> int:
  args = build_parser().parse_args()
  session_path = Path(args.session).expanduser()
  session_path.parent.mkdir(parents=True, exist_ok=True)

  chat_entity = int(args.chat) if args.chat.lstrip("-").isdigit() else args.chat

  client = TelegramClient(str(session_path), args.api_id, args.api_hash)
  await client.start()
  try:
    sent = await client.send_message(
      entity=chat_entity,
      message=args.text,
      reply_to=args.reply_to or None,
    )
    chat = await sent.get_chat()
    payload = {
      "chat_id": getattr(chat, "id", None),
      "message_id": sent.id,
      "reply_to": args.reply_to or None,
      "text": args.text,
    }
    print(json.dumps(payload, ensure_ascii=True))
    return 0
  finally:
    await client.disconnect()


def main() -> None:
  try:
    raise SystemExit(asyncio.run(run()))
  except KeyboardInterrupt:
    raise SystemExit(130) from None
  except Exception as err:  # pragma: no cover - script-level fallback
    print(f"userbot_send failed: {err}", file=sys.stderr)
    raise SystemExit(1) from err


if __name__ == "__main__":
  main()
