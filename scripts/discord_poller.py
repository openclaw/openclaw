#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import requests

AUDIO_EXTENSIONS = (".ogg", ".mp3", ".wav", ".m4a", ".opus", ".flac", ".aac", ".weba", ".oga")
MAX_TRACKED_ATTACHMENTS = 5000
ENTRY_PATH_PATTERN = re.compile(r"日记条目:\s*(?P<path>/\S+\.md)")
TRANSCRIPT_SECTION_PATTERN = re.compile(
    r"##\s*🎤\s*转录内容\s*(?P<body>.*?)(?:\n##\s|\n---|\Z)",
    re.DOTALL,
)

AI_DEFAULT_SYSTEM_PROMPT = (
    "你是一个友好的AI助手，名叫李巡山。"
    "你帮助用户记录和分析散步时的思考。"
    "回复要简洁自然，像一个贴心的朋友。"
    "如果用户分享了想法，给予有建设性的回应。"
    "用中文回复，保持亲切的语气。回复控制在200字以内。"
)


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def log_event(event: str, **fields: Any) -> None:
    payload = {"ts": now_iso(), "event": event, **fields}
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def bool_from_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def normalize_token(raw: str) -> str:
    token = raw.strip()
    if token.lower().startswith("bot "):
        token = token[4:].strip()
    return token


def load_dotenv_file(env_path: Path | None = None) -> dict[str, str]:
    """Load key=value pairs from a .env file.

    Searches multiple locations if no explicit path is given:
      1. ~/.openclaw/.env
      2. <cwd>/.env
      3. <script_dir>/../.env  (i.e. the repo root when script lives in scripts/)
    """
    candidates: list[Path] = []
    if env_path is not None:
        candidates.append(env_path)
    else:
        candidates.append(Path.home() / ".openclaw" / ".env")
        candidates.append(Path.cwd() / ".env")
        candidates.append(Path(__file__).resolve().parent.parent / ".env")

    result: dict[str, str] = {}
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            for line in candidate.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].strip()
                if "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                if key not in result:  # first found wins
                    result[key] = value.strip()
        except Exception:  # noqa: BLE001
            continue
    return result


def sanitize_filename(name: str) -> str:
    if not name:
        return "audio.ogg"
    base = Path(name).name
    return re.sub(r"[^A-Za-z0-9._-]", "_", base)


def is_audio_attachment(attachment: dict[str, Any]) -> bool:
    content_type = (attachment.get("content_type") or attachment.get("contentType") or "").lower()
    if content_type.startswith("audio/"):
        return True
    filename = (attachment.get("filename") or "").lower()
    return filename.endswith(AUDIO_EXTENSIONS)


def parse_args() -> argparse.Namespace:
    home = Path.home()
    default_state_dir = Path(os.getenv("OPENCLAW_STATE_DIR", str(home / ".openclaw")))
    parser = argparse.ArgumentParser(description="Discord polling worker for WalkThink audio auto-processing.")
    parser.add_argument(
        "--channel-id",
        default=os.getenv("DISCORD_POLLER_CHANNEL_ID", ""),
        help="Comma-separated Discord channel IDs to monitor",
    )
    parser.add_argument(
        "--token-env",
        default=os.getenv("DISCORD_POLLER_TOKEN_ENV", "DISCORD_TOKEN"),
        help="Environment variable name that stores the bot token",
    )
    parser.add_argument("--interval-sec", type=float, default=float(os.getenv("DISCORD_POLLER_INTERVAL_SEC", "5")))
    parser.add_argument("--fetch-limit", type=int, default=int(os.getenv("DISCORD_POLLER_FETCH_LIMIT", "50")))
    parser.add_argument(
        "--state-file",
        default=os.getenv("DISCORD_POLLER_STATE_FILE", str(default_state_dir / "discord_poller_state.json")),
    )
    parser.add_argument(
        "--legacy-last-id-file",
        default=os.getenv("DISCORD_POLLER_LEGACY_LAST_ID_FILE", str(default_state_dir / "discord_last_msg_id.txt")),
    )
    parser.add_argument(
        "--inbound-dir",
        default=os.getenv("DISCORD_POLLER_INBOUND_DIR", str(default_state_dir / "media" / "inbound")),
    )
    parser.add_argument(
        "--auto-process-python",
        default=os.getenv("WALKTHINK_PYTHON", "/Users/lizhihong/WalkThink/.venv/bin/python"),
    )
    parser.add_argument(
        "--auto-process-script",
        default=os.getenv("WALKTHINK_AUTO_PROCESS_SCRIPT", "/Users/lizhihong/WalkThink/scripts/auto_process.py"),
    )
    parser.add_argument(
        "--walkthink-dir",
        default=os.getenv("WALKTHINK_DIR", "/Users/lizhihong/WalkThink"),
    )
    parser.add_argument(
        "--catch-up-initial-batch",
        action=argparse.BooleanOptionalAction,
        default=bool_from_env("DISCORD_POLLER_CATCH_UP_INITIAL_BATCH", True),
    )
    parser.add_argument(
        "--heartbeat-sec",
        type=float,
        default=float(os.getenv("DISCORD_POLLER_HEARTBEAT_SEC", "60")),
    )
    parser.add_argument(
        "--process-timeout-sec",
        type=float,
        default=float(os.getenv("DISCORD_POLLER_PROCESS_TIMEOUT_SEC", "120")),
    )
    parser.add_argument(
        "--openclaw-config",
        default=os.getenv("OPENCLAW_CONFIG", str(default_state_dir / "openclaw.json")),
    )
    parser.add_argument(
        "--ai-api-key-env",
        default=os.getenv("DISCORD_POLLER_AI_KEY_ENV", "OPENROUTER_API_KEY"),
        help="Env var name for AI API key",
    )
    parser.add_argument("--ai-base-url", default=os.getenv("AI_BASE_URL", "https://openrouter.ai/api/v1"))
    parser.add_argument("--ai-model", default=os.getenv("AI_MODEL", "deepseek/deepseek-chat"))
    parser.add_argument("--ai-system-prompt", default=os.getenv("AI_SYSTEM_PROMPT", ""))
    parser.add_argument(
        "--enable-ai-reply",
        action=argparse.BooleanOptionalAction,
        default=bool_from_env("DISCORD_POLLER_AI_REPLY", True),
    )
    parser.add_argument(
        "--ai-reply-max-tokens",
        type=int,
        default=int(os.getenv("AI_REPLY_MAX_TOKENS", "800")),
    )
    return parser.parse_args()


def load_state(state_file: Path, legacy_last_id_file: Path) -> dict[str, Any]:
    if state_file.exists():
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("last_message_id", "0")
                data.setdefault("processed_attachment_keys", [])
                return data
        except Exception as err:  # noqa: BLE001
            log_event("state_read_failed", error=str(err), state_file=str(state_file))
    if legacy_last_id_file.exists():
        try:
            legacy_last_id = legacy_last_id_file.read_text(encoding="utf-8").strip() or "0"
            return {"last_message_id": legacy_last_id, "processed_attachment_keys": []}
        except Exception as err:  # noqa: BLE001
            log_event("legacy_state_read_failed", error=str(err), legacy_file=str(legacy_last_id_file))
    return {"last_message_id": "0", "processed_attachment_keys": []}


def save_state(state_file: Path, state: dict[str, Any]) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    temp_file = state_file.with_suffix(state_file.suffix + ".tmp")
    temp_file.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_file.replace(state_file)


def get_messages(
    session: requests.Session,
    channel_id: str,
    fetch_limit: int,
    after_id: str | None = None,
) -> list[dict[str, Any]]:
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    params: dict[str, Any] = {"limit": max(1, min(fetch_limit, 100))}
    if after_id and after_id != "0":
        params["after"] = after_id
    response = session.get(url, params=params, timeout=20)
    if response.status_code == 429:
        retry_after = 1.0
        try:
            retry_after = float(response.json().get("retry_after", 1.0))
        except Exception:  # noqa: BLE001
            pass
        log_event("discord_rate_limited", retry_after=retry_after)
        time.sleep(max(0.1, retry_after))
        return []
    if response.status_code != 200:
        snippet = response.text[:200].replace("\n", " ")
        log_event("discord_fetch_failed", status=response.status_code, body=snippet)
        return []
    payload = response.json()
    if not isinstance(payload, list):
        return []
    return payload


def send_message(session: requests.Session, channel_id: str, content: str) -> None:
    if not content:
        return
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    resp = session.post(url, json={"content": content[:1900]}, timeout=20)
    if resp.status_code >= 300:
        log_event("discord_send_failed", status=resp.status_code, body=resp.text[:200].replace("\n", " "))


def download_attachment(session: requests.Session, url: str, local_path: Path) -> None:
    with session.get(url, timeout=90, stream=True) as resp:
        resp.raise_for_status()
        with local_path.open("wb") as handle:
            for chunk in resp.iter_content(chunk_size=1024 * 64):
                if chunk:
                    handle.write(chunk)


def run_auto_process(args: argparse.Namespace, local_path: Path) -> subprocess.CompletedProcess[str]:
    cmd = [
        args.auto_process_python,
        args.auto_process_script,
        str(local_path),
        "--source",
        "discord",
    ]
    return subprocess.run(
        cmd,
        cwd=args.walkthink_dir,
        capture_output=True,
        text=True,
        timeout=max(30.0, args.process_timeout_sec),
        check=False,
    )


def parse_entry_path(result: subprocess.CompletedProcess[str]) -> Path | None:
    for stream in (result.stdout or "", result.stderr or ""):
        for line in reversed(stream.splitlines()):
            match = ENTRY_PATH_PATTERN.search(line)
            if not match:
                continue
            entry_path = Path(match.group("path"))
            if entry_path.exists():
                return entry_path
    return None


def load_transcript_preview(entry_path: Path | None, max_chars: int = 650) -> str:
    if not entry_path:
        return ""
    try:
        raw = entry_path.read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001
        return ""
    match = TRANSCRIPT_SECTION_PATTERN.search(raw)
    if not match:
        return ""
    body = match.group("body").strip()
    if not body:
        return ""
    # Strip timestamp tags for better readability in channel replies.
    body = re.sub(r"\[[0-9:.]+,[0-9:.]+\]\s*", "", body)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    if len(body) > max_chars:
        body = body[: max_chars - 1].rstrip() + "…"
    return body


def build_success_message(filename: str, entry_path: Path | None, transcript_preview: str) -> str:
    lines = [f"✅ 已自动处理语音: `{filename}`"]
    if transcript_preview:
        safe_preview = transcript_preview.replace("```", "'''")
        lines.append(f"📝 转录摘录:\n```text\n{safe_preview}\n```")
    if entry_path:
        lines.append(f"📁 条目: `{entry_path}`")
    return "\n".join(lines)


def ai_chat_reply(
    ai_session: requests.Session,
    base_url: str,
    model: str,
    system_prompt: str,
    user_message: str,
    max_tokens: int = 800,
    timeout: float = 30.0,
) -> str:
    """Call an OpenAI-compatible chat API and return the assistant reply."""
    url = f"{base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }
    try:
        resp = ai_session.post(url, json=payload, timeout=timeout)
        if resp.status_code != 200:
            log_event("ai_reply_api_failed", status=resp.status_code, body=resp.text[:200])
            return ""
        data = resp.json()
        choices = data.get("choices", [])
        if not choices:
            return ""
        return (choices[0].get("message", {}).get("content", "") or "").strip()
    except Exception as err:  # noqa: BLE001
        log_event("ai_reply_error", error=str(err))
        return ""


def update_last_id(last_id: str, candidate_id: str) -> str:
    if int(candidate_id) > int(last_id):
        return candidate_id
    return last_id


def extract_message_ids(messages: list[dict[str, Any]]) -> list[int]:
    values: list[int] = []
    for message in messages:
        message_id = message.get("id")
        if not message_id:
            continue
        try:
            values.append(int(message_id))
        except (TypeError, ValueError):
            continue
    return values


def mark_processed_attachment_key(
    dedupe_key: str,
    processed_keys: list[str],
    processed_key_set: set[str],
) -> None:
    if dedupe_key in processed_key_set:
        return
    processed_keys.append(dedupe_key)
    processed_key_set.add(dedupe_key)
    if len(processed_keys) > MAX_TRACKED_ATTACHMENTS:
        drop_count = len(processed_keys) - MAX_TRACKED_ATTACHMENTS
        removed = processed_keys[:drop_count]
        del processed_keys[:drop_count]
        for key in removed:
            processed_key_set.discard(key)


def load_discord_token_from_openclaw_config(config_path: Path) -> str:
    if not config_path.exists():
        return ""
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return ""
    token = (
        payload.get("channels", {})
        .get("discord", {})
        .get("token", "")
    )
    if not isinstance(token, str):
        return ""
    return token.strip()


def main() -> int:
    args = parse_args()
    token_raw = (
        os.getenv(args.token_env)
        or os.getenv("DISCORD_BOT_TOKEN")
        or load_discord_token_from_openclaw_config(Path(args.openclaw_config))
        or ""
    )
    token = normalize_token(token_raw)
    channel_ids = [cid.strip() for cid in args.channel_id.split(",") if cid.strip()]
    if not token:
        print(f"Missing token env. Set {args.token_env} (or DISCORD_BOT_TOKEN).", file=sys.stderr)
        return 2
    if not channel_ids:
        print("Missing channel id. Set --channel-id or DISCORD_POLLER_CHANNEL_ID.", file=sys.stderr)
        return 2

    state_file = Path(args.state_file)
    legacy_last_id_file = Path(args.legacy_last_id_file)
    inbound_dir = Path(args.inbound_dir)
    inbound_dir.mkdir(parents=True, exist_ok=True)

    state = load_state(state_file, legacy_last_id_file)
    processed_keys = [str(x) for x in state.get("processed_attachment_keys", []) if x]
    if len(processed_keys) > MAX_TRACKED_ATTACHMENTS:
        processed_keys = processed_keys[-MAX_TRACKED_ATTACHMENTS:]
    processed_key_set = set(processed_keys)

    # Migrate legacy single-channel state to per-channel state
    per_channel: dict[str, str] = state.get("per_channel_last_id", {})
    if not per_channel and state.get("last_message_id", "0") != "0":
        # Legacy: assign old last_message_id to the first channel
        legacy_last = str(state.get("last_message_id", "0") or "0")
        per_channel[channel_ids[0]] = legacy_last
        log_event("state_migrated_to_multi_channel", legacy_last_id=legacy_last, channel=channel_ids[0])
    for cid in channel_ids:
        per_channel.setdefault(cid, "0")

    session = requests.Session()
    session.headers.update(
        {
            "Authorization": f"Bot {token}",
            "User-Agent": "OpenClawDiscordPoller/1.0",
        }
    )

    # --- AI reply setup ---
    ai_session: requests.Session | None = None
    if args.enable_ai_reply:
        dotenv = load_dotenv_file()
        ai_api_key = os.getenv(args.ai_api_key_env) or dotenv.get(args.ai_api_key_env, "")
        if ai_api_key:
            ai_session = requests.Session()
            ai_session.headers.update({
                "Authorization": f"Bearer {ai_api_key}",
                "Content-Type": "application/json",
            })
            log_event("ai_reply_enabled", model=args.ai_model)
        else:
            log_event("ai_reply_disabled", reason="no_api_key", key_env=args.ai_api_key_env)
    ai_system_prompt = args.ai_system_prompt or AI_DEFAULT_SYSTEM_PROMPT

    metrics: dict[str, int] = {
        "loops": 0,
        "messages_seen": 0,
        "audio_found": 0,
        "audio_processed": 0,
        "audio_failed": 0,
        "audio_skipped_duplicate": 0,
        "ping_replied": 0,
        "ai_replied": 0,
    }

    # Initialize each channel
    for cid in channel_ids:
        last_id = per_channel[cid]
        if last_id == "0":
            latest = get_messages(session, cid, args.fetch_limit, after_id=None)
            latest_ids = extract_message_ids(latest)
            if latest_ids and args.catch_up_initial_batch:
                oldest_id = min(latest_ids)
                per_channel[cid] = str(max(0, oldest_id - 1))
                log_event("channel_initialized_catchup", channel_id=cid, last_message_id=per_channel[cid], seeded_count=len(latest))
            elif latest_ids:
                per_channel[cid] = str(max(latest_ids))
                log_event("channel_initialized_skip_history", channel_id=cid, last_message_id=per_channel[cid], seeded_count=len(latest))
        else:
            log_event("channel_resume", channel_id=cid, last_message_id=last_id)

    state["per_channel_last_id"] = per_channel
    state["processed_attachment_keys"] = processed_keys[-MAX_TRACKED_ATTACHMENTS:]
    save_state(state_file, state)

    log_event("poller_started", channel_ids=channel_ids, channel_count=len(channel_ids), interval_sec=args.interval_sec)
    next_heartbeat = time.time() + max(1.0, args.heartbeat_sec)

    try:
        while True:
            metrics["loops"] += 1
            try:
              for channel_id in channel_ids:
                last_id = per_channel.get(channel_id, "0")
                messages = get_messages(session, channel_id, args.fetch_limit, after_id=last_id)
                if messages:
                    messages.sort(key=lambda msg: int(msg.get("id", "0")))
                state_changed = False
                for msg in messages:
                    msg_id = str(msg.get("id", "0"))
                    if msg_id == "0":
                        continue
                    last_id = update_last_id(last_id, msg_id)
                    state_changed = True

                    metrics["messages_seen"] += 1
                    author = msg.get("author") or {}
                    if author.get("bot"):
                        continue

                    content = str(msg.get("content") or "")
                    attachments = msg.get("attachments") or []
                    msg_has_audio = any(isinstance(a, dict) and is_audio_attachment(a) for a in attachments)
                    for attachment in attachments:
                        if not isinstance(attachment, dict):
                            continue
                        if not is_audio_attachment(attachment):
                            continue

                        metrics["audio_found"] += 1
                        attachment_id = str(attachment.get("id") or attachment.get("url") or attachment.get("filename") or "unknown")
                        dedupe_key = f"{msg_id}:{attachment_id}"
                        if dedupe_key in processed_key_set:
                            metrics["audio_skipped_duplicate"] += 1
                            continue

                        filename = sanitize_filename(str(attachment.get("filename") or "audio.ogg"))
                        local_path = inbound_dir / f"{msg_id}_{filename}"
                        source_url = str(attachment.get("url") or "")
                        if not source_url:
                            metrics["audio_failed"] += 1
                            log_event("audio_missing_url", message_id=msg_id, filename=filename)
                            continue

                        log_event("audio_download_start", message_id=msg_id, filename=filename)
                        send_message(session, channel_id, f"🎙️ 收到语音，开始处理: `{filename}`")
                        try:
                            download_attachment(session, source_url, local_path)
                        except Exception as err:  # noqa: BLE001
                            metrics["audio_failed"] += 1
                            log_event("audio_download_failed", message_id=msg_id, filename=filename, error=str(err))
                            send_message(session, channel_id, f"⚠️ 下载失败: `{filename}`")
                            continue

                        try:
                            result = run_auto_process(args, local_path)
                        except subprocess.TimeoutExpired as err:
                            metrics["audio_failed"] += 1
                            send_message(session, channel_id, f"⚠️ 处理超时，已跳过: `{filename}`")
                            log_event(
                                "audio_process_timeout",
                                message_id=msg_id,
                                filename=filename,
                                timeout_sec=max(30.0, args.process_timeout_sec),
                                error=str(err),
                            )
                            mark_processed_attachment_key(dedupe_key, processed_keys, processed_key_set)
                            state_changed = True
                            continue
                        except Exception as err:  # noqa: BLE001
                            metrics["audio_failed"] += 1
                            log_event("auto_process_exec_failed", message_id=msg_id, filename=filename, error=str(err))
                            send_message(session, channel_id, f"⚠️ 执行失败: `{filename}`")
                            continue

                        if result.returncode == 0:
                            metrics["audio_processed"] += 1
                            entry_path = parse_entry_path(result)
                            transcript_preview = load_transcript_preview(entry_path)
                            send_message(
                                session,
                                channel_id,
                                build_success_message(filename, entry_path, transcript_preview),
                            )
                            log_event("audio_processed", message_id=msg_id, filename=filename)
                        else:
                            metrics["audio_failed"] += 1
                            stderr_tail = (result.stderr or "")[-500:].replace("`", "'")
                            stdout_tail = (result.stdout or "")[-300:].replace("`", "'")
                            error_tail = stderr_tail or stdout_tail or "无详细输出"
                            send_message(session, channel_id, f"⚠️ 处理出错: `{filename}`\n```{error_tail}```")
                            log_event(
                                "audio_process_failed",
                                message_id=msg_id,
                                filename=filename,
                                return_code=result.returncode,
                                stdout_tail=stdout_tail,
                                stderr_tail=stderr_tail,
                            )

                        mark_processed_attachment_key(dedupe_key, processed_keys, processed_key_set)
                        state_changed = True

                    if content.strip().lower() == "ping":
                        send_message(session, channel_id, "pong (via poller)")
                        metrics["ping_replied"] += 1
                    elif content.strip() and ai_session is not None and not msg_has_audio:
                        log_event("ai_reply_start", message_id=msg_id, content_preview=content[:50])
                        ai_response = ai_chat_reply(
                            ai_session,
                            args.ai_base_url,
                            args.ai_model,
                            ai_system_prompt,
                            content.strip(),
                            max_tokens=args.ai_reply_max_tokens,
                        )
                        if ai_response:
                            send_message(session, channel_id, ai_response)
                            metrics["ai_replied"] += 1
                            log_event("ai_replied", message_id=msg_id, response_len=len(ai_response))

                if state_changed:
                    per_channel[channel_id] = last_id
                    state["per_channel_last_id"] = per_channel
                    state["processed_attachment_keys"] = processed_keys
                    save_state(state_file, state)
            except Exception as err:  # noqa: BLE001
                log_event("poll_loop_error", channel_id=channel_id, error=str(err))

            if time.time() >= next_heartbeat:
                log_event("heartbeat", channels=len(channel_ids), **metrics)
                next_heartbeat = time.time() + max(1.0, args.heartbeat_sec)

            time.sleep(max(0.2, args.interval_sec))
    except KeyboardInterrupt:
        log_event("poller_stopped", reason="keyboard_interrupt", last_message_id=last_id, **metrics)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
