#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import sys
import time

from telethon import TelegramClient, functions
from telethon.errors import FloodWaitError

from userbot_guard import acquire_session_guard, load_env_file, sanitize_error_text, SessionGuardError

DEFAULT_CHAT = "@Artem_jarvis_exec_bot"
DEFAULT_BASELINE_MODEL = "openai-codex/gpt-5.3-codex"
DEFAULT_TARGET_MODEL = "anthropic/claude-sonnet-4-6"
DEFAULT_TIMEOUT_SECONDS = 40


def resolve_bot_id(env: dict[str, str], fallback_id: int) -> int:
  # In forum groups, `get_entity(chat)` returns the group peer, not the bot.
  # Tester bot tokens always encode the bot user id before the colon, so use
  # that when available to keep sender matching correct across group topics.
  token = (os.environ.get("TELEGRAM_BOT_TOKEN") or env.get("TG_BOT_TOKEN") or "").strip()
  token_id = token.split(":", 1)[0] if ":" in token else ""
  if token_id.isdigit():
    return int(token_id)
  return fallback_id


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(
    description="Probe Telegram thread/topic inheritance with MTProto (legacy filename)"
  )
  parser.add_argument("--chat", default="", help="Bot chat username or id")
  parser.add_argument("--baseline-model", default="", help="Model to establish before creating control thread Z")
  parser.add_argument("--target-model", default="", help="Model to set in thread X")
  parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS, help="Reply wait timeout seconds")
  return parser


def parse_status(text: str) -> dict[str, str | None]:
  model = None
  think = None
  for line in text.splitlines():
    if line.startswith("🧠 Model: "):
      model = line.split("🧠 Model: ", 1)[1].split(" · ", 1)[0].strip()
    if "Think:" in line:
      think = line.split("Think:", 1)[1].split("·", 1)[0].strip()
  return {"model": model, "think": think, "raw": text}


def build_message_diag(message) -> dict[str, object | None]:
  reply_to = getattr(message, "reply_to", None)
  return {
    "id": getattr(message, "id", None),
    "sender_id": getattr(message, "sender_id", None),
    "text": ((getattr(message, "message", "") or "").strip())[:160],
    "reply_to_msg_id": getattr(reply_to, "reply_to_msg_id", None),
    "reply_to_top_id": getattr(reply_to, "reply_to_top_id", None),
    "forum_topic": getattr(reply_to, "forum_topic", None),
    "direct_topic_id": getattr(getattr(message, "direct_messages_topic", None), "topic_id", None),
  }


def resolve_match_reason(message, *, bot_id: int, anchor: int, sent_id: int) -> tuple[bool, str]:
  reply_to = getattr(message, "reply_to", None)
  sender_id = int(getattr(message, "sender_id", 0) or 0)
  if sender_id != bot_id:
    return False, f"sender_mismatch:{sender_id}"

  top_id = getattr(reply_to, "reply_to_top_id", None)
  if top_id == anchor:
    return True, "reply_to_top_id"

  reply_id = getattr(reply_to, "reply_to_msg_id", None)
  if reply_id == sent_id:
    return True, "reply_to_msg_id=sent"
  if reply_id == anchor:
    return True, "reply_to_msg_id=anchor"

  direct_topic = getattr(getattr(message, "direct_messages_topic", None), "topic_id", None)
  if direct_topic == anchor:
    return True, "direct_messages_topic"

  return False, "thread_mismatch"


async def create_topic(client: TelegramClient, chat: int | str, title: str) -> int:
  print(f"create_topic\t{title}", flush=True)
  try:
    updates = await client(functions.messages.CreateForumTopicRequest(peer=chat, title=title))
  except FloodWaitError as exc:
    print(f"flood_wait\tcreate_topic\t{exc.seconds}", flush=True)
    raise
  for update in getattr(updates, "updates", []) or []:
    message = getattr(update, "message", None)
    action = getattr(message, "action", None)
    if action and action.__class__.__name__ == "MessageActionTopicCreate":
      print(f"topic_anchor\t{title}\t{message.id}", flush=True)
      return message.id
  raise RuntimeError(f"no topic anchor for {title}")


async def wait_for_topic_reply(
  client: TelegramClient,
  *,
  chat: int | str,
  bot_id: int,
  anchor: int,
  sent_id: int,
  timeout_seconds: int,
):
  # Telegram DM threaded replies can surface through multiple reply shapes.
  # We keep diagnostics for ignored candidates so false negatives are obvious.
  deadline = time.time() + timeout_seconds
  ignored: list[dict[str, object | None]] = []
  seen_ids: set[int] = set()
  while time.time() < deadline:
    async for message in client.iter_messages(chat, limit=80):
      if message.id <= sent_id or message.id in seen_ids:
        continue
      seen_ids.add(message.id)
      matched, reason = resolve_match_reason(message, bot_id=bot_id, anchor=anchor, sent_id=sent_id)
      if matched:
        print(f"reply_match\t{anchor}\t{message.id}\t{reason}", flush=True)
        return message, ignored
      diag = build_message_diag(message)
      diag["ignored_reason"] = reason
      ignored.append(diag)
    await asyncio.sleep(1)
  return None, ignored[-10:]


async def send_topic_command(
  client: TelegramClient,
  *,
  chat: int | str,
  bot_id: int,
  anchor: int,
  text: str,
  timeout_seconds: int,
):
  print(f"send\t{anchor}\t{text}", flush=True)
  sent = await client.send_message(chat, text, reply_to=anchor)
  reply, ignored = await wait_for_topic_reply(
    client,
    chat=chat,
    bot_id=bot_id,
    anchor=anchor,
    sent_id=sent.id,
    timeout_seconds=timeout_seconds,
  )
  print(
    f"reply\t{anchor}\t{getattr(reply, 'id', None)}\t{((reply.message or '')[:80] if reply else None)}",
    flush=True,
  )
  if not reply:
    print(
      json.dumps(
        {
          "diagnostic": "reply_timeout",
          "anchor": anchor,
          "sent_id": sent.id,
          "text": text,
          "ignored_recent": ignored,
        },
        ensure_ascii=False,
      ),
      flush=True,
    )
  return sent, reply


async def main() -> int:
  args = build_parser().parse_args()
  env = load_env_file(pathlib.Path("scripts/telegram-e2e/.env.local"))
  chat_raw = (args.chat or env.get("TG_DM_CHAT_ID") or DEFAULT_CHAT).strip()
  baseline_model = (
    args.baseline_model or env.get("TG_PROBE_BASELINE_MODEL") or DEFAULT_BASELINE_MODEL
  ).strip()
  target_model = (args.target_model or env.get("TG_PROBE_MODEL") or DEFAULT_TARGET_MODEL).strip()
  session_raw = env.get("USERBOT_SESSION") or "scripts/telegram-e2e/tmp/userbot.session"
  session_path = pathlib.Path(session_raw).expanduser()

  if not env.get("TELEGRAM_API_ID") or not env.get("TELEGRAM_API_HASH"):
    print("E_MISSING_CREDS: TELEGRAM_API_ID/TELEGRAM_API_HASH missing in scripts/telegram-e2e/.env.local", file=sys.stderr)
    return 1

  chat: int | str = int(chat_raw) if chat_raw.lstrip("-").isdigit() else chat_raw
  client = TelegramClient(
    str(session_path),
    int(env["TELEGRAM_API_ID"]),
    env["TELEGRAM_API_HASH"],
    flood_sleep_threshold=0,
  )

  try:
    with acquire_session_guard(session_path):
      await client.connect()
      print("connected", flush=True)
      bot_entity = await client.get_entity(chat)
      bot_id = resolve_bot_id(env, int(getattr(bot_entity, "id", 0) or 0))
      print(
        json.dumps(
          {
            "bot_identity": {
              "chat": chat_raw,
              "bot_id": bot_id,
              "bot_username": getattr(bot_entity, "username", None),
              "bot_name": getattr(bot_entity, "first_name", None),
            }
          },
          ensure_ascii=False,
        ),
        flush=True,
      )

      stamp = int(time.time())

      # Establish a known baseline before creating the control topic. Without
      # this, older topics can legitimately match the target if a previous run
      # already changed the chat's future-thread default.
      baseline_anchor = await create_topic(client, chat, f"E2E BASE {stamp}")
      _, baseline_model_reply = await send_topic_command(
        client,
        chat=chat,
        bot_id=bot_id,
        anchor=baseline_anchor,
        text=f"/model {baseline_model}",
        timeout_seconds=args.timeout,
      )
      _, baseline_think_reply = await send_topic_command(
        client,
        chat=chat,
        bot_id=bot_id,
        anchor=baseline_anchor,
        text="/think medium",
        timeout_seconds=args.timeout,
      )

      # Create Z under baseline A. If inheritance is implemented correctly,
      # this pre-existing topic must keep A even after X changes the parent
      # future-thread default to B.
      z_anchor = await create_topic(client, chat, f"E2E Z {stamp}")
      x_anchor = await create_topic(client, chat, f"E2E X {stamp}")

      _, model_reply = await send_topic_command(
        client,
        chat=chat,
        bot_id=bot_id,
        anchor=x_anchor,
        text=f"/model {target_model}",
        timeout_seconds=args.timeout,
      )
      _, think_reply = await send_topic_command(
        client,
        chat=chat,
        bot_id=bot_id,
        anchor=x_anchor,
        text="/think off",
        timeout_seconds=args.timeout,
      )
      _, x_status_reply = await send_topic_command(
        client,
        chat=chat,
        bot_id=bot_id,
        anchor=x_anchor,
        text="/status",
        timeout_seconds=args.timeout,
      )

      # Create Y after the changes so it should inherit X's future-thread default.
      y_anchor = await create_topic(client, chat, f"E2E Y {stamp}")
      _, y_status_reply = await send_topic_command(
        client,
        chat=chat,
        bot_id=bot_id,
        anchor=y_anchor,
        text="/status",
        timeout_seconds=args.timeout,
      )
      _, z_status_reply = await send_topic_command(
        client,
        chat=chat,
        bot_id=bot_id,
        anchor=z_anchor,
        text="/status",
        timeout_seconds=args.timeout,
      )

      result = {
        "anchors": {"baseline": baseline_anchor, "x": x_anchor, "y": y_anchor, "z": z_anchor},
        "baseline_model_ack": baseline_model_reply.message if baseline_model_reply else None,
        "baseline_think_ack": baseline_think_reply.message if baseline_think_reply else None,
        "model_ack": model_reply.message if model_reply else None,
        "think_ack": think_reply.message if think_reply else None,
        "x_status": parse_status(x_status_reply.message) if x_status_reply else None,
        "y_status": parse_status(y_status_reply.message) if y_status_reply else None,
        "z_status": parse_status(z_status_reply.message) if z_status_reply else None,
      }
      print(json.dumps(result, ensure_ascii=False, indent=2))
      return 0
  except SessionGuardError as err:
    print(f"E_SESSION_BUSY: {err}", file=sys.stderr)
    return 1
  except Exception as err:
    print(f"E_PROBE_FAILED: {sanitize_error_text(str(err))}", file=sys.stderr)
    return 1
  finally:
    await client.disconnect()


if __name__ == "__main__":
  raise SystemExit(asyncio.run(main()))
