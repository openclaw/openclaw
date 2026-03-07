#!/usr/bin/env python3
"""
Small local ComfyUI bridge for OpenClaw orchestration.

Endpoints:
  GET  /health
  POST /v1/generate-sync
"""

from __future__ import annotations

import json
import mimetypes
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")
BRIDGE_HOST = os.environ.get("COMFY_BRIDGE_HOST", "127.0.0.1")
BRIDGE_PORT = int(os.environ.get("COMFY_BRIDGE_PORT", "8787"))
BRIDGE_OUTPUT_DIR = Path(
    os.environ.get("COMFY_BRIDGE_OUTPUT_DIR", str(Path.home() / ".local/share/comfyui/output"))
).expanduser()
ALLOWED_ROOTS_ENV = os.environ.get("COMFY_ALLOWED_ROOTS", "")


def _parse_allowed_roots() -> list[Path]:
    if ALLOWED_ROOTS_ENV.strip():
        roots = [Path(entry).expanduser().resolve() for entry in ALLOWED_ROOTS_ENV.split(os.pathsep) if entry]
        if roots:
            return roots
    return [
        Path.cwd().resolve(),
        Path.home().resolve(),
        Path("/tmp").resolve(),
    ]


ALLOWED_ROOTS = _parse_allowed_roots()
BRIDGE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


class BridgeError(Exception):
    def __init__(self, code: str, message: str, status: int = HTTPStatus.BAD_REQUEST, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = int(status)
        self.details = details


@dataclass
class GenerateRequest:
    mode: str
    prompt: str
    negative_prompt: str
    width: int
    height: int
    steps: int
    guidance: float
    seed: int | None
    model: str | None
    init_image_path: str | None
    denoise: float | None
    control: list[dict[str, Any]]
    ip_adapter: dict[str, Any] | None
    loras: list[dict[str, Any]]
    workflow_path: str | None
    timeout_ms: int


def _is_path_under_roots(path_value: Path, roots: list[Path]) -> bool:
    resolved = path_value.resolve()
    for root in roots:
        root_resolved = root.resolve()
        if resolved == root_resolved:
            return True
        if root_resolved in resolved.parents:
            return True
    return False


def _validated_existing_path(raw: Any, label: str) -> Path | None:
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        raise BridgeError("invalid_path", f"{label} must be a non-empty string")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise BridgeError("invalid_path", f"{label} must be an absolute path")
    if not candidate.exists():
        raise BridgeError("missing_path", f"{label} does not exist: {candidate}")
    if not candidate.is_file():
        raise BridgeError("invalid_path", f"{label} must point to a file")
    if not _is_path_under_roots(candidate, ALLOWED_ROOTS):
        raise BridgeError("blocked_path", f"{label} is outside COMFY_ALLOWED_ROOTS")
    return candidate.resolve()


def _read_number(
    payload: dict[str, Any],
    key: str,
    default_value: float | int,
    minimum: float,
    maximum: float,
    integer: bool = False,
) -> float | int:
    value = payload.get(key, default_value)
    if not isinstance(value, (int, float)):
        raise BridgeError("invalid_request", f"{key} must be numeric")
    numeric = int(value) if integer else float(value)
    if numeric < minimum or numeric > maximum:
        raise BridgeError("invalid_request", f"{key} must be between {minimum} and {maximum}")
    return numeric


def _normalize_generate_request(payload: Any) -> GenerateRequest:
    if not isinstance(payload, dict):
        raise BridgeError("invalid_request", "request body must be a JSON object")

    mode = payload.get("mode", "txt2img")
    if mode not in ("txt2img", "img2img"):
        raise BridgeError("invalid_request", "mode must be txt2img or img2img")

    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise BridgeError("invalid_request", "prompt is required")

    timeout_ms = int(_read_number(payload, "timeout_ms", 180000, 1000, 600000, integer=True))
    width = int(_read_number(payload, "width", 1024, 64, 4096, integer=True))
    height = int(_read_number(payload, "height", 1024, 64, 4096, integer=True))
    steps = int(_read_number(payload, "steps", 28, 1, 200, integer=True))
    guidance = float(_read_number(payload, "guidance", 3.5, 0, 30))

    seed_raw = payload.get("seed")
    if seed_raw is not None and not isinstance(seed_raw, (int, float)):
        raise BridgeError("invalid_request", "seed must be numeric when provided")
    seed = int(seed_raw) if seed_raw is not None else None

    denoise_raw = payload.get("denoise")
    if denoise_raw is not None and not isinstance(denoise_raw, (int, float)):
        raise BridgeError("invalid_request", "denoise must be numeric when provided")
    denoise = float(denoise_raw) if denoise_raw is not None else None
    if denoise is not None and (denoise < 0 or denoise > 1):
        raise BridgeError("invalid_request", "denoise must be between 0 and 1")

    model_raw = payload.get("model")
    model = model_raw.strip() if isinstance(model_raw, str) and model_raw.strip() else None

    init_image_path_obj = _validated_existing_path(payload.get("init_image_path"), "init_image_path")
    init_image_path = str(init_image_path_obj) if init_image_path_obj else None
    if mode == "img2img" and not init_image_path:
        raise BridgeError("invalid_request", "init_image_path is required when mode=img2img")

    workflow_path_obj = _validated_existing_path(payload.get("workflow_path"), "workflow_path")
    workflow_path = str(workflow_path_obj) if workflow_path_obj else None

    control_raw = payload.get("control") or []
    if not isinstance(control_raw, list):
        raise BridgeError("invalid_request", "control must be an array")
    if len(control_raw) > 8:
        raise BridgeError("invalid_request", "control supports at most 8 entries")
    control: list[dict[str, Any]] = []
    for idx, entry in enumerate(control_raw, start=1):
        if not isinstance(entry, dict):
            raise BridgeError("invalid_request", f"control[{idx}] must be an object")
        control_type = entry.get("type")
        if not isinstance(control_type, str) or not control_type.strip():
            raise BridgeError("invalid_request", f"control[{idx}].type is required")
        image_path_obj = _validated_existing_path(entry.get("image_path"), f"control[{idx}].image_path")
        if image_path_obj is None:
            raise BridgeError("invalid_request", f"control[{idx}].image_path is required")
        normalized_entry = {
            "type": control_type.strip(),
            "image_path": str(image_path_obj),
        }
        for key, minimum, maximum in (
            ("strength", 0, 2),
            ("start", 0, 1),
            ("end", 0, 1),
        ):
            value = entry.get(key)
            if value is None:
                continue
            if not isinstance(value, (int, float)):
                raise BridgeError("invalid_request", f"control[{idx}].{key} must be numeric")
            numeric = float(value)
            if numeric < minimum or numeric > maximum:
                raise BridgeError(
                    "invalid_request",
                    f"control[{idx}].{key} must be between {minimum} and {maximum}",
                )
            normalized_entry[key] = numeric
        control.append(normalized_entry)

    ip_adapter_raw = payload.get("ip_adapter")
    ip_adapter: dict[str, Any] | None = None
    if ip_adapter_raw is not None:
        if not isinstance(ip_adapter_raw, dict):
            raise BridgeError("invalid_request", "ip_adapter must be an object")
        image_path_obj = _validated_existing_path(ip_adapter_raw.get("image_path"), "ip_adapter.image_path")
        if image_path_obj is None:
            raise BridgeError("invalid_request", "ip_adapter.image_path is required")
        ip_adapter = {"image_path": str(image_path_obj)}
        weight_raw = ip_adapter_raw.get("weight")
        if weight_raw is not None:
            if not isinstance(weight_raw, (int, float)):
                raise BridgeError("invalid_request", "ip_adapter.weight must be numeric")
            weight = float(weight_raw)
            if weight < 0 or weight > 2:
                raise BridgeError("invalid_request", "ip_adapter.weight must be between 0 and 2")
            ip_adapter["weight"] = weight

    loras_raw = payload.get("loras") or []
    if not isinstance(loras_raw, list):
        raise BridgeError("invalid_request", "loras must be an array")
    if len(loras_raw) > 8:
        raise BridgeError("invalid_request", "loras supports at most 8 entries")
    loras: list[dict[str, Any]] = []
    for idx, entry in enumerate(loras_raw, start=1):
        if not isinstance(entry, dict):
            raise BridgeError("invalid_request", f"loras[{idx}] must be an object")
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            raise BridgeError("invalid_request", f"loras[{idx}].name is required")
        normalized_entry: dict[str, Any] = {"name": name.strip()}
        scale_raw = entry.get("scale")
        if scale_raw is not None:
            if not isinstance(scale_raw, (int, float)):
                raise BridgeError("invalid_request", f"loras[{idx}].scale must be numeric")
            scale = float(scale_raw)
            if scale < 0 or scale > 2:
                raise BridgeError("invalid_request", f"loras[{idx}].scale must be between 0 and 2")
            normalized_entry["scale"] = scale
        loras.append(normalized_entry)

    if (control or ip_adapter or loras) and not workflow_path:
        raise BridgeError(
            "workflow_required",
            "control/ip_adapter/loras require workflow_path so placeholders can be mapped",
        )

    negative_prompt = payload.get("negative_prompt", "")
    if not isinstance(negative_prompt, str):
        raise BridgeError("invalid_request", "negative_prompt must be a string when provided")

    return GenerateRequest(
        mode=mode,
        prompt=prompt.strip(),
        negative_prompt=negative_prompt.strip(),
        width=width,
        height=height,
        steps=steps,
        guidance=guidance,
        seed=seed,
        model=model,
        init_image_path=init_image_path,
        denoise=denoise,
        control=control,
        ip_adapter=ip_adapter,
        loras=loras,
        workflow_path=workflow_path,
        timeout_ms=timeout_ms,
    )


def _comfy_json_request(method: str, path: str, payload: dict[str, Any] | None = None, timeout: float = 30.0):
    url = f"{COMFYUI_URL}{path}"
    body: bytes | None = None
    headers = {}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method.upper(), data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return {}
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise BridgeError("comfy_http_error", f"ComfyUI HTTP {exc.code}: {detail}", status=HTTPStatus.BAD_GATEWAY)
    except urllib.error.URLError as exc:
        raise BridgeError("comfy_unreachable", f"ComfyUI unavailable at {COMFYUI_URL}: {exc}", status=HTTPStatus.BAD_GATEWAY)


def _comfy_raw_get(path: str, timeout: float = 30.0) -> bytes:
    req = urllib.request.Request(f"{COMFYUI_URL}{path}", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise BridgeError("comfy_http_error", f"ComfyUI HTTP {exc.code}: {detail}", status=HTTPStatus.BAD_GATEWAY)
    except urllib.error.URLError as exc:
        raise BridgeError("comfy_unreachable", f"ComfyUI unavailable at {COMFYUI_URL}: {exc}", status=HTTPStatus.BAD_GATEWAY)


def _list_available_checkpoints() -> list[str]:
    object_info = _comfy_json_request("GET", "/object_info", timeout=15)
    if not isinstance(object_info, dict):
        return []
    loader_info = object_info.get("CheckpointLoaderSimple")
    if not isinstance(loader_info, dict):
        return []
    input_info = loader_info.get("input")
    if not isinstance(input_info, dict):
        return []
    required_info = input_info.get("required")
    if not isinstance(required_info, dict):
        return []
    ckpt_name_config = required_info.get("ckpt_name")
    if not isinstance(ckpt_name_config, list) or not ckpt_name_config:
        return []
    choices = ckpt_name_config[0]
    if not isinstance(choices, list):
        return []
    out: list[str] = []
    for choice in choices:
        if isinstance(choice, str) and choice.strip():
            out.append(choice.strip())
    return out


def _resolve_checkpoint_model(requested_model: str | None) -> str:
    available = _list_available_checkpoints()
    if not available:
        raise BridgeError(
            "missing_model",
            (
                "No checkpoint models found. Add a .safetensors/.ckpt file under "
                "ComfyUI/models/checkpoints and restart ComfyUI."
            ),
        )
    if requested_model:
        if requested_model not in available:
            preview = ", ".join(available[:5])
            suffix = " ..." if len(available) > 5 else ""
            raise BridgeError(
                "missing_model",
                f"Requested model '{requested_model}' is not available. Known checkpoints: {preview}{suffix}",
            )
        return requested_model
    return available[0]


def _upload_image(image_path: Path) -> str:
    boundary = f"----OpenClawBridge{secrets.token_hex(8)}"
    mime = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
    file_bytes = image_path.read_bytes()
    parts: list[bytes] = []
    parts.append(f"--{boundary}\r\n".encode("utf-8"))
    parts.append(
        (
            f'Content-Disposition: form-data; name="image"; filename="{image_path.name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("utf-8")
    )
    parts.append(file_bytes)
    parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)

    req = urllib.request.Request(
        f"{COMFYUI_URL}/upload/image",
        method="POST",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise BridgeError("upload_failed", f"ComfyUI image upload failed ({exc.code}): {detail}", status=HTTPStatus.BAD_GATEWAY)
    except urllib.error.URLError as exc:
        raise BridgeError("upload_failed", f"ComfyUI image upload failed: {exc}", status=HTTPStatus.BAD_GATEWAY)

    filename = payload.get("name")
    if not isinstance(filename, str) or not filename.strip():
        raise BridgeError("upload_failed", "ComfyUI upload response missing image name", status=HTTPStatus.BAD_GATEWAY)
    return filename


def _build_default_txt2img(req: GenerateRequest) -> dict[str, Any]:
    seed = req.seed if req.seed is not None else int(time.time_ns() % 2_147_483_647)
    model_name = _resolve_checkpoint_model(req.model)
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model_name}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": req.prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": req.negative_prompt, "clip": ["1", 1]}},
        "4": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": req.width, "height": req.height, "batch_size": 1},
        },
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": req.steps,
                "cfg": req.guidance,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1,
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0],
            },
        },
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"filename_prefix": "openclaw", "images": ["6", 0]}},
    }


def _build_default_img2img(req: GenerateRequest, init_upload_name: str) -> dict[str, Any]:
    seed = req.seed if req.seed is not None else int(time.time_ns() % 2_147_483_647)
    model_name = _resolve_checkpoint_model(req.model)
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model_name}},
        "2": {"class_type": "LoadImage", "inputs": {"image": init_upload_name}},
        "3": {"class_type": "VAEEncode", "inputs": {"pixels": ["2", 0], "vae": ["1", 2]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": req.prompt, "clip": ["1", 1]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": req.negative_prompt, "clip": ["1", 1]}},
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": req.steps,
                "cfg": req.guidance,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": req.denoise if req.denoise is not None else 0.75,
                "model": ["1", 0],
                "positive": ["4", 0],
                "negative": ["5", 0],
                "latent_image": ["3", 0],
            },
        },
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
        "8": {"class_type": "SaveImage", "inputs": {"filename_prefix": "openclaw", "images": ["7", 0]}},
    }


def _replace_placeholders(value: Any, mapping: dict[str, Any]) -> Any:
    if isinstance(value, str) and value in mapping:
        return mapping[value]
    if isinstance(value, list):
        return [_replace_placeholders(entry, mapping) for entry in value]
    if isinstance(value, dict):
        return {key: _replace_placeholders(entry, mapping) for key, entry in value.items()}
    return value


def _collect_unresolved_placeholders(value: Any, out: set[str]) -> None:
    if isinstance(value, str) and value.startswith("$OPENCLAW_"):
        out.add(value)
        return
    if isinstance(value, list):
        for entry in value:
            _collect_unresolved_placeholders(entry, out)
        return
    if isinstance(value, dict):
        for entry in value.values():
            _collect_unresolved_placeholders(entry, out)


def _load_custom_workflow(req: GenerateRequest, upload_refs: dict[str, str]) -> dict[str, Any]:
    workflow_path = Path(req.workflow_path or "")
    try:
        workflow_data = json.loads(workflow_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise BridgeError("workflow_read_failed", f"Failed to read workflow_path: {exc}")
    except json.JSONDecodeError as exc:
        raise BridgeError("workflow_invalid_json", f"workflow_path is not valid JSON: {exc}")

    if not isinstance(workflow_data, dict):
        raise BridgeError("workflow_invalid_json", "workflow_path must contain a JSON object")

    seed_value = req.seed if req.seed is not None else int(time.time_ns() % 2_147_483_647)
    placeholder_map: dict[str, Any] = {
        "$OPENCLAW_PROMPT": req.prompt,
        "$OPENCLAW_NEGATIVE_PROMPT": req.negative_prompt,
        "$OPENCLAW_WIDTH": req.width,
        "$OPENCLAW_HEIGHT": req.height,
        "$OPENCLAW_STEPS": req.steps,
        "$OPENCLAW_GUIDANCE": req.guidance,
        "$OPENCLAW_SEED": seed_value,
        "$OPENCLAW_DENOISE": req.denoise if req.denoise is not None else 0.75,
    }
    if req.model:
        placeholder_map["$OPENCLAW_MODEL"] = req.model
    if "init_image" in upload_refs:
        placeholder_map["$OPENCLAW_INIT_IMAGE"] = upload_refs["init_image"]
    if "ip_image" in upload_refs:
        placeholder_map["$OPENCLAW_IPADAPTER_IMAGE"] = upload_refs["ip_image"]
    if req.ip_adapter and "weight" in req.ip_adapter:
        placeholder_map["$OPENCLAW_IPADAPTER_WEIGHT"] = req.ip_adapter["weight"]

    for idx, control in enumerate(req.control, start=1):
        prefix = f"$OPENCLAW_CONTROL_{idx}_"
        placeholder_map[f"{prefix}TYPE"] = control["type"]
        placeholder_map[f"{prefix}IMAGE"] = upload_refs.get(f"control_{idx}", "")
        if "strength" in control:
            placeholder_map[f"{prefix}STRENGTH"] = control["strength"]
        if "start" in control:
            placeholder_map[f"{prefix}START"] = control["start"]
        if "end" in control:
            placeholder_map[f"{prefix}END"] = control["end"]

    for idx, lora in enumerate(req.loras, start=1):
        prefix = f"$OPENCLAW_LORA_{idx}_"
        placeholder_map[f"{prefix}NAME"] = lora["name"]
        if "scale" in lora:
            placeholder_map[f"{prefix}SCALE"] = lora["scale"]

    rendered = _replace_placeholders(workflow_data, placeholder_map)
    unresolved: set[str] = set()
    _collect_unresolved_placeholders(rendered, unresolved)
    if unresolved:
        missing = ", ".join(sorted(unresolved))
        raise BridgeError("workflow_placeholder_missing", f"Unresolved workflow placeholders: {missing}")
    return rendered


def _extract_first_image_descriptor(history_entry: dict[str, Any]) -> dict[str, str]:
    outputs = history_entry.get("outputs")
    if not isinstance(outputs, dict):
        raise BridgeError("no_outputs", "Workflow completed without outputs", status=HTTPStatus.BAD_GATEWAY)
    for node_out in outputs.values():
        if not isinstance(node_out, dict):
            continue
        images = node_out.get("images")
        if not isinstance(images, list) or not images:
            continue
        first = images[0]
        if not isinstance(first, dict):
            continue
        filename = first.get("filename")
        subfolder = first.get("subfolder", "")
        image_type = first.get("type", "output")
        if isinstance(filename, str):
            return {
                "filename": filename,
                "subfolder": subfolder if isinstance(subfolder, str) else "",
                "type": image_type if isinstance(image_type, str) else "output",
            }
    raise BridgeError("no_images", "Workflow completed without image outputs", status=HTTPStatus.BAD_GATEWAY)


def _poll_history(prompt_id: str, timeout_ms: int) -> dict[str, Any]:
    deadline = time.monotonic() + (timeout_ms / 1000.0)
    while time.monotonic() < deadline:
        history = _comfy_json_request("GET", f"/history/{urllib.parse.quote(prompt_id)}", timeout=15)
        if isinstance(history, dict):
            entry = history.get(prompt_id)
            if not isinstance(entry, dict):
                entry = history.get(str(prompt_id))
            if isinstance(entry, dict):
                if "outputs" in entry and entry.get("outputs"):
                    return entry
                status = entry.get("status")
                if isinstance(status, dict) and status.get("status_str") == "error":
                    messages = status.get("messages")
                    raise BridgeError("job_failed", f"ComfyUI job failed: {messages}", status=HTTPStatus.BAD_GATEWAY)
        time.sleep(0.75)
    raise BridgeError("timeout", f"Timed out waiting for job {prompt_id}", status=HTTPStatus.GATEWAY_TIMEOUT)


def _download_image(descriptor: dict[str, str]) -> bytes:
    query = urllib.parse.urlencode(descriptor)
    return _comfy_raw_get(f"/view?{query}", timeout=30)


def _save_output_image(prompt_id: str, descriptor: dict[str, str], image_bytes: bytes) -> Path:
    extension = Path(descriptor.get("filename", "")).suffix or ".png"
    output_path = (BRIDGE_OUTPUT_DIR / f"{prompt_id}{extension}").resolve()
    output_path.write_bytes(image_bytes)
    return output_path


def _run_generate_sync(req: GenerateRequest) -> dict[str, Any]:
    started_at = time.monotonic()

    upload_refs: dict[str, str] = {}
    if req.init_image_path:
        upload_refs["init_image"] = _upload_image(Path(req.init_image_path))
    for idx, control in enumerate(req.control, start=1):
        upload_refs[f"control_{idx}"] = _upload_image(Path(control["image_path"]))
    if req.ip_adapter and "image_path" in req.ip_adapter:
        upload_refs["ip_image"] = _upload_image(Path(str(req.ip_adapter["image_path"])))

    if req.workflow_path:
        workflow = _load_custom_workflow(req, upload_refs)
    elif req.mode == "img2img":
        if "init_image" not in upload_refs:
            raise BridgeError("invalid_request", "init_image_path upload failed")
        workflow = _build_default_img2img(req, upload_refs["init_image"])
    else:
        workflow = _build_default_txt2img(req)

    queued_at = time.monotonic()
    prompt_result = _comfy_json_request("POST", "/prompt", payload={"prompt": workflow}, timeout=30)
    prompt_id = prompt_result.get("prompt_id") if isinstance(prompt_result, dict) else None
    if not isinstance(prompt_id, str) or not prompt_id.strip():
        raise BridgeError("queue_failed", "ComfyUI did not return prompt_id", status=HTTPStatus.BAD_GATEWAY)

    history_entry = _poll_history(prompt_id, req.timeout_ms)
    descriptor = _extract_first_image_descriptor(history_entry)
    image_bytes = _download_image(descriptor)
    saved_path = _save_output_image(prompt_id, descriptor, image_bytes)
    ended_at = time.monotonic()

    return {
        "ok": True,
        "job_id": prompt_id,
        "image_path": str(saved_path),
        "width": req.width,
        "height": req.height,
        "seed": req.seed,
        "model": req.model,
        "timings_ms": {
            "total": int((ended_at - started_at) * 1000),
            "queue_to_done": int((ended_at - queued_at) * 1000),
        },
    }


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "OpenClawComfyBridge/1.0"

    def _send_json(self, status: int, payload: dict[str, Any]):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self) -> Any:
        content_length = self.headers.get("Content-Length")
        if not content_length:
            raise BridgeError("invalid_request", "Content-Length header is required")
        try:
            length = int(content_length)
        except ValueError:
            raise BridgeError("invalid_request", "Content-Length must be an integer")
        if length <= 0 or length > 10_000_000:
            raise BridgeError("invalid_request", "request body too large")
        body = self.rfile.read(length)
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            raise BridgeError("invalid_json", "request body must be valid JSON")

    def do_GET(self):  # noqa: N802
        if self.path != "/health":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "code": "not_found", "message": "Not found"})
            return
        try:
            system_stats = _comfy_json_request("GET", "/system_stats", timeout=10)
            queue_status = _comfy_json_request("GET", "/queue", timeout=10)
            object_info = _comfy_json_request("GET", "/object_info", timeout=10)
            known_nodes = set(object_info.keys()) if isinstance(object_info, dict) else set()
            feature_flags = {
                "controlnet": any("control" in node.lower() for node in known_nodes),
                "ipadapter": any("ipadapter" in node.lower() for node in known_nodes),
                "lora": any("lora" in node.lower() for node in known_nodes),
            }
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "comfyui_url": COMFYUI_URL,
                    "bridge_host": BRIDGE_HOST,
                    "bridge_port": BRIDGE_PORT,
                    "allowed_roots": [str(root) for root in ALLOWED_ROOTS],
                    "output_dir": str(BRIDGE_OUTPUT_DIR),
                    "system": system_stats,
                    "queue": queue_status,
                    "features": feature_flags,
                },
            )
        except BridgeError as exc:
            self._send_json(exc.status, {"ok": False, "code": exc.code, "message": exc.message, "details": exc.details})

    def do_POST(self):  # noqa: N802
        if self.path != "/v1/generate-sync":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "code": "not_found", "message": "Not found"})
            return
        try:
            payload = self._read_json_body()
            req = _normalize_generate_request(payload)
            response = _run_generate_sync(req)
            self._send_json(HTTPStatus.OK, response)
        except BridgeError as exc:
            self._send_json(exc.status, {"ok": False, "code": exc.code, "message": exc.message, "details": exc.details})
        except Exception as exc:  # noqa: BLE001
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "code": "internal_error", "message": str(exc)},
            )

    def log_message(self, _format: str, *_args: Any) -> None:
        # Keep bridge output deterministic and machine-readable for logs.
        return


def main():
    if BRIDGE_HOST not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("COMFY_BRIDGE_HOST must be loopback-only")
    server = ThreadingHTTPServer((BRIDGE_HOST, BRIDGE_PORT), BridgeHandler)
    print(
        json.dumps(
            {
                "ok": True,
                "event": "bridge_started",
                "bridge": f"http://{BRIDGE_HOST}:{BRIDGE_PORT}",
                "comfyui_url": COMFYUI_URL,
                "allowed_roots": [str(root) for root in ALLOWED_ROOTS],
                "output_dir": str(BRIDGE_OUTPUT_DIR),
            }
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
