"""
PaddleOCR Document Parsing Library

Simple document parsing API wrapper for PaddleOCR.
"""

import base64
import logging
import math
import os
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote, urlparse

import httpx

logger = logging.getLogger(__name__)

# =============================================================================
# Constants
# =============================================================================

DEFAULT_TIMEOUT = 600  # seconds (10 minutes)
API_GUIDE_URL = "https://paddleocr.com"
FILE_TYPE_PDF = 0
FILE_TYPE_IMAGE = 1
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp")


# =============================================================================
# Environment
# =============================================================================


def _get_env(key: str) -> str:
    """Get environment variable, defaulting to empty string with whitespace stripped."""
    return os.getenv(key, "").strip()


def _http_timeout_from_env(env_key: str, default_seconds: float) -> float:
    """
    Read HTTP client timeout in seconds from the environment.

    Returns a positive finite float. If the variable is missing, empty,
    unparsable, non-finite, or not greater than zero, logs a warning and uses the
    default_seconds argument value.
    """
    raw = os.getenv(env_key)
    if raw is None:
        return float(default_seconds)
    stripped = raw.strip()
    if not stripped:
        return float(default_seconds)
    try:
        timeout = float(stripped)
    except (ValueError, TypeError):
        logger.warning(
            "Invalid %s value %r; using default %ss",
            env_key,
            raw,
            default_seconds,
        )
        return float(default_seconds)
    if not math.isfinite(timeout) or timeout <= 0:
        logger.warning(
            "%s must be a finite number > 0 (got %r); using default %ss",
            env_key,
            raw,
            default_seconds,
        )
        return float(default_seconds)
    return timeout


def _resolve_api_url(api_url: str, env_var: str) -> str:
    """Require https; allow host-only values by prepending https://."""
    if api_url.startswith("http://"):
        raise ValueError(f"{env_var} must use https://; http:// is not allowed.")
    if not api_url.startswith("https://"):
        return f"https://{api_url}"
    return api_url


def get_config() -> tuple[str, str]:
    """
    Get API URL and token from environment.

    Returns:
        tuple of (api_url, token)

    Raises:
        ValueError: If required env vars are missing, API URL uses http://,
            or URL path doesn't end with /layout-parsing
    """
    api_url = _get_env("PADDLEOCR_DOC_PARSING_API_URL")
    token = _get_env("PADDLEOCR_ACCESS_TOKEN")

    if not api_url:
        raise ValueError(
            f"PADDLEOCR_DOC_PARSING_API_URL not configured. Get your API at: {API_GUIDE_URL}"
        )
    if not token:
        raise ValueError(
            f"PADDLEOCR_ACCESS_TOKEN not configured. Get your API at: {API_GUIDE_URL}"
        )

    api_url = _resolve_api_url(api_url, "PADDLEOCR_DOC_PARSING_API_URL")
    api_path = urlparse(api_url).path.rstrip("/")
    if not api_path.endswith("/layout-parsing"):
        raise ValueError(
            "PADDLEOCR_DOC_PARSING_API_URL must be a full endpoint ending with "
            "/layout-parsing. "
            "Example: https://your-service.paddleocr.com/layout-parsing"
        )

    return api_url, token


# =============================================================================
# File Utilities
# =============================================================================


def _detect_file_type(path_or_url: str) -> int:
    """Detect file type: 0=PDF, 1=Image."""
    path = path_or_url.lower()
    if path.startswith(("http://", "https://")):
        path = unquote(urlparse(path).path)

    if path.endswith(".pdf"):
        return FILE_TYPE_PDF
    elif path.endswith(IMAGE_EXTENSIONS):
        return FILE_TYPE_IMAGE
    else:
        raise ValueError(f"Unsupported file format: {path_or_url}")


def _load_file_as_base64(file_path: str) -> str:
    """Load local file and encode as base64."""
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
    if path.stat().st_size == 0:
        raise ValueError(f"File is empty (0 bytes): {file_path}")

    return base64.b64encode(path.read_bytes()).decode("utf-8")


# =============================================================================
# API Request
# =============================================================================


def _make_api_request(
    api_url: str, token: str, params: dict[str, Any]
) -> dict[str, Any]:
    """
    Make PaddleOCR document parsing API request.

    Args:
        api_url: API endpoint URL
        token: Access token
        params: Request parameters

    Returns:
        API response dict

    Raises:
        RuntimeError: On API errors
    """
    headers = {
        "Authorization": f"token {token}",
        "Content-Type": "application/json",
        "Client-Platform": "official-skill",
    }

    timeout = _http_timeout_from_env(
        "PADDLEOCR_DOC_PARSING_TIMEOUT", float(DEFAULT_TIMEOUT)
    )

    try:
        with httpx.Client(timeout=timeout) as client:
            try:
                resp = client.post(api_url, json=params, headers=headers)
            except TypeError as e:
                raise RuntimeError(
                    "Request parameters cannot be JSON-encoded; use only JSON-serializable "
                    f"option values ({e})"
                ) from e
    except httpx.TimeoutException:
        raise RuntimeError(f"API request timed out after {timeout}s")
    except httpx.RequestError as e:
        raise RuntimeError(f"API request failed: {e}")

    if resp.status_code != 200:
        error_detail = ""
        try:
            error_body = resp.json()
            if isinstance(error_body, dict):
                error_detail = str(error_body.get("errorMsg", "")).strip()
        except Exception:
            pass

        if not error_detail:
            error_detail = (resp.text[:200] or "No response body").strip()

        if resp.status_code == 403:
            raise RuntimeError(f"Authentication failed (403): {error_detail}")
        elif resp.status_code == 429:
            raise RuntimeError(f"API rate limit exceeded (429): {error_detail}")
        elif resp.status_code >= 500:
            raise RuntimeError(
                f"API service error ({resp.status_code}): {error_detail}"
            )
        else:
            raise RuntimeError(f"API error ({resp.status_code}): {error_detail}")

    try:
        result = resp.json()
    except Exception:
        raise RuntimeError(f"Invalid JSON response: {resp.text[:200]}")

    if not isinstance(result, dict):
        raise RuntimeError(
            f"Unexpected JSON shape (expected object): {resp.text[:200]}"
        )

    if result.get("errorCode", 0) != 0:
        msg = result.get("errorMsg", "Unknown error")
        raise RuntimeError(f"API error: {msg}")

    return result


# =============================================================================
# Main API
# =============================================================================


def parse_document(
    file_path: Optional[str] = None,
    file_url: Optional[str] = None,
    file_type: Optional[int] = None,
    **options: Any,
) -> dict[str, Any]:
    """
    Parse document with PaddleOCR.

    Args:
        file_path: Local file path (mutually exclusive with file_url)
        file_url: URL to file (mutually exclusive with file_path)
        file_type: Optional file type override (0=PDF, 1=Image)
        **options: Additional API options

    Returns:
        {
            "ok": True,
            "text": "extracted text...",
            "result": { raw API result },
            "error": None
        }
        or on error:
        {
            "ok": False,
            "text": "",
            "result": None,
            "error": {"code": "...", "message": "..."}
        }
    """
    if file_path is not None and not isinstance(file_path, str):
        return _error("INPUT_ERROR", "file_path must be a string or None")
    if file_url is not None and not isinstance(file_url, str):
        return _error("INPUT_ERROR", "file_url must be a string or None")

    fp = file_path.strip() if file_path else ""
    fu = file_url.strip() if file_url else ""
    if fp and fu:
        return _error(
            "INPUT_ERROR",
            "Provide only one of file_path or file_url, not both",
        )
    if not fp and not fu:
        return _error("INPUT_ERROR", "file_path or file_url required")
    if file_type is not None and file_type not in (FILE_TYPE_PDF, FILE_TYPE_IMAGE):
        return _error("INPUT_ERROR", "file_type must be 0 (PDF) or 1 (Image)")

    try:
        api_url, token = get_config()
    except ValueError as e:
        return _error("CONFIG_ERROR", str(e))

    # Build request params
    try:
        resolved_file_type: Optional[int] = None
        if fu:
            params = {"file": fu}
            if file_type is not None:
                resolved_file_type = file_type
            else:
                try:
                    resolved_file_type = _detect_file_type(fu)
                except ValueError:
                    resolved_file_type = None
        else:
            resolved_file_type = (
                file_type if file_type is not None else _detect_file_type(fp)
            )
            params = {
                "file": _load_file_as_base64(fp),
            }

        params["visualize"] = (
            False  # reduce response payload; callers can override via options
        )
        params.update(options)
        if resolved_file_type is not None:
            params["fileType"] = resolved_file_type
        else:
            params.pop("fileType", None)

    except (ValueError, OSError, MemoryError) as e:
        return _error("INPUT_ERROR", str(e))

    try:
        result = _make_api_request(api_url, token, params)
    except RuntimeError as e:
        return _error("API_ERROR", str(e))

    try:
        text = _extract_text(result)
    except ValueError as e:
        return _error("API_ERROR", str(e))

    return {
        "ok": True,
        "text": text,
        "result": result,
        "error": None,
    }


def _extract_text(result: dict[str, Any]) -> str:
    """Extract text from document parsing result."""
    if not isinstance(result, dict):
        raise ValueError("Invalid API response: top-level response must be an object")

    raw_result = result.get("result")
    if not isinstance(raw_result, dict):
        raise ValueError("Invalid API response: missing 'result' object")

    pages = raw_result.get("layoutParsingResults")
    if not isinstance(pages, list):
        raise ValueError(
            "Invalid API response: result.layoutParsingResults must be an array"
        )

    texts = []
    for i, page in enumerate(pages):
        if not isinstance(page, dict):
            raise ValueError(
                f"Invalid API response: result.layoutParsingResults[{i}] must be an object"
            )

        markdown = page.get("markdown")
        if not isinstance(markdown, dict):
            raise ValueError(
                f"Invalid API response: result.layoutParsingResults[{i}].markdown must be an object"
            )

        text = markdown.get("text")
        if not isinstance(text, str):
            raise ValueError(
                f"Invalid API response: result.layoutParsingResults[{i}].markdown.text must be a string"
            )
        texts.append(text)

    return "\n\n".join(texts)


def _error(code: str, message: str) -> dict[str, Any]:
    """Create error response."""
    return {
        "ok": False,
        "text": "",
        "result": None,
        "error": {"code": code, "message": message},
    }
