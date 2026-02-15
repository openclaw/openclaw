"""Shared utilities for Venice AI scripts."""

import base64
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

CLAWDBOT_CONFIG_PATH = Path.home() / ".clawdbot" / "clawdbot.json"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
API_BASE = "https://api.venice.ai/api/v1"


def get_api_key() -> str | None:
    """
    Get API key from multiple sources in order:
    1. VENICE_API_KEY environment variable
    2. ~/.clawdbot/clawdbot.json at skills.entries.venice-ai.env.VENICE_API_KEY
       (also checks venice-ai-media for backward compatibility)
    """
    api_key = os.environ.get("VENICE_API_KEY", "").strip()
    if api_key:
        return api_key

    if CLAWDBOT_CONFIG_PATH.exists():
        try:
            config = json.loads(CLAWDBOT_CONFIG_PATH.read_text(encoding="utf-8"))
            # Check both skill names for backward compatibility
            for skill_name in ("venice-ai", "venice-ai-media"):
                api_key = (
                    config.get("skills", {})
                    .get("entries", {})
                    .get(skill_name, {})
                    .get("env", {})
                    .get("VENICE_API_KEY", "")
                )
                if api_key:
                    return api_key.strip()
        except (json.JSONDecodeError, OSError):
            pass

    return None


def require_api_key() -> str:
    """Get API key or exit with error."""
    api_key = get_api_key()
    if not api_key:
        print("Error: VENICE_API_KEY not found", file=sys.stderr)
        print("Set VENICE_API_KEY env var or configure in ~/.clawdbot/clawdbot.json", file=sys.stderr)
        print("Get your API key at: https://venice.ai/settings/api", file=sys.stderr)
        sys.exit(2)
    return api_key


def make_request(
    endpoint: str,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict | None = None,
    timeout: int = 120,
) -> bytes:
    """Make HTTP request to Venice API with proper headers."""
    url = f"{API_BASE}/{endpoint.lstrip('/')}"
    
    req_headers = {
        "User-Agent": USER_AGENT,
    }
    if headers:
        req_headers.update(headers)

    req = urllib.request.Request(url, method=method, headers=req_headers, data=data)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Venice API error ({e.code}): {error_body}") from e


def api_json(
    endpoint: str,
    method: str = "GET",
    payload: dict | None = None,
    api_key: str | None = None,
    timeout: int = 120,
) -> dict:
    """Make JSON request to Venice API."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    
    if payload:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    else:
        data = None

    resp = make_request(endpoint, method, data, headers, timeout)
    return json.loads(resp.decode("utf-8"))


def list_models(api_key: str, model_type: str = "image") -> list[dict]:
    """Fetch available models from Venice API."""
    data = api_json(f"/models?type={model_type}", api_key=api_key, timeout=30)
    return data.get("data", [])


def print_models(models: list[dict]) -> None:
    """Print models in a formatted table with detailed info."""
    if not models:
        print("No models found.")
        return

    print(f"\n{'Model ID':<35} {'Status':<12} {'Info'}")
    print("-" * 100)
    for m in models:
        model_id = m.get("id", "unknown")
        model_type = m.get("type", "")
        spec = m.get("model_spec", {})
        
        # Determine status from model_spec fields
        if spec.get("offline", False):
            status = "offline"
        elif spec.get("beta", False):
            status = "beta"
        else:
            status = "available"
        
        # Check for deprecation warning
        deprecation = spec.get("deprecation", {})
        if deprecation.get("date"):
            status = "deprecated"
        
        # Build info string based on model type
        info_parts = []
        
        # Description
        desc = spec.get("description", "")
        if desc:
            info_parts.append(desc[:40])
        
        # Model-specific details
        constraints = spec.get("constraints", {})
        
        if model_type == "image":
            # Show resolutions if available
            resolutions = constraints.get("resolutions", [])
            if resolutions:
                info_parts.append(f"res: {'/'.join(resolutions)}")
        
        elif model_type == "video":
            # Show durations and type
            durations = constraints.get("durations", [])
            video_type = constraints.get("model_type", "")
            if video_type:
                info_parts.append(video_type)
            if durations:
                info_parts.append(f"dur: {'/'.join(durations)}")
        
        # Deprecation notice
        if deprecation.get("date"):
            info_parts.insert(0, f"[EOL {deprecation['date'][:10]}]")
        
        info = " | ".join(info_parts) if info_parts else ""
        print(f"{model_id:<35} {status:<12} {info[:55]}")
    
    print()
    print(f"Total: {len(models)} models")


def validate_model(api_key: str, model: str, model_type: str = "image") -> tuple[bool, list[str]]:
    """Check if model exists and is available. Returns (exists, list_of_available_models)."""
    try:
        models = list_models(api_key, model_type)
        # Model is available if it exists and is not offline
        available = [
            m.get("id") for m in models 
            if not m.get("model_spec", {}).get("offline", False)
        ]
        return model in available, available
    except RuntimeError:
        return True, []


def print_media_line(filepath: Path) -> None:
    """Print MEDIA: line for Clawdbot auto-attach."""
    print(f"\nMEDIA: {filepath.as_posix()}")


def get_mime_type(filename: str) -> str:
    """Get MIME type from filename."""
    suffix = Path(filename).suffix.lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
        ".tiff": "image/tiff",
        ".tif": "image/tiff",
    }.get(suffix, "application/octet-stream")


def default_out_dir(prefix: str = "venice") -> Path:
    """Create timestamped output directory."""
    now = dt.datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
    base = Path("./tmp")
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{prefix}-{now}"


def file_to_data_url(filepath: Path) -> str:
    """Convert local file to data URL."""
    suffix = filepath.suffix.lower()
    mime_types = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
    }
    mime = mime_types.get(suffix, "application/octet-stream")
    data = filepath.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"
