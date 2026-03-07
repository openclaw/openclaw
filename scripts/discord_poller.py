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
MAX_RECENT_AUDIO_EVENTS = 30
DEFAULT_RETRY_BASE_SEC = 60.0
DEFAULT_RETRY_MAX_SEC = 30 * 60.0
DEFAULT_RETRY_NOTIFY_SEC = 30 * 60.0
ENTRY_PATH_PATTERN = re.compile(r"日记条目:\s*(?P<path>/\S+\.md)")
TRANSCRIPT_SECTION_PATTERN = re.compile(
    r"##\s*🎤\s*转录内容\s*(?P<body>.*?)(?:\n##\s|\n---|\Z)",
    re.DOTALL,
)

AI_DEFAULT_SYSTEM_PROMPT = (
    "你是用户的私人思考伴侣，名叫李巡山。"
    "用户通过 WalkThink 系统记录散步时的语音思考，你的角色是帮助他深入理解自己的想法。\n\n"
    "## 你的核心任务：\n"
    "1. **理解内容**：仔细阅读用户提供的思考记录，理解其关注的话题和背后的深层逻辑\n"
    "2. **有建设性地回应**：针对用户的具体内容给出分析、建议、反思，而不是泛泛而谈\n"
    "3. **像一位智慧的朋友**：语气亲切自然、有洞察力，能指出用户可能忽略的盲区\n"
    "4. **关注全局**：用户的思考涉及事业、论文、健康、家庭等多个维度，综合考虑\n\n"
    "## 回复原则：\n"
    "- 用中文回复\n"
    "- 直接针对用户的思考内容回应，不要回复与技术系统相关的内容（除非用户明确问技术问题）\n"
    "- 回复控制在 400 字以内，但要有深度\n"
    "- 如果用户只是简单打招呼，可以简短回应并提供最近思考的简要回顾\n"
    "- 如果用户提出具体问题，基于他的历史记录给出有针对性的分析和建议\n"
)

TRANSCRIPT_CONTENT_RE = re.compile(
    r"##\s*🎤\s*转录内容\s*(?P<body>.*?)(?:\n##\s|\n---|\Z)",
    re.DOTALL,
)


def _load_user_profile(profile_path: Path, max_chars: int = 1500) -> str:
    """Layer 1: Long-term memory — who the user is, goals, key decisions."""
    if not profile_path.exists():
        return ""
    try:
        text = profile_path.read_text(encoding="utf-8").strip()
        # Strip the markdown comment block at the top
        text = re.sub(r"^>.*\n?", "", text, flags=re.MULTILINE).strip()
        if len(text) > max_chars:
            text = text[:max_chars].rstrip() + "…"
        return text
    except Exception:  # noqa: BLE001
        return ""


def _load_latest_weekly_report(reports_dir: Path, max_chars: int = 1200) -> str:
    """Layer 2: Mid-term memory — this week's themes and strategic advice."""
    weekly_dir = reports_dir / "weekly"
    if not weekly_dir.exists():
        return ""
    reports = sorted(weekly_dir.glob("weekly_report_*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    for rpt in reports:
        try:
            text = rpt.read_text(encoding="utf-8").strip()
            if len(text) < 100:  # skip empty/failed reports
                continue
            if len(text) > max_chars:
                text = text[:max_chars].rstrip() + "…"
            return text
        except Exception:  # noqa: BLE001
            continue
    return ""


def _load_short_term_entries(entries_dir: Path, max_entries: int = 5, max_chars_per_entry: int = 600) -> str:
    """Layer 3: Short-term memory — recent diary entries."""
    if not entries_dir.exists():
        return ""

    entry_files = []
    for f in entries_dir.glob("*.md"):
        if f.name.endswith("_deep.md") or f.name.endswith("_smart.md"):
            continue
        entry_files.append(f)

    entry_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    entry_files = entry_files[:max_entries]

    if not entry_files:
        return ""

    entries_text = []
    for f in entry_files:
        try:
            raw = f.read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001
            continue

        match = TRANSCRIPT_CONTENT_RE.search(raw)
        if not match:
            continue
        body = match.group("body").strip()
        if not body:
            continue

        body = re.sub(r"\[[0-9:.]+,[0-9:.]+\]\s*", "", body)
        body = re.sub(r"\n{3,}", "\n\n", body).strip()

        if len(body) > max_chars_per_entry:
            body = body[:max_chars_per_entry].rstrip() + "…"

        date_match = re.match(r"^(\d{4}-\d{2}-\d{2})", f.name)
        date_str = date_match.group(1) if date_match else "未知日期"
        entries_text.append(f"【{date_str}】\n{body}")

    if not entries_text:
        return ""

    return "\n\n---\n\n".join(entries_text)


def load_full_memory_context(walkthink_dir: Path | str | None = None) -> str:
    """Build a 3-layer memory context for the AI companion.

    Layer 1 (long-term):  User profile — identity, goals, key decisions
    Layer 2 (mid-term):   Latest weekly report — this week's themes
    Layer 3 (short-term): Recent diary entries — last few days' thoughts
    """
    root = (
        Path(walkthink_dir).expanduser()
        if walkthink_dir is not None
        else Path(os.getenv("WALKTHINK_DIR", str(Path.home() / "WalkThink"))).expanduser()
    )
    entries_dir = root / "data" / "entries"
    profile_path = root / "data" / "profile" / "user_profile.md"
    reports_dir = root / "data" / "reports"
    sections: list[str] = []

    profile = _load_user_profile(profile_path)
    if profile:
        sections.append(f"【长期记忆 · 用户画像】\n{profile}")

    weekly = _load_latest_weekly_report(reports_dir)
    if weekly:
        sections.append(f"【中期记忆 · 最近一期周报摘要】\n{weekly}")

    recent = _load_short_term_entries(entries_dir)
    if recent:
        sections.append(f"【短期记忆 · 最近几天的思考记录】\n{recent}")

    return "\n\n===\n\n".join(sections)


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
        "--retry-base-sec",
        type=float,
        default=float(os.getenv("DISCORD_POLLER_RETRY_BASE_SEC", str(DEFAULT_RETRY_BASE_SEC))),
    )
    parser.add_argument(
        "--retry-max-sec",
        type=float,
        default=float(os.getenv("DISCORD_POLLER_RETRY_MAX_SEC", str(DEFAULT_RETRY_MAX_SEC))),
    )
    parser.add_argument(
        "--retry-notify-sec",
        type=float,
        default=float(os.getenv("DISCORD_POLLER_RETRY_NOTIFY_SEC", str(DEFAULT_RETRY_NOTIFY_SEC))),
    )
    parser.add_argument(
        "--status",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Print read-only pending/recovery status and exit",
    )
    parser.add_argument(
        "--status-format",
        choices=("text", "json"),
        default=os.getenv("DISCORD_POLLER_STATUS_FORMAT", "text"),
        help="Output format for --status",
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
                data.setdefault("pending_attachment_keys", [])
                data.setdefault("pending_attachment_meta", {})
                data.setdefault("recent_audio_events", [])
                return data
        except Exception as err:  # noqa: BLE001
            log_event("state_read_failed", error=str(err), state_file=str(state_file))
    if legacy_last_id_file.exists():
        try:
            legacy_last_id = legacy_last_id_file.read_text(encoding="utf-8").strip() or "0"
            return {
                "last_message_id": legacy_last_id,
                "processed_attachment_keys": [],
                "pending_attachment_keys": [],
                "pending_attachment_meta": {},
                "recent_audio_events": [],
            }
        except Exception as err:  # noqa: BLE001
            log_event("legacy_state_read_failed", error=str(err), legacy_file=str(legacy_last_id_file))
    return {
        "last_message_id": "0",
        "processed_attachment_keys": [],
        "pending_attachment_keys": [],
        "pending_attachment_meta": {},
        "recent_audio_events": [],
    }


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


def get_message_by_id(
    session: requests.Session,
    channel_id: str,
    message_id: str,
) -> dict[str, Any] | None:
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages/{message_id}"
    response = session.get(url, timeout=20)
    if response.status_code == 429:
        retry_after = 1.0
        try:
            retry_after = float(response.json().get("retry_after", 1.0))
        except Exception:  # noqa: BLE001
            pass
        log_event("discord_message_rate_limited", channel_id=channel_id, message_id=message_id, retry_after=retry_after)
        time.sleep(max(0.1, retry_after))
        return None
    if response.status_code == 404:
        log_event("discord_message_missing", channel_id=channel_id, message_id=message_id)
        return {"_missing": True, "id": message_id}
    if response.status_code != 200:
        snippet = response.text[:200].replace("\n", " ")
        log_event(
            "discord_message_fetch_failed",
            channel_id=channel_id,
            message_id=message_id,
            status=response.status_code,
            body=snippet,
        )
        return None
    payload = response.json()
    if not isinstance(payload, dict):
        return None
    return payload


def send_message(session: requests.Session, channel_id: str, content: str) -> None:
    """Send a message to a Discord channel, splitting into chunks if needed."""
    if not content:
        return
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    # Discord limit is 2000 chars; split at paragraph/newline boundaries
    max_len = 1900
    if len(content) <= max_len:
        resp = session.post(url, json={"content": content}, timeout=20)
        if resp.status_code >= 300:
            log_event("discord_send_failed", status=resp.status_code, body=resp.text[:200].replace("\n", " "))
        return

    # Split into chunks at double-newline or newline boundaries
    chunks: list[str] = []
    remaining = content
    while remaining:
        if len(remaining) <= max_len:
            chunks.append(remaining)
            break
        # Try to split at paragraph boundary
        split_pos = remaining.rfind("\n\n", 0, max_len)
        if split_pos < max_len // 3:
            split_pos = remaining.rfind("\n", 0, max_len)
        if split_pos < max_len // 3:
            split_pos = max_len
        chunks.append(remaining[:split_pos])
        remaining = remaining[split_pos:].lstrip("\n")

    for chunk in chunks:
        if not chunk.strip():
            continue
        resp = session.post(url, json={"content": chunk}, timeout=20)
        if resp.status_code >= 300:
            log_event("discord_send_failed", status=resp.status_code, body=resp.text[:200].replace("\n", " "))
            break
        time.sleep(0.3)  # Avoid rate limiting


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


def find_audio_attachment(
    message: dict[str, Any],
    attachment_id: str,
    fallback_filename: str = "",
) -> dict[str, Any] | None:
    attachments = message.get("attachments") or []
    candidates: list[dict[str, Any]] = []
    for attachment in attachments:
        if not isinstance(attachment, dict) or not is_audio_attachment(attachment):
            continue
        if str(attachment.get("id") or "") == attachment_id:
            return attachment
        candidates.append(attachment)

    if fallback_filename:
        safe_fallback = sanitize_filename(fallback_filename).lower()
        for attachment in candidates:
            if sanitize_filename(str(attachment.get("filename") or "")).lower() == safe_fallback:
                return attachment
    return None


def build_success_message(filename: str, entry_path: Path | None, transcript_preview: str) -> str:
    lines = [f"✅ 已自动处理语音: `{filename}`"]
    if transcript_preview:
        safe_preview = transcript_preview.replace("```", "'''")
        lines.append(f"📝 转录摘录:\n```text\n{safe_preview}\n```")
    if entry_path:
        lines.append(f"📁 条目: `{entry_path}`")
    return "\n".join(lines)


def attempt_audio_processing(
    session: requests.Session,
    args: argparse.Namespace,
    channel_id: str,
    msg_id: str,
    filename: str,
    source_url: str,
    inbound_dir: Path,
    *,
    announce_start: bool,
) -> dict[str, Any]:
    if not source_url:
        return {"status": "missing_url", "filename": filename}

    safe_filename = sanitize_filename(filename)
    local_path = inbound_dir / f"{msg_id}_{safe_filename}"
    log_event("audio_download_start", message_id=msg_id, filename=safe_filename)
    if announce_start:
        send_message(session, channel_id, f"🎙️ 收到语音，开始处理: `{safe_filename}`")

    try:
        download_attachment(session, source_url, local_path)
    except Exception as err:  # noqa: BLE001
        log_event("audio_download_failed", message_id=msg_id, filename=safe_filename, error=str(err))
        return {"status": "retry", "phase": "download", "filename": safe_filename, "error": str(err)}

    try:
        result = run_auto_process(args, local_path)
    except subprocess.TimeoutExpired as err:
        return {"status": "retry", "phase": "timeout", "filename": safe_filename, "error": str(err)}
    except Exception as err:  # noqa: BLE001
        log_event("auto_process_exec_failed", message_id=msg_id, filename=safe_filename, error=str(err))
        return {"status": "retry", "phase": "exec", "filename": safe_filename, "error": str(err)}

    if result.returncode == 0:
        entry_path = parse_entry_path(result)
        transcript_preview = load_transcript_preview(entry_path)
        log_event("audio_processed", message_id=msg_id, filename=safe_filename)
        return {
            "status": "success",
            "filename": safe_filename,
            "entry_path": entry_path,
            "transcript_preview": transcript_preview,
        }

    stderr_tail = (result.stderr or "")[-500:].replace("`", "'")
    stdout_tail = (result.stdout or "")[-300:].replace("`", "'")
    error_tail = stderr_tail or stdout_tail or "无详细输出"
    log_event(
        "audio_process_failed",
        message_id=msg_id,
        filename=safe_filename,
        return_code=result.returncode,
        stdout_tail=stdout_tail,
        stderr_tail=stderr_tail,
    )
    return {
        "status": "failed",
        "filename": safe_filename,
        "stdout_tail": stdout_tail,
        "stderr_tail": stderr_tail,
        "error_tail": error_tail,
    }


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


def track_attachment_key(
    dedupe_key: str,
    tracked_keys: list[str],
    tracked_key_set: set[str],
) -> None:
    if dedupe_key in tracked_key_set:
        return
    tracked_keys.append(dedupe_key)
    tracked_key_set.add(dedupe_key)
    if len(tracked_keys) > MAX_TRACKED_ATTACHMENTS:
        drop_count = len(tracked_keys) - MAX_TRACKED_ATTACHMENTS
        removed = tracked_keys[:drop_count]
        del tracked_keys[:drop_count]
        for key in removed:
            tracked_key_set.discard(key)


def remove_tracked_attachment_key(
    dedupe_key: str,
    tracked_keys: list[str],
    tracked_key_set: set[str],
) -> bool:
    if dedupe_key not in tracked_key_set:
        return False
    tracked_key_set.discard(dedupe_key)
    try:
        tracked_keys.remove(dedupe_key)
    except ValueError:
        pass
    return True


def mark_processed_attachment_key(
    dedupe_key: str,
    processed_keys: list[str],
    processed_key_set: set[str],
) -> None:
    track_attachment_key(dedupe_key, processed_keys, processed_key_set)


def compute_retry_delay_sec(retry_count: int, base_sec: float, max_sec: float) -> float:
    safe_retry_count = max(1, retry_count)
    safe_base = max(1.0, base_sec)
    safe_max = max(safe_base, max_sec)
    return min(safe_max, safe_base * (2 ** (safe_retry_count - 1)))


def get_pending_retry_meta(
    pending_meta: dict[str, dict[str, Any]],
    dedupe_key: str,
) -> dict[str, Any]:
    raw = pending_meta.get(dedupe_key)
    if isinstance(raw, dict):
        return raw
    return {}


def should_defer_pending_retry(
    pending_meta: dict[str, dict[str, Any]],
    dedupe_key: str,
    now_ts: float,
) -> bool:
    meta = get_pending_retry_meta(pending_meta, dedupe_key)
    next_retry_ts = meta.get("next_retry_ts")
    try:
        return float(next_retry_ts) > now_ts
    except (TypeError, ValueError):
        return False


def schedule_retryable_attachment(
    pending_meta: dict[str, dict[str, Any]],
    dedupe_key: str,
    *,
    now_ts: float,
    retry_base_sec: float,
    retry_max_sec: float,
    retry_notify_sec: float,
    error: str,
    extra_fields: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], bool]:
    previous = get_pending_retry_meta(pending_meta, dedupe_key)
    retry_count = int(previous.get("retry_count", 0) or 0) + 1
    delay_sec = compute_retry_delay_sec(retry_count, retry_base_sec, retry_max_sec)
    last_notice_ts_raw = previous.get("last_notice_ts")
    try:
        last_notice_ts = float(last_notice_ts_raw)
    except (TypeError, ValueError):
        last_notice_ts = 0.0
    should_notify = last_notice_ts <= 0 or (now_ts - last_notice_ts) >= max(1.0, retry_notify_sec)
    meta = {
        "retry_count": retry_count,
        "first_failure_ts": previous.get("first_failure_ts", now_ts),
        "last_failure_ts": now_ts,
        "last_error": error[:500],
        "last_notice_ts": now_ts if should_notify else last_notice_ts,
        "next_retry_ts": now_ts + delay_sec,
        "last_delay_sec": delay_sec,
    }
    if extra_fields:
        meta.update(extra_fields)
    pending_meta[dedupe_key] = meta
    return meta, should_notify


def build_retry_message(phase: str, filename: str, delay_sec: float) -> str:
    delay_min = max(1, int(round(delay_sec / 60)))
    if phase == "download":
        prefix = "下载失败"
    elif phase == "timeout":
        prefix = "处理超时"
    elif phase == "refresh":
        prefix = "刷新待处理语音失败"
    else:
        prefix = "执行失败"
    return f"⚠️ {prefix}，将在约 {delay_min} 分钟后自动重试: `{filename}`"


def append_recent_audio_event(
    events: list[dict[str, Any]],
    *,
    kind: str,
    channel_id: str,
    message_id: str,
    attachment_id: str,
    filename: str,
    detail: str = "",
    retry_count: int | None = None,
    next_retry_ts: float | None = None,
) -> None:
    event: dict[str, Any] = {
        "ts": now_iso(),
        "kind": kind,
        "channel_id": channel_id,
        "message_id": message_id,
        "attachment_id": attachment_id,
        "filename": sanitize_filename(filename),
    }
    if detail:
        event["detail"] = detail[:500]
    if retry_count is not None:
        event["retry_count"] = retry_count
    if next_retry_ts is not None:
        event["next_retry_ts"] = next_retry_ts
    events.append(event)
    if len(events) > MAX_RECENT_AUDIO_EVENTS:
        del events[: len(events) - MAX_RECENT_AUDIO_EVENTS]


def build_status_snapshot(state: dict[str, Any], now_ts: float | None = None) -> dict[str, Any]:
    current_ts = time.time() if now_ts is None else now_ts
    per_channel = state.get("per_channel_last_id", {})
    pending_keys = [str(x) for x in state.get("pending_attachment_keys", []) if x]
    pending_meta_raw = state.get("pending_attachment_meta", {})
    pending_meta = pending_meta_raw if isinstance(pending_meta_raw, dict) else {}
    pending_items: list[dict[str, Any]] = []
    for dedupe_key in pending_keys:
        meta = pending_meta.get(dedupe_key)
        if not isinstance(meta, dict):
            continue
        next_retry_ts = meta.get("next_retry_ts")
        try:
            next_retry_ts_num = float(next_retry_ts)
        except (TypeError, ValueError):
            next_retry_ts_num = None
        pending_items.append(
            {
                "dedupe_key": dedupe_key,
                "channel_id": str(meta.get("channel_id") or ""),
                "message_id": str(meta.get("message_id") or ""),
                "attachment_id": str(meta.get("attachment_id") or ""),
                "filename": str(meta.get("filename") or ""),
                "retry_count": int(meta.get("retry_count", 0) or 0),
                "last_error": str(meta.get("last_error") or ""),
                "next_retry_ts": next_retry_ts_num,
                "ready_now": next_retry_ts_num is None or next_retry_ts_num <= current_ts,
            }
        )
    pending_items.sort(key=lambda item: (item["next_retry_ts"] is None, item["next_retry_ts"] or 0.0))

    recent_raw = state.get("recent_audio_events", [])
    recent_events = recent_raw if isinstance(recent_raw, list) else []
    recent_items = recent_events[-MAX_RECENT_AUDIO_EVENTS:]

    return {
        "generated_at": datetime.datetime.fromtimestamp(current_ts, tz=datetime.timezone.utc).isoformat(),
        "per_channel_last_id": per_channel,
        "pending_count": len(pending_items),
        "pending": pending_items,
        "recent_event_count": len(recent_items),
        "recent_audio_events": recent_items,
    }


def render_status_text(snapshot: dict[str, Any]) -> str:
    lines = [f"Discord poller status @ {snapshot.get('generated_at', '')}"]
    per_channel = snapshot.get("per_channel_last_id", {})
    if isinstance(per_channel, dict) and per_channel:
        lines.append("Channels:")
        for channel_id, last_id in per_channel.items():
            lines.append(f"- {channel_id}: last_message_id={last_id}")
    else:
        lines.append("Channels: none")

    pending = snapshot.get("pending", [])
    lines.append(f"Pending attachments: {snapshot.get('pending_count', 0)}")
    if isinstance(pending, list) and pending:
        for item in pending:
            next_retry_ts = item.get("next_retry_ts")
            if isinstance(next_retry_ts, (int, float)):
                next_retry_text = datetime.datetime.fromtimestamp(
                    float(next_retry_ts), tz=datetime.timezone.utc
                ).isoformat()
            else:
                next_retry_text = "unknown"
            status_text = "ready" if item.get("ready_now") else "waiting"
            lines.append(
                "- "
                + f"{item.get('filename') or 'audio'} "
                + f"(msg={item.get('message_id')}, retry={item.get('retry_count')}, {status_text}, next={next_retry_text})"
            )
            if item.get("last_error"):
                lines.append(f"  last_error: {item.get('last_error')}")

    recent = snapshot.get("recent_audio_events", [])
    lines.append(f"Recent audio events: {snapshot.get('recent_event_count', 0)}")
    if isinstance(recent, list) and recent:
        for item in recent[-10:]:
            lines.append(
                "- "
                + f"{item.get('ts')} {item.get('kind')} "
                + f"{item.get('filename')} "
                + f"(msg={item.get('message_id')}, retry={item.get('retry_count', '-')})"
            )
    return "\n".join(lines)


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
    state_file = Path(args.state_file)
    legacy_last_id_file = Path(args.legacy_last_id_file)
    state = load_state(state_file, legacy_last_id_file)
    if args.status:
        snapshot = build_status_snapshot(state)
        if args.status_format == "json":
            print(json.dumps(snapshot, ensure_ascii=False, indent=2))
        else:
            print(render_status_text(snapshot))
        return 0

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

    inbound_dir = Path(args.inbound_dir)
    walkthink_root = Path(args.walkthink_dir).expanduser()
    walkthink_entries_dir = walkthink_root / "data" / "entries"
    inbound_dir.mkdir(parents=True, exist_ok=True)

    processed_keys = [str(x) for x in state.get("processed_attachment_keys", []) if x]
    if len(processed_keys) > MAX_TRACKED_ATTACHMENTS:
        processed_keys = processed_keys[-MAX_TRACKED_ATTACHMENTS:]
    processed_key_set = set(processed_keys)
    pending_keys = [str(x) for x in state.get("pending_attachment_keys", []) if x]
    if len(pending_keys) > MAX_TRACKED_ATTACHMENTS:
        pending_keys = pending_keys[-MAX_TRACKED_ATTACHMENTS:]
    pending_key_set = set(pending_keys)
    pending_meta_raw = state.get("pending_attachment_meta", {})
    pending_meta = pending_meta_raw if isinstance(pending_meta_raw, dict) else {}
    recent_audio_events_raw = state.get("recent_audio_events", [])
    recent_audio_events = recent_audio_events_raw if isinstance(recent_audio_events_raw, list) else []

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
    state["pending_attachment_keys"] = pending_keys[-MAX_TRACKED_ATTACHMENTS:]
    state["pending_attachment_meta"] = pending_meta
    state["recent_audio_events"] = recent_audio_events[-MAX_RECENT_AUDIO_EVENTS:]
    save_state(state_file, state)

    log_event("poller_started", channel_ids=channel_ids, channel_count=len(channel_ids), interval_sec=args.interval_sec)
    next_heartbeat = time.time() + max(1.0, args.heartbeat_sec)

    try:
        while True:
            metrics["loops"] += 1
            try:
              for channel_id in channel_ids:
                last_id = per_channel.get(channel_id, "0")
                state_changed = False

                for dedupe_key in list(pending_keys):
                    if dedupe_key not in pending_key_set:
                        continue
                    meta = get_pending_retry_meta(pending_meta, dedupe_key)
                    if str(meta.get("channel_id") or "") != channel_id:
                        continue
                    if should_defer_pending_retry(pending_meta, dedupe_key, time.time()):
                        continue

                    pending_message_id = str(meta.get("message_id") or "")
                    pending_attachment_id = str(meta.get("attachment_id") or "")
                    pending_filename = sanitize_filename(str(meta.get("filename") or "audio.ogg"))
                    pending_source_url = str(meta.get("source_url") or "")

                    if not pending_message_id or not pending_attachment_id:
                        log_event("pending_attachment_invalid", channel_id=channel_id, dedupe_key=dedupe_key)
                        append_recent_audio_event(
                            recent_audio_events,
                            kind="pending-invalid",
                            channel_id=channel_id,
                            message_id=pending_message_id,
                            attachment_id=pending_attachment_id,
                            filename=pending_filename,
                            detail="pending attachment metadata incomplete",
                        )
                        remove_tracked_attachment_key(dedupe_key, pending_keys, pending_key_set)
                        pending_meta.pop(dedupe_key, None)
                        mark_processed_attachment_key(dedupe_key, processed_keys, processed_key_set)
                        state_changed = True
                        continue

                    refreshed_message = get_message_by_id(session, channel_id, pending_message_id)
                    if refreshed_message is not None and refreshed_message.get("_missing"):
                        send_message(
                            session,
                            channel_id,
                            f"⚠️ 待重试语音已不存在，已跳过: `{pending_filename}`",
                        )
                        append_recent_audio_event(
                            recent_audio_events,
                            kind="pending-missing-message",
                            channel_id=channel_id,
                            message_id=pending_message_id,
                            attachment_id=pending_attachment_id,
                            filename=pending_filename,
                        )
                        remove_tracked_attachment_key(dedupe_key, pending_keys, pending_key_set)
                        pending_meta.pop(dedupe_key, None)
                        mark_processed_attachment_key(dedupe_key, processed_keys, processed_key_set)
                        state_changed = True
                        continue

                    if refreshed_message is not None:
                        refreshed_attachment = find_audio_attachment(
                            refreshed_message,
                            pending_attachment_id,
                            fallback_filename=pending_filename,
                        )
                        if refreshed_attachment is None:
                            send_message(
                                session,
                                channel_id,
                                f"⚠️ 待重试语音附件已不存在，已跳过: `{pending_filename}`",
                            )
                            append_recent_audio_event(
                                recent_audio_events,
                                kind="pending-missing-attachment",
                                channel_id=channel_id,
                                message_id=pending_message_id,
                                attachment_id=pending_attachment_id,
                                filename=pending_filename,
                            )
                            remove_tracked_attachment_key(dedupe_key, pending_keys, pending_key_set)
                            pending_meta.pop(dedupe_key, None)
                            mark_processed_attachment_key(dedupe_key, processed_keys, processed_key_set)
                            state_changed = True
                            continue
                        pending_filename = sanitize_filename(str(refreshed_attachment.get("filename") or pending_filename))
                        pending_source_url = str(refreshed_attachment.get("url") or pending_source_url)

                    if not pending_source_url:
                        metrics["audio_failed"] += 1
                        meta, should_notify = schedule_retryable_attachment(
                            pending_meta,
                            dedupe_key,
                            now_ts=time.time(),
                            retry_base_sec=args.retry_base_sec,
                            retry_max_sec=args.retry_max_sec,
                            retry_notify_sec=args.retry_notify_sec,
                            error="missing source url for pending attachment",
                            extra_fields={
                                "channel_id": channel_id,
                                "message_id": pending_message_id,
                                "attachment_id": pending_attachment_id,
                                "filename": pending_filename,
                                "source_url": pending_source_url,
                            },
                        )
                        if should_notify:
                            send_message(
                                session,
                                channel_id,
                                build_retry_message("refresh", pending_filename, float(meta.get("last_delay_sec", args.retry_base_sec))),
                            )
                        append_recent_audio_event(
                            recent_audio_events,
                            kind="retry-scheduled",
                            channel_id=channel_id,
                            message_id=pending_message_id,
                            attachment_id=pending_attachment_id,
                            filename=pending_filename,
                            detail="missing source url for pending attachment",
                            retry_count=int(meta.get("retry_count", 0) or 0),
                            next_retry_ts=float(meta.get("next_retry_ts", 0) or 0),
                        )
                        track_attachment_key(dedupe_key, pending_keys, pending_key_set)
                        state_changed = True
                        continue

                    outcome = attempt_audio_processing(
                        session,
                        args,
                        channel_id,
                        pending_message_id,
                        pending_filename,
                        pending_source_url,
                        inbound_dir,
                        announce_start=False,
                    )
                    if outcome["status"] == "retry":
                        metrics["audio_failed"] += 1
                        retry_phase = str(outcome.get("phase") or "exec")
                        meta, should_notify = schedule_retryable_attachment(
                            pending_meta,
                            dedupe_key,
                            now_ts=time.time(),
                            retry_base_sec=args.retry_base_sec,
                            retry_max_sec=args.retry_max_sec,
                            retry_notify_sec=args.retry_notify_sec,
                            error=str(outcome.get("error") or "retryable audio failure"),
                            extra_fields={
                                "channel_id": channel_id,
                                "message_id": pending_message_id,
                                "attachment_id": pending_attachment_id,
                                "filename": str(outcome.get("filename") or pending_filename),
                                "source_url": pending_source_url,
                            },
                        )
                        if retry_phase == "timeout":
                            log_event(
                                "audio_process_timeout",
                                message_id=pending_message_id,
                                filename=str(outcome.get("filename") or pending_filename),
                                timeout_sec=max(30.0, args.process_timeout_sec),
                                error=str(outcome.get("error") or ""),
                                retry_count=meta.get("retry_count"),
                                next_retry_ts=meta.get("next_retry_ts"),
                            )
                        if should_notify:
                            send_message(
                                session,
                                channel_id,
                                build_retry_message(retry_phase, str(outcome.get("filename") or pending_filename), float(meta.get("last_delay_sec", args.retry_base_sec))),
                            )
                        append_recent_audio_event(
                            recent_audio_events,
                            kind="retry-scheduled",
                            channel_id=channel_id,
                            message_id=pending_message_id,
                            attachment_id=pending_attachment_id,
                            filename=str(outcome.get("filename") or pending_filename),
                            detail=str(outcome.get("error") or ""),
                            retry_count=int(meta.get("retry_count", 0) or 0),
                            next_retry_ts=float(meta.get("next_retry_ts", 0) or 0),
                        )
                        track_attachment_key(dedupe_key, pending_keys, pending_key_set)
                        state_changed = True
                        continue

                    if outcome["status"] == "success":
                        metrics["audio_processed"] += 1
                        send_message(
                            session,
                            channel_id,
                            build_success_message(
                                str(outcome.get("filename") or pending_filename),
                                outcome.get("entry_path"),
                                str(outcome.get("transcript_preview") or ""),
                            ),
                        )
                        append_recent_audio_event(
                            recent_audio_events,
                            kind="recovered",
                            channel_id=channel_id,
                            message_id=pending_message_id,
                            attachment_id=pending_attachment_id,
                            filename=str(outcome.get("filename") or pending_filename),
                        )
                    elif outcome["status"] == "failed":
                        metrics["audio_failed"] += 1
                        send_message(
                            session,
                            channel_id,
                            f"⚠️ 处理出错: `{outcome.get('filename') or pending_filename}`\n```{outcome.get('error_tail') or '无详细输出'}```",
                        )
                        append_recent_audio_event(
                            recent_audio_events,
                            kind="failed",
                            channel_id=channel_id,
                            message_id=pending_message_id,
                            attachment_id=pending_attachment_id,
                            filename=str(outcome.get("filename") or pending_filename),
                            detail=str(outcome.get("error_tail") or ""),
                        )
                    else:
                        metrics["audio_failed"] += 1
                        send_message(session, channel_id, f"⚠️ 附件缺少下载地址，已跳过: `{pending_filename}`")
                        append_recent_audio_event(
                            recent_audio_events,
                            kind="missing-url",
                            channel_id=channel_id,
                            message_id=pending_message_id,
                            attachment_id=pending_attachment_id,
                            filename=pending_filename,
                        )

                    remove_tracked_attachment_key(dedupe_key, pending_keys, pending_key_set)
                    pending_meta.pop(dedupe_key, None)
                    mark_processed_attachment_key(dedupe_key, processed_keys, processed_key_set)
                    state_changed = True

                messages = get_messages(session, channel_id, args.fetch_limit, after_id=last_id)
                if messages:
                    messages.sort(key=lambda msg: int(msg.get("id", "0")))
                for msg in messages:
                    msg_id = str(msg.get("id", "0"))
                    if msg_id == "0":
                        continue

                    metrics["messages_seen"] += 1
                    author = msg.get("author") or {}
                    if author.get("bot"):
                        last_id = update_last_id(last_id, msg_id)
                        state_changed = True
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

                        was_pending = dedupe_key in pending_key_set
                        if was_pending and should_defer_pending_retry(pending_meta, dedupe_key, time.time()):
                            meta = get_pending_retry_meta(pending_meta, dedupe_key)
                            log_event(
                                "audio_retry_deferred",
                                channel_id=channel_id,
                                message_id=msg_id,
                                dedupe_key=dedupe_key,
                                next_retry_ts=meta.get("next_retry_ts"),
                                retry_count=meta.get("retry_count"),
                            )
                            continue
                        filename = sanitize_filename(str(attachment.get("filename") or "audio.ogg"))
                        source_url = str(attachment.get("url") or "")
                        outcome = attempt_audio_processing(
                            session,
                            args,
                            channel_id,
                            msg_id,
                            filename,
                            source_url,
                            inbound_dir,
                            announce_start=not was_pending,
                        )
                        if outcome["status"] == "retry":
                            metrics["audio_failed"] += 1
                            retry_phase = str(outcome.get("phase") or "exec")
                            meta, should_notify = schedule_retryable_attachment(
                                pending_meta,
                                dedupe_key,
                                now_ts=time.time(),
                                retry_base_sec=args.retry_base_sec,
                                retry_max_sec=args.retry_max_sec,
                                retry_notify_sec=args.retry_notify_sec,
                                error=str(outcome.get("error") or "retryable audio failure"),
                                extra_fields={
                                    "channel_id": channel_id,
                                    "message_id": msg_id,
                                    "attachment_id": attachment_id,
                                    "filename": str(outcome.get("filename") or filename),
                                    "source_url": source_url,
                                },
                            )
                            if retry_phase == "timeout":
                                log_event(
                                    "audio_process_timeout",
                                    message_id=msg_id,
                                    filename=str(outcome.get("filename") or filename),
                                    timeout_sec=max(30.0, args.process_timeout_sec),
                                    error=str(outcome.get("error") or ""),
                                    retry_count=meta.get("retry_count"),
                                    next_retry_ts=meta.get("next_retry_ts"),
                                )
                            if should_notify:
                                send_message(
                                    session,
                                    channel_id,
                                    build_retry_message(retry_phase, str(outcome.get("filename") or filename), float(meta.get("last_delay_sec", args.retry_base_sec))),
                                )
                            append_recent_audio_event(
                                recent_audio_events,
                                kind="retry-scheduled",
                                channel_id=channel_id,
                                message_id=msg_id,
                                attachment_id=attachment_id,
                                filename=str(outcome.get("filename") or filename),
                                detail=str(outcome.get("error") or ""),
                                retry_count=int(meta.get("retry_count", 0) or 0),
                                next_retry_ts=float(meta.get("next_retry_ts", 0) or 0),
                            )
                            track_attachment_key(dedupe_key, pending_keys, pending_key_set)
                            state_changed = True
                            continue

                        if outcome["status"] == "success":
                            metrics["audio_processed"] += 1
                            send_message(
                                session,
                                channel_id,
                                build_success_message(
                                    str(outcome.get("filename") or filename),
                                    outcome.get("entry_path"),
                                    str(outcome.get("transcript_preview") or ""),
                                ),
                            )
                            append_recent_audio_event(
                                recent_audio_events,
                                kind="processed",
                                channel_id=channel_id,
                                message_id=msg_id,
                                attachment_id=attachment_id,
                                filename=str(outcome.get("filename") or filename),
                            )
                        elif outcome["status"] == "failed":
                            metrics["audio_failed"] += 1
                            send_message(
                                session,
                                channel_id,
                                f"⚠️ 处理出错: `{outcome.get('filename') or filename}`\n```{outcome.get('error_tail') or '无详细输出'}```",
                            )
                            append_recent_audio_event(
                                recent_audio_events,
                                kind="failed",
                                channel_id=channel_id,
                                message_id=msg_id,
                                attachment_id=attachment_id,
                                filename=str(outcome.get("filename") or filename),
                                detail=str(outcome.get("error_tail") or ""),
                            )
                        else:
                            metrics["audio_failed"] += 1
                            log_event("audio_missing_url", message_id=msg_id, filename=filename)
                            send_message(session, channel_id, f"⚠️ 附件缺少下载地址，已跳过: `{filename}`")
                            append_recent_audio_event(
                                recent_audio_events,
                                kind="missing-url",
                                channel_id=channel_id,
                                message_id=msg_id,
                                attachment_id=attachment_id,
                                filename=filename,
                            )

                        remove_tracked_attachment_key(dedupe_key, pending_keys, pending_key_set)
                        pending_meta.pop(dedupe_key, None)
                        mark_processed_attachment_key(dedupe_key, processed_keys, processed_key_set)
                        state_changed = True

                    if content.strip().lower() == "ping":
                        send_message(session, channel_id, "pong (via poller)")
                        metrics["ping_replied"] += 1
                    elif content.strip() and ai_session is not None and not msg_has_audio:
                        log_event("ai_reply_start", message_id=msg_id, content_preview=content[:50])

                        # Fetch recent chat context to check if user wants to save AI's insight
                        recent_history = get_messages(session, channel_id, 20, after_id=None)
                        content_stripped = content.strip()

                        # Check for save commands: e.g. "记下来", "这句很好记住", "把这个总结保存下来"
                        user_wants_to_save = False
                        save_keywords = ["记住", "记下", "保存", "记笔记", "纳入", "收藏"]
                        if (
                            len(content_stripped) < 50
                            and any(k in content.replace(" ", "") for k in save_keywords)
                            and recent_history
                        ):
                            # Collect ALL consecutive bot messages before this user message
                            bot_msg_parts: list[str] = []
                            found_current = False
                            for h_msg in recent_history:  # newest first
                                if h_msg.get("id") == msg_id:
                                    found_current = True
                                    continue
                                if not found_current:
                                    continue
                                h_author = h_msg.get("author", {})
                                h_content = str(h_msg.get("content") or "").strip()
                                if h_author.get("bot"):
                                    # Skip system notification messages
                                    if h_content.startswith("🎙️") or h_content.startswith("⚠️") or h_content.startswith("📝"):
                                        continue
                                    if h_content:
                                        bot_msg_parts.append(h_content)
                                else:
                                    # Hit a non-bot message — stop collecting
                                    break
                                    
                            if bot_msg_parts:
                                # Reverse to get chronological order and merge
                                bot_msg_parts.reverse()
                                merged_insight = "\n\n".join(bot_msg_parts)

                                # Dedup: check if we already saved this exact insight
                                existing_insight_files = sorted(
                                    walkthink_entries_dir.glob("*_ai_insight_*.md"),
                                    key=lambda p: p.stat().st_mtime,
                                    reverse=True,
                                )[:200]
                                already_saved = False
                                for ef in existing_insight_files:
                                    try:
                                        if merged_insight[:200] in ef.read_text(encoding="utf-8"):
                                            already_saved = True
                                            break
                                    except Exception:  # noqa: BLE001
                                        pass
                                
                                if already_saved:
                                    send_message(session, channel_id, "🧠 这条洞察已经保存过了，无需重复收藏。")
                                else:
                                    ts_now = datetime.datetime.now()
                                    ts_str = ts_now.strftime("%Y-%m-%d_%H%M%S")
                                    ts_title = ts_now.strftime("%Y-%m-%d %H:%M:%S")
                                    entry_file = walkthink_entries_dir / f"{ts_str}_ai_insight_{msg_id}.md"
                                    entry_md = (
                                        f"# AI 洞察 - {ts_str}\n\n"
                                        f"## 📅 基本信息\n"
                                        f"- **记录时间**: {ts_title}\n"
                                        f"- **来源**: ai-insight\n"
                                        f"- **触发词**: {content_stripped}\n"
                                        f"- **合并消息数**: {len(bot_msg_parts)}\n\n"
                                        f"## 🎤 转录内容\n\n"
                                        f"{merged_insight}\n\n"
                                        f"## 📝 备注\n"
                                        f"用户主动要求收藏的 AI 分析与洞察（已自动合并多条消息）。\n"
                                    )
                                    walkthink_entries_dir.mkdir(parents=True, exist_ok=True)
                                    entry_file.write_text(entry_md, encoding="utf-8")
                                    send_message(session, channel_id, f"📝 已将 {len(bot_msg_parts)} 条消息合并为一条完整洞察笔记 🧠\n`data/entries/{entry_file.name}`")
                                user_wants_to_save = True

                        if not user_wants_to_save:
                            # Save long text thoughts automatically
                            if len(content_stripped) >= 30:
                                ts_now = datetime.datetime.now()
                                ts_str = ts_now.strftime("%Y-%m-%d_%H%M%S")
                                ts_title = ts_now.strftime("%Y-%m-%d %H:%M:%S")
                                entry_file = walkthink_entries_dir / f"{ts_str}_discord_text_{msg_id}.md"
                                entry_md = (
                                    f"# 文本记录 - {ts_str}\n\n"
                                    f"## 📅 基本信息\n"
                                    f"- **记录时间**: {ts_title}\n"
                                    f"- **来源**: discord-text\n\n"
                                    f"## 🎤 转录内容\n\n"
                                    f"{content_stripped}\n\n"
                                    f"## 📝 备注\n"
                                    f"通过 Discord 文字记录的长期思考。\n"
                                )
                                walkthink_entries_dir.mkdir(parents=True, exist_ok=True)
                                entry_file.write_text(entry_md, encoding="utf-8")
                                send_message(session, channel_id, f"📝 日记条目: `data/entries/{entry_file.name}` (已为你保存这条文字思考)")

                            history_lines = []
                            for h_msg in reversed(recent_history):
                                h_author = h_msg.get("author", {})
                                if not h_author:
                                    continue
                                h_name = "AI伴侣(你)" if h_author.get("bot") else "用户"
                                h_content = str(h_msg.get("content") or "").strip()
                                if h_content and not h_content.startswith("🎙️") and not h_content.startswith("⚠️") and not h_content.startswith("📝"):
                                    history_lines.append(f"{h_name}: {h_content[:300]}")
                            history_text = "\n".join(history_lines)

                            # Build context-aware message with 3-layer memory
                            memory_context = load_full_memory_context(walkthink_root)

                            context_sections: list[str] = []
                            if memory_context:
                                context_sections.append(memory_context)

                            if history_text:
                                context_sections.append(f"【当前频道的近距离对话上下文】\n{history_text}")

                            context_sections.append(f"【用户最新发言】\n{content_stripped}")
                            context_sections.append("请结合上述背景和上下文，基于【用户最新发言】给出回复。")
                            context_message = "\n\n===\n\n".join(context_sections)
                            ai_response = ai_chat_reply(
                                ai_session,
                                args.ai_base_url,
                                args.ai_model,
                                ai_system_prompt,
                                context_message,
                                max_tokens=args.ai_reply_max_tokens,
                            )
                            if ai_response:
                                send_message(session, channel_id, ai_response)
                                metrics["ai_replied"] += 1
                                log_event("ai_replied", message_id=msg_id, response_len=len(ai_response))

                    last_id = update_last_id(last_id, msg_id)
                    state_changed = True

                if state_changed:
                    per_channel[channel_id] = last_id
                    state["per_channel_last_id"] = per_channel
                    state["processed_attachment_keys"] = processed_keys
                    state["pending_attachment_keys"] = pending_keys
                    state["pending_attachment_meta"] = pending_meta
                    state["recent_audio_events"] = recent_audio_events
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
