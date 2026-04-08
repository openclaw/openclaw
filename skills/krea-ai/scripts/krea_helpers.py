# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///

"""Shared helpers for Krea AI scripts: API calls, polling, retry, error handling."""

import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import mimetypes
import requests

API_BASE = "https://api.krea.ai"
OPENAPI_URL = f"{API_BASE}/openapi.json"


# ── Dynamic model discovery from OpenAPI ─────────────────

_CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "krea")
_CACHE_FILE = os.path.join(_CACHE_DIR, "openapi_models.json")
_CACHE_TTL = 3600

_openapi_data = None


def _load_disk_cache(allow_stale=False):
    if not os.path.isfile(_CACHE_FILE):
        return None
    try:
        mtime = os.path.getmtime(_CACHE_FILE)
        if not allow_stale and (time.time() - mtime > _CACHE_TTL):
            return None
        with open(_CACHE_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _save_disk_cache(data):
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        with open(_CACHE_FILE, "w") as f:
            json.dump(data, f)
    except OSError:
        pass


def _parse_openapi_spec(spec):
    """Extract model data from a parsed OpenAPI spec."""
    image_models = {}
    video_models = {}
    enhancers = {}

    for path, methods in spec.get("paths", {}).items():
        post = methods.get("post")
        if not post:
            continue
        description = post.get("description", post.get("summary", ""))
        rb = (
            post.get("requestBody", {})
            .get("content", {})
            .get("application/json", {})
            .get("schema", {})
        )
        params = sorted((rb.get("properties") or {}).keys())

        cu = None
        cu_match = re.search(r"~?(\d+)\s*(?:CU|compute units)", description, re.IGNORECASE)
        if cu_match:
            cu = int(cu_match.group(1))
        elif "Compute Units" in description:
            table_match = re.search(r"\|\s*~?(\d+)\s*\|", description)
            if table_match:
                cu = int(table_match.group(1))
        # Extract default for "model" field if it exists (used by enhancers)
        model_schema = (rb.get("properties") or {}).get("model", {})
        default_model = (
            model_schema.get("const")
            or model_schema.get("default")
            or (model_schema.get("enum", [None])[0])
        )
        entry = {"endpoint": path, "params": params, "cu": cu}
        if default_model:
            entry["default_model"] = default_model

        if path.startswith("/generate/image/"):
            parts = path.replace("/generate/image/", "").split("/")
            model_id = parts[1] if len(parts) > 1 else parts[0]
            image_models[model_id] = entry
        elif path.startswith("/generate/video/"):
            parts = path.replace("/generate/video/", "").split("/")
            model_id = parts[1] if len(parts) > 1 else parts[0]
            video_models[model_id] = entry
        elif path.startswith("/generate/enhance/"):
            parts = path.replace("/generate/enhance/", "").split("/")
            provider = parts[0] if parts else ""
            model_name = parts[1] if len(parts) > 1 else parts[0]
            eid = f"{provider}-{model_name}" if provider != model_name else model_name
            enhancers[eid] = entry

    return {
        "image_models": image_models,
        "video_models": video_models,
        "enhancers": enhancers,
    }


def _fetch_openapi_data():
    """Get model data: memory → fresh disk cache → live API → stale disk → None."""
    global _openapi_data
    if _openapi_data is not None:
        return _openapi_data

    cached = _load_disk_cache(allow_stale=False)
    if cached:
        _openapi_data = cached
        return cached

    try:
        r = requests.get(OPENAPI_URL, timeout=15)
        r.raise_for_status()
        data = _parse_openapi_spec(r.json())
        _openapi_data = data
        _save_disk_cache(data)
        return data
    except Exception as e:
        print(
            f"Warning: Could not fetch live OpenAPI spec ({e}), checking stale cache...",
            file=sys.stderr,
        )

    stale = _load_disk_cache(allow_stale=True)
    if stale:
        print("Warning: Using stale model cache. Run list_models.py to refresh.", file=sys.stderr)
        _openapi_data = stale
        return stale

    print(
        "Warning: No model data available (network unreachable, no cache). "
        "Model names will be resolved as endpoint suffixes.",
        file=sys.stderr,
    )
    return None


def _build_models_dict(category):
    """Build {name: endpoint} from OpenAPI data."""
    data = _fetch_openapi_data()
    if not data:
        return {}
    return {model_id: info["endpoint"] for model_id, info in data.get(category, {}).items()}


def get_image_models():
    """Return {name: endpoint} for all image models (from OpenAPI)."""
    return _build_models_dict("image_models")


def get_video_models():
    """Return {name: endpoint} for all video models (from OpenAPI)."""
    return _build_models_dict("video_models")


def get_enhancers():
    """Return {name: endpoint} for all enhancers (from OpenAPI)."""
    return _build_models_dict("enhancers")


def get_default_enhancer_model(enhancer_id):
    """Return the default sub-model for an enhancer (from OpenAPI schema), or None."""
    data = _fetch_openapi_data()
    if not data:
        return None
    info = data.get("enhancers", {}).get(enhancer_id)
    return info.get("default_model") if info else None


def _get_endpoint_params(endpoint_path):
    """Get the set of accepted request body params for an endpoint."""
    data = _fetch_openapi_data()
    if not data:
        return None
    for category in ("image_models", "video_models", "enhancers"):
        for info in data.get(category, {}).values():
            if info["endpoint"] == endpoint_path:
                return set(info.get("params", []))
    return None


def resolve_model(model_arg, models_dict, prefix):
    """Resolve a short model name, raw suffix, or full endpoint path."""
    if model_arg in models_dict:
        return models_dict[model_arg]
    if model_arg.startswith(prefix):
        return model_arg
    for ep in models_dict.values():
        if ep.endswith("/" + model_arg):
            return ep
    available = ", ".join(sorted(models_dict.keys())[:15])
    print(
        f"Error: Unknown model '{model_arg}'. "
        f"Run list_models.py to see available models.\n"
        f"  Some available: {available} ...",
        file=sys.stderr,
    )
    sys.exit(1)


def get_cu_estimate(action, model_or_enhancer):
    """Return estimated CU cost from OpenAPI descriptions, or None if unknown."""
    data = _fetch_openapi_data()
    if not data:
        return None
    category_map = {
        "generate_image": "image_models",
        "generate_video": "video_models",
        "enhance": "enhancers",
    }
    category = category_map.get(action)
    if not category:
        return None
    info = data.get(category, {}).get(model_or_enhancer)
    return info.get("cu") if info else None


# ── API key ──────────────────────────────────────────────

def get_api_key(args_key=None):
    key = args_key or os.environ.get("KREA_API_TOKEN")
    if not key:
        print("Error: No API key provided. Set KREA_API_TOKEN or pass --api-key", file=sys.stderr)
        sys.exit(1)
    return key


# ── Error formatting ─────────────────────────────────────

def _format_loc(loc):
    if loc is None:
        return ""
    if isinstance(loc, (list, tuple)):
        return ".".join(str(x) for x in loc if x not in ("body", "query", "path"))
    return str(loc)


def extract_validation_details(data):
    """Pull field-level validation messages from common API JSON error shapes."""
    if not isinstance(data, dict):
        return []
    lines = []

    detail = data.get("detail")
    if isinstance(detail, list):
        for item in detail:
            if isinstance(item, dict):
                loc = _format_loc(item.get("loc") or item.get("path"))
                m = item.get("msg") or item.get("message") or item.get("type") or ""
                if loc and m:
                    lines.append(f"{loc}: {m}")
                elif m:
                    lines.append(m)
            elif isinstance(item, str):
                lines.append(item)
    elif isinstance(detail, str) and detail.strip():
        lines.append(detail.strip())

    for key in ("details", "errors", "issues", "validationErrors", "validation_errors"):
        arr = data.get(key)
        if not isinstance(arr, list):
            continue
        for item in arr:
            if isinstance(item, dict):
                loc = _format_loc(item.get("path") or item.get("loc") or item.get("field"))
                m = item.get("message") or item.get("msg") or item.get("error") or item.get("type")
                if loc and m:
                    lines.append(f"{loc}: {m}")
                elif m:
                    lines.append(str(m))
            elif isinstance(item, str):
                lines.append(item)

    nested = data.get("error")
    if isinstance(nested, dict):
        lines.extend(extract_validation_details(nested))

    return lines


def format_api_error(status_code, response_text):
    """Return a human-readable error message for API errors."""
    msg = f"API error {status_code}"
    data = None
    try:
        data = json.loads(response_text)
    except (json.JSONDecodeError, TypeError):
        pass

    error = ""
    if isinstance(data, dict):
        err_field = data.get("error")
        if isinstance(err_field, str):
            error = err_field
        elif err_field is not None and not isinstance(err_field, dict):
            error = str(err_field)
        if not error:
            error = data.get("message", "") or ""
        if isinstance(error, str) and error.lower() in ("validation failed", "request validation failed"):
            error = ""
    else:
        error = response_text if isinstance(response_text, str) else ""

    validation_lines = extract_validation_details(data) if isinstance(data, dict) else []

    if status_code == 401:
        return f"{msg}: Authentication failed. Check your KREA_API_TOKEN."
    elif status_code == 402:
        err_str = str(error).lower()
        if "insufficient" in err_str or "balance" in err_str:
            return f"{msg}: Insufficient credits. Top up at https://krea.ai/settings/billing"
        elif "plan" in err_str or "requires" in err_str:
            return f"{msg}: This model requires a higher plan. Upgrade at https://krea.ai/settings/billing"
        return f"{msg}: Payment required — {error}"
    elif status_code == 429:
        return f"{msg}: Rate limited (too many concurrent jobs). Will retry..."
    elif status_code == 422 and validation_lines:
        joined = "; ".join(validation_lines)
        return f"{msg} (validation): {joined}"
    elif status_code == 422 and error:
        return f"{msg}: {error}"
    elif status_code == 422:
        return f"{msg}: {response_text[:500]}"
    else:
        if validation_lines:
            extra = "; ".join(validation_lines)
            base = error or response_text[:300]
            return f"{msg}: {base} — {extra}" if base else f"{msg}: {extra}"
        return f"{msg}: {error or response_text[:500]}"


# ── Image dimensions / aspect ratio ──────────────────────

def image_endpoint_supports_aspect_ratio(endpoint_path):
    """Check via OpenAPI if this endpoint accepts aspectRatio."""
    params = _get_endpoint_params(endpoint_path)
    if params is not None:
        return "aspectRatio" in params
    return "/google/nano-banana" in endpoint_path


def image_endpoint_accepts_pixel_dimensions(endpoint_path):
    """Check via OpenAPI if this endpoint accepts width/height."""
    params = _get_endpoint_params(endpoint_path)
    if params is not None:
        return "width" in params or "height" in params
    return True


def parse_aspect_ratio(ratio):
    """Parse '16:9' / '9:16' into positive floats (width_factor, height_factor)."""
    s = ratio.strip().replace(" ", "")
    if ":" not in s:
        raise ValueError(f"Invalid aspect ratio {ratio!r}: expected W:H (e.g. 16:9)")
    a, b = s.split(":", 1)
    try:
        aw, ah = float(a), float(b)
    except ValueError as e:
        raise ValueError(f"Invalid aspect ratio {ratio!r}: {e}") from e
    if aw <= 0 or ah <= 0:
        raise ValueError(f"Invalid aspect ratio {ratio!r}: parts must be positive")
    return aw, ah


def aspect_ratio_to_dimensions(ratio, max_side=1024, multiple=8):
    """Map aspect ratio to pixel width/height (longer side ~= max_side, multiples of `multiple`)."""
    aw, ah = parse_aspect_ratio(ratio)
    if aw >= ah:
        w = max_side
        h = w * ah / aw
    else:
        h = max_side
        w = h * aw / ah
    w = max(multiple, int(round(w / multiple)) * multiple)
    h = max(multiple, int(round(h / multiple)) * multiple)
    return w, h


def height_for_width_aspect(width, ratio, multiple=8):
    aw, ah = parse_aspect_ratio(ratio)
    h = width * ah / aw
    return max(multiple, int(round(h / multiple)) * multiple)


def width_for_height_aspect(height, ratio, multiple=8):
    aw, ah = parse_aspect_ratio(ratio)
    w = height * aw / ah
    return max(multiple, int(round(w / multiple)) * multiple)


# ── API call with retry ──────────────────────────────────

def api_post(api_key, endpoint, body, max_retries=3):
    """POST to the Krea API with automatic retry on 429."""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    delays = [5, 15, 45]

    for attempt in range(max_retries + 1):
        r = requests.post(f"{API_BASE}{endpoint}", headers=headers, json=body)
        if r.ok:
            return r.json()
        if r.status_code == 429 and attempt < max_retries:
            delay = delays[min(attempt, len(delays) - 1)]
            print(f"  Rate limited, retrying in {delay}s (attempt {attempt + 1}/{max_retries})...", file=sys.stderr)
            time.sleep(delay)
            continue
        msg = format_api_error(r.status_code, r.text)
        print(f"Error: {msg}", file=sys.stderr)
        sys.exit(1)


def api_get(api_key, path, max_retries=3):
    """GET from the Krea API with automatic retry on 429."""
    headers = {"Authorization": f"Bearer {api_key}"}
    delays = [5, 15, 45]

    for attempt in range(max_retries + 1):
        r = requests.get(f"{API_BASE}{path}", headers=headers)
        if r.ok:
            return r.json()
        if r.status_code == 429 and attempt < max_retries:
            delay = delays[min(attempt, len(delays) - 1)]
            print(f"  Rate limited, retrying in {delay}s...", file=sys.stderr)
            time.sleep(delay)
            continue
        msg = format_api_error(r.status_code, r.text)
        print(f"Error: {msg}", file=sys.stderr)
        sys.exit(1)


# ── Job polling ──────────────────────────────────────────

def poll_job(api_key, job_id, interval=3, timeout=600):
    """Poll a job until it reaches a terminal state."""
    start = time.time()
    while time.time() - start < timeout:
        job = api_get(api_key, f"/jobs/{job_id}")
        status = job.get("status", "")
        if status == "completed":
            return job
        if status == "failed":
            error_detail = json.dumps(job.get("result", {}))
            print(f"Error: Job failed: {error_detail}", file=sys.stderr)
            sys.exit(1)
        if status == "cancelled":
            print("Error: Job was cancelled", file=sys.stderr)
            sys.exit(1)
        print(f"  [{job_id[:8]}] {status}...", file=sys.stderr)
        time.sleep(interval)
    print(f"Error: Job timed out after {timeout}s", file=sys.stderr)
    sys.exit(1)


# ── File download ────────────────────────────────────────

def download_file(url, filename):
    """Download a URL to a local file."""
    os.makedirs(os.path.dirname(filename), exist_ok=True) if os.path.dirname(filename) else None
    r = requests.get(url, stream=True)
    r.raise_for_status()
    with open(filename, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
    return os.path.abspath(filename)


# ── Local image → URL helper ─────────────────────────────

def ensure_image_url(path_or_url, api_key):
    """If the input is a local file path, upload it via the Krea assets API
    and return the hosted URL. If it's already a URL, return as-is."""
    if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
        return path_or_url

    local_path = path_or_url
    if local_path.startswith("file://"):
        local_path = local_path[7:]

    if not os.path.isfile(local_path):
        print(f"Error: Local file not found: {local_path}", file=sys.stderr)
        sys.exit(1)

    mime_type = mimetypes.guess_type(local_path)[0] or "application/octet-stream"
    ext = os.path.splitext(local_path)[1].lstrip(".")

    boundary = f"----KreaBoundary{int(time.time())}"
    with open(local_path, "rb") as f:
        file_data = f.read()

    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"upload.{ext}\"\r\nContent-Type: {mime_type}\r\n\r\n".encode())
    parts.append(file_data)
    parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())

    body = b"".join(parts)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }

    print(f"  Uploading local file: {local_path}...", file=sys.stderr)
    r = requests.post(f"{API_BASE}/assets", headers=headers, data=body)
    if not r.ok:
        msg = format_api_error(r.status_code, r.text)
        print(f"Error uploading asset: {msg}", file=sys.stderr)
        sys.exit(1)

    asset = r.json()
    url = asset.get("image_url") or asset.get("url")
    if not url:
        print(f"Error: Upload succeeded but no URL returned: {json.dumps(asset)}", file=sys.stderr)
        sys.exit(1)

    print(f"  Uploaded: {url}", file=sys.stderr)
    return url


# ── Output path helper ───────────────────────────────────

def output_path(filename, output_dir=None):
    """Join filename with output_dir if provided."""
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        return os.path.join(output_dir, os.path.basename(filename))
    return filename


# ── Desktop notification ─────────────────────────────────

def send_notification(title, message):
    """Send a desktop notification. Best-effort, never raises."""
    try:
        system = platform.system()
        if system == "Linux" and shutil.which("notify-send"):
            subprocess.run(["notify-send", title, message], timeout=5)
        elif system == "Darwin":
            script = f'display notification "{message}" with title "{title}"'
            subprocess.run(["osascript", "-e", script], timeout=5)
        else:
            print("\a", end="", file=sys.stderr)
    except Exception:
        pass
