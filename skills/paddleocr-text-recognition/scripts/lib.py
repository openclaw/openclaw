# Copyright (c) 2025 PaddlePaddle Authors. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
PaddleOCR Text Recognition Library

Simple OCR API wrapper for PaddleOCR text recognition.
"""

import base64
import logging
import os
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote, urlparse

import httpx

logger = logging.getLogger(__name__)

# =============================================================================
# Constants
# =============================================================================

DEFAULT_TIMEOUT = 120  # seconds
API_GUIDE_URL = "https://paddleocr.com"
FILE_TYPE_PDF = 0
FILE_TYPE_IMAGE = 1
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp")

# =============================================================================
# Environment
# =============================================================================


def _get_env(key: str) -> str:
    """Get environment variable."""
    return os.getenv(key, "").strip()


def get_config() -> tuple[str, str]:
    """
    Get API URL and token from environment.

    Returns:
        tuple of (api_url, token)

    Raises:
        ValueError: If not configured
    """
    api_url = _get_env("PADDLEOCR_OCR_API_URL")
    token = _get_env("PADDLEOCR_ACCESS_TOKEN")

    if not api_url:
        raise ValueError(
            f"PADDLEOCR_OCR_API_URL not configured. Get your API at: {API_GUIDE_URL}"
        )
    if not token:
        raise ValueError(
            f"PADDLEOCR_ACCESS_TOKEN not configured. Get your API at: {API_GUIDE_URL}"
        )

    # Normalize URL
    if not api_url.startswith("https://"):
        api_url = f"https://{api_url}"
    api_path = urlparse(api_url).path.rstrip("/")
    if not api_path.endswith("/ocr"):
        raise ValueError(
            "PADDLEOCR_OCR_API_URL must be a full endpoint ending with /ocr. "
            "Example: https://your-service.paddleocr.com/ocr"
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
    return base64.b64encode(path.read_bytes()).decode("utf-8")


# =============================================================================
# API Request
# =============================================================================


def _make_api_request(api_url: str, token: str, params: dict) -> dict:
    """
    Make PaddleOCR API request.

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

    try:
        timeout = float(os.getenv("PADDLEOCR_OCR_TIMEOUT", str(DEFAULT_TIMEOUT)))
    except (ValueError, TypeError):
        logger.warning(
            "Invalid PADDLEOCR_OCR_TIMEOUT value, using default %ds",
            DEFAULT_TIMEOUT,
        )
        timeout = float(DEFAULT_TIMEOUT)

    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(api_url, json=params, headers=headers)
    except httpx.TimeoutException:
        raise RuntimeError(f"API request timed out after {timeout}s")
    except httpx.RequestError as e:
        raise RuntimeError(f"API request failed: {e}")

    # Handle HTTP errors
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

    # Parse response
    try:
        result = resp.json()
    except Exception:
        raise RuntimeError(f"Invalid JSON response: {resp.text[:200]}")

    # Check API-level error
    if result.get("errorCode", 0) != 0:
        raise RuntimeError(f"API error: {result.get('errorMsg', 'Unknown error')}")

    return result


# =============================================================================
# Main API
# =============================================================================


def ocr(
    file_path: Optional[str] = None,
    file_url: Optional[str] = None,
    file_type: Optional[int] = None,
    **options,
) -> dict[str, Any]:
    """
    Perform OCR on image or PDF.

    Args:
        file_path: Local file path
        file_url: URL to file
        file_type: Optional file type override (0=PDF, 1=Image)
        **options: Additional API options (passed directly to API)

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
    # Validate input
    if not file_path and not file_url:
        return _error("INPUT_ERROR", "file_path or file_url required")
    if file_type is not None and file_type not in (FILE_TYPE_PDF, FILE_TYPE_IMAGE):
        return _error("INPUT_ERROR", "file_type must be 0 (PDF) or 1 (Image)")

    # Get config
    try:
        api_url, token = get_config()
    except ValueError as e:
        return _error("CONFIG_ERROR", str(e))

    # Build request params
    try:
        resolved_file_type: Optional[int] = None
        if file_url:
            params = {"file": file_url}
            if file_type is not None:
                resolved_file_type = file_type
            else:
                try:
                    resolved_file_type = _detect_file_type(file_url)
                except ValueError:
                    resolved_file_type = None
        else:
            params = {"file": _load_file_as_base64(file_path)}
            resolved_file_type = (
                file_type if file_type is not None else _detect_file_type(file_path)
            )

        params["visualize"] = False
        params.update(options)
        if resolved_file_type is not None:
            params["fileType"] = resolved_file_type
        else:
            params.pop("fileType", None)

    except (ValueError, FileNotFoundError) as e:
        return _error("INPUT_ERROR", str(e))

    # Call API
    try:
        result = _make_api_request(api_url, token, params)
    except RuntimeError as e:
        return _error("API_ERROR", str(e))

    # Extract text
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


def _extract_text(result: dict) -> str:
    """Extract text from OCR result."""
    if not isinstance(result, dict):
        raise ValueError(
            "Invalid response schema: top-level response must be an object"
        )

    raw_result = result.get("result")
    if not isinstance(raw_result, dict):
        raise ValueError("Invalid response schema: missing result object")

    pages = raw_result.get("ocrResults")
    if not isinstance(pages, list):
        raise ValueError("Invalid response schema: result.ocrResults must be an array")

    all_text = []
    for item in pages:
        if not isinstance(item, dict):
            continue
        texts = item.get("prunedResult", {}).get("rec_texts", [])
        if texts:
            all_text.append("\n".join(texts))
    return "\n\n".join(all_text)


def _error(code: str, message: str) -> dict:
    """Create error response."""
    return {
        "ok": False,
        "text": "",
        "result": None,
        "error": {"code": code, "message": message},
    }
