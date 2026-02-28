"""shared/telegram.py — 텔레그램 전송 중앙 게이트웨이.

모든 시스템 알림 + 파이프라인 리포트가 이 모듈을 경유.
"""

import json
import logging
import mimetypes
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

DM_CHAT_ID = 492860021
GROUP_CHAT_ID = -1003076685086
RON_TOPIC_ID = 30413
DAILY_REPORT_TOPIC_ID = 39439

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


def split_message(text: str, max_len: int = 4096) -> list[str]:
    """메시지를 줄 경계 기준으로 분할 (Telegram 4096 제한 대응).

    단일 줄이 max_len 초과 시 강제 문자 분할.
    """
    if len(text) <= max_len:
        return [text]
    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        if len(line) > max_len:
            if current:
                chunks.append(current)
                current = ""
            while len(line) > max_len:
                chunks.append(line[:max_len])
                line = line[max_len:]
            if line:
                current = line
            continue
        if len(current) + len(line) + 1 > max_len:
            if current:
                chunks.append(current)
            current = line
        else:
            current = current + "\n" + line if current else line
    if current:
        chunks.append(current)
    return chunks


def _send(chat_id, text, parse_mode="HTML", topic_id=None,
          max_retries=3, timeout=15, disable_web_page_preview=True):
    """Low-level send with retry + exponential backoff."""
    token = _get_bot_token()
    if not token:
        logger.warning("Telegram: bot token 없음")
        return False

    if len(text) > 4096:
        text = text[:4000] + "\n\n... (truncated)"

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body: dict = {"chat_id": chat_id, "text": text}
    if parse_mode:
        body["parse_mode"] = parse_mode
    if topic_id is not None:
        body["message_thread_id"] = topic_id
    if disable_web_page_preview:
        body["disable_web_page_preview"] = True

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


# --- Chunked send (파이프라인 리포트용, SUPPRESS 필터 우회) ---

def send_dm_chunked(text: str, parse_mode="HTML", delay: float = 0.5) -> bool:
    """DM으로 분할 전송 (4096 제한 자동 대응). 노이즈 필터 우회."""
    chunks = split_message(text)
    success = True
    for i, chunk in enumerate(chunks):
        if not _send(DM_CHAT_ID, chunk, parse_mode=parse_mode):
            success = False
        if i < len(chunks) - 1 and delay > 0:
            time.sleep(delay)
    return success


def send_group_chunked(text: str, topic_id=None, parse_mode="HTML",
                       delay: float = 0.5) -> bool:
    """그룹으로 분할 전송 (4096 제한 자동 대응)."""
    chunks = split_message(text)
    success = True
    for i, chunk in enumerate(chunks):
        if not _send(GROUP_CHAT_ID, chunk, parse_mode=parse_mode,
                     topic_id=topic_id):
            success = False
        if i < len(chunks) - 1 and delay > 0:
            time.sleep(delay)
    return success


# --- Multipart helpers (urllib 기반, requests 의존 없음) ---

def _build_multipart(fields: dict, files: list[tuple]) -> tuple[bytes, str]:
    """multipart/form-data 바디 생성.

    files: [(field_name, filename, data_bytes, content_type), ...]
    Returns (body_bytes, boundary_string).
    """
    boundary = f"----TgBoundary{int(time.time() * 1000)}"
    parts: list[bytes] = []
    for key, value in fields.items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
        )
        parts.append(f"{value}\r\n".encode())

    for field_name, filename, data, content_type in files:
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(
            f'Content-Disposition: form-data; name="{field_name}"; '
            f'filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n".encode()
        )
        parts.append(data)
        parts.append(b"\r\n")

    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), boundary


def send_photo(chat_id, photo_path: str, caption: str = "",
               topic_id=None, parse_mode="HTML") -> bool:
    """사진 전송 (sendPhoto API, multipart/form-data)."""
    token = _get_bot_token()
    if not token:
        return False

    path = Path(photo_path)
    if not path.exists():
        logger.warning("send_photo: file not found: %s", photo_path)
        return False

    ct = mimetypes.guess_type(str(path))[0] or "image/png"
    fields: dict[str, str] = {"chat_id": str(chat_id)}
    if caption:
        fields["caption"] = caption[:1024]
    if parse_mode:
        fields["parse_mode"] = parse_mode
    if topic_id is not None:
        fields["message_thread_id"] = str(topic_id)

    body, boundary = _build_multipart(
        fields, [("photo", path.name, path.read_bytes(), ct)]
    )
    url = f"https://api.telegram.org/bot{token}/sendPhoto"
    req = Request(url, data=body, method="POST",
                  headers={"Content-Type":
                           f"multipart/form-data; boundary={boundary}"})
    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("ok", False)
    except Exception as e:
        logger.warning("send_photo failed: %s", e)
        return False


def send_album(chat_id, photos: list[dict], topic_id=None) -> bool:
    """앨범 전송 (sendMediaGroup API).

    photos: [{"path": str|Path, "caption": str}, ...]
    실패 시 False -> 호출부에서 개별 send_photo fallback 가능.
    """
    if not photos:
        return False
    token = _get_bot_token()
    if not token:
        return False

    media = []
    files: list[tuple] = []
    for i, p in enumerate(photos):
        attach_key = f"photo{i}"
        path = Path(p["path"])
        if not path.exists():
            logger.warning("send_album: file not found: %s", p["path"])
            continue
        ct = mimetypes.guess_type(str(path))[0] or "image/png"
        caption = p.get("caption", "")[:1024]
        entry: dict = {"type": "photo", "media": f"attach://{attach_key}"}
        if caption:
            entry["caption"] = caption
        media.append(entry)
        files.append((attach_key, path.name, path.read_bytes(), ct))

    if not files:
        return False

    fields: dict[str, str] = {
        "chat_id": str(chat_id),
        "media": json.dumps(media),
    }
    if topic_id is not None:
        fields["message_thread_id"] = str(topic_id)

    body, boundary = _build_multipart(fields, files)
    url = f"https://api.telegram.org/bot{token}/sendMediaGroup"
    req = Request(url, data=body, method="POST",
                  headers={"Content-Type":
                           f"multipart/form-data; boundary={boundary}"})
    try:
        with urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("ok", False)
    except Exception as e:
        logger.warning("send_album failed: %s", e)
        return False


def send_document(chat_id, doc_path: str, caption: str = "",
                  topic_id=None) -> bool:
    """문서 전송 (sendDocument API, PDF 등)."""
    token = _get_bot_token()
    if not token:
        return False

    path = Path(doc_path)
    if not path.exists():
        logger.warning("send_document: file not found: %s", doc_path)
        return False

    ct = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    fields: dict[str, str] = {"chat_id": str(chat_id)}
    if caption:
        fields["caption"] = caption[:1024]
    if topic_id is not None:
        fields["message_thread_id"] = str(topic_id)

    body, boundary = _build_multipart(
        fields, [("document", path.name, path.read_bytes(), ct)]
    )
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    req = Request(url, data=body, method="POST",
                  headers={"Content-Type":
                           f"multipart/form-data; boundary={boundary}"})
    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("ok", False)
    except Exception as e:
        logger.warning("send_document failed: %s", e)
        return False


def send_dm_photo(photo_path, caption="", parse_mode="HTML") -> bool:
    """DM으로 사진 전송."""
    return send_photo(DM_CHAT_ID, photo_path, caption=caption,
                      parse_mode=parse_mode)


def send_group_photo(photo_path, caption="", topic_id=None) -> bool:
    """그룹으로 사진 전송."""
    return send_photo(GROUP_CHAT_ID, photo_path, caption=caption,
                      topic_id=topic_id)
