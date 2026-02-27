"""shared/telegram.py — 텔레그램 알림 중앙 게이트웨이.

모든 시스템/태스크 알림은 이 모듈을 경유.
파이프라인 리포트(자체 _send_telegram_text)는 별도 스코프.
"""

import json
import logging
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

DM_CHAT_ID = 492860021
GROUP_CHAT_ID = -1003076685086
RON_TOPIC_ID = 30413

SUPPRESS_PATTERNS = (
    "timed out", "timeout", "empty_response", "cooldown",
    "connection refused", "econnrefused",
)

_CONFIG_PATH = Path.home() / ".openclaw" / "openclaw.json"
_bot_token_cache = None


def _get_bot_token() -> str:
    """Read bot token from openclaw.json (cached)."""
    global _bot_token_cache
    if _bot_token_cache is not None:
        return _bot_token_cache
    try:
        cfg = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        _bot_token_cache = cfg["channels"]["telegram"]["botToken"]
    except Exception:
        _bot_token_cache = ""
    return _bot_token_cache


def is_suppressed(text: str) -> bool:
    """SUPPRESS_PATTERNS 매칭 여부."""
    low = text.lower()
    return any(p in low for p in SUPPRESS_PATTERNS)


def _send(chat_id, text, parse_mode="HTML", topic_id=None,
          max_retries=3, timeout=15):
    """Low-level send with retry + exponential backoff."""
    token = _get_bot_token()
    if not token:
        logger.warning("Telegram: bot token 없음")
        return False

    if len(text) > 4000:
        text = text[:3950] + "\n\n... (truncated)"

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body = {"chat_id": chat_id, "text": text}
    if parse_mode:
        body["parse_mode"] = parse_mode
    if topic_id is not None:
        body["message_thread_id"] = topic_id

    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}

    for attempt in range(max_retries):
        try:
            req = Request(url, data=data, headers=headers, method="POST")
            with urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                return result.get("ok", False)
        except (HTTPError, URLError, OSError) as e:
            if attempt < max_retries - 1:
                wait = min(2 ** attempt, 8)
                logger.debug("Telegram retry %d/%d after %.1fs: %s",
                             attempt + 1, max_retries, wait, e)
                time.sleep(wait)
            else:
                logger.warning("Telegram send failed after %d retries: %s",
                               max_retries, e)
    return False


def send_dm(text, level="info", parse_mode="HTML"):
    """DM 전송.

    level="info"/"alert": SUPPRESS_PATTERNS 매칭 시 로그만, 전송 안 함.
    level="critical": 필터 우회 (승인, 디스크 부족 등 즉시 필요).
    """
    if level != "critical" and is_suppressed(text):
        logger.info("Telegram DM suppressed (infra-noise): %.60s…", text)
        return False
    return _send(DM_CHAT_ID, text, parse_mode=parse_mode)


def send_group(text, topic_id=None, parse_mode="HTML"):
    """그룹 전송."""
    return _send(GROUP_CHAT_ID, text, parse_mode=parse_mode,
                 topic_id=topic_id)
