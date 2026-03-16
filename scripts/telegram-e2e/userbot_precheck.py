#!/usr/bin/env python3
"""
Canonical Telegram userbot precheck.

This script validates the minimum requirements for reliable inbound MTProto
message sends in live Telegram checks:
1) credentials present,
2) session file present/readable,
3) session authorized,
4) chat resolvable.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from pathlib import Path


EXIT_MISSING_CREDS = 10
EXIT_MISSING_SESSION = 11
EXIT_UNAUTHORIZED = 12
EXIT_CHAT_NOT_RESOLVABLE = 13
EXIT_TELETHON_MISSING = 14
EXIT_PRECHECK_FAILED = 15


def fail(code: str, message: str, exit_code: int) -> int:
  print(f"{code}: {message}", file=sys.stderr)
  return exit_code


def sanitize_error_text(raw: str) -> str:
  text = raw.replace("\n", " ").replace("\r", " ").strip()
  for secret in (
    os.environ.get("TELEGRAM_API_HASH", ""),
    os.environ.get("TG_BOT_TOKEN", ""),
    os.environ.get("TELEGRAM_BOT_TOKEN", ""),
  ):
    if secret:
      text = text.replace(secret, "<redacted>")
  text = re.sub(r"\s+", " ", text).strip()
  if not text:
    return "unexpected error"
  return text[:240]


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description="Precheck Telegram userbot session and chat resolution")
  parser.add_argument("--api-id", type=int, required=True, help="Telegram API ID")
  parser.add_argument("--api-hash", required=True, help="Telegram API hash")
  parser.add_argument("--session", required=True, help="Telethon session file path")
  parser.add_argument("--chat", required=True, help="Target chat username/id/invite")
  return parser


async def run() -> int:
  args = build_parser().parse_args()

  api_hash = (args.api_hash or "").strip()
  chat_raw = (args.chat or "").strip()
  if args.api_id <= 0 or not api_hash or not chat_raw:
    return fail("E_MISSING_CREDS", "missing TELEGRAM_API_ID/TELEGRAM_API_HASH or chat value.", EXIT_MISSING_CREDS)

  session_path = Path(args.session).expanduser()
  if not session_path.exists() or not session_path.is_file():
    return fail(
      "E_MISSING_SESSION",
      f"session file not found at {session_path}. Set USERBOT_SESSION or sync scripts/telegram-e2e/tmp/userbot.session.",
      EXIT_MISSING_SESSION,
    )
  if not os.access(session_path, os.R_OK):
    return fail("E_MISSING_SESSION", f"session file is not readable: {session_path}", EXIT_MISSING_SESSION)

  try:
    from telethon import TelegramClient
  except Exception:
    return fail(
      "E_TELETHON_MISSING",
      "telethon is not installed. Run scripts/telegram-e2e/userbot-send-live.sh to auto-bootstrap.",
      EXIT_TELETHON_MISSING,
    )

  chat_entity: int | str = chat_raw
  if chat_raw.lstrip("-").isdigit():
    chat_entity = int(chat_raw)

  client = TelegramClient(str(session_path), args.api_id, api_hash)
  try:
    await client.connect()
    if not await client.is_user_authorized():
      return fail(
        "E_UNAUTHORIZED_SESSION",
        "userbot session is not authorized. Re-auth once via interactive userbot_send.py run.",
        EXIT_UNAUTHORIZED,
      )

    try:
      resolved = await client.get_input_entity(chat_entity)
    except Exception as err:
      detail = sanitize_error_text(str(err))
      return fail(
        "E_CHAT_NOT_RESOLVABLE",
        f"unable to resolve chat target. {detail}",
        EXIT_CHAT_NOT_RESOLVABLE,
      )

    me = await client.get_me()
    user_id = int(getattr(me, "id", 0) or 0)
    peer_type = type(resolved).__name__
    print(f"userbot_precheck: ok session={session_path.name} user_id={user_id} peer={peer_type}")
    return 0
  except Exception as err:
    detail = sanitize_error_text(str(err))
    return fail("E_UNAUTHORIZED_SESSION", f"session check failed. {detail}", EXIT_UNAUTHORIZED)
  finally:
    await client.disconnect()


def main() -> None:
  try:
    raise SystemExit(asyncio.run(run()))
  except KeyboardInterrupt:
    raise SystemExit(130) from None
  except SystemExit:
    raise
  except Exception as err:  # pragma: no cover - script-level fallback
    detail = sanitize_error_text(str(err))
    raise SystemExit(f"E_PRECHECK_FAILED: {detail}") from err


if __name__ == "__main__":
  main()
