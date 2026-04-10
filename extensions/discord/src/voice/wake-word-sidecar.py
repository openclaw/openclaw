#!/usr/bin/env python3
"""
openWakeWord sidecar process for Discord voice wake word detection.

Protocol
--------
stdin  (binary):  [type: 1B] [length: 4B big-endian] [payload]
  type 0x01 = audio  — payload is raw 16 kHz, 16-bit, mono PCM
  type 0x02 = config — payload is UTF-8 JSON with {triggers, confidence?, modelPath?}

stdout (JSON lines):
  {"type":"ready"}
  {"type":"detection","trigger":"hey calvin","confidence":0.85,"timestamp":1234567890}
  {"type":"error","message":"..."}
"""

from __future__ import annotations

import json
import struct
import sys
import time
from typing import Any

MSG_AUDIO = 0x01
MSG_CONFIGURE = 0x02
HEADER_SIZE = 5  # 1 (type) + 4 (length)

# Default detection confidence threshold.
DEFAULT_CONFIDENCE = 0.7


def emit(event: dict[str, Any]) -> None:
    """Write a JSON-line event to stdout and flush immediately."""
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def read_exactly(stream: Any, n: int) -> bytes:
    """Read exactly n bytes from a binary stream, or raise EOFError."""
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            raise EOFError("stdin closed")
        buf += chunk
    return buf


def main() -> None:
    try:
        import openwakeword  # noqa: F401
        from openwakeword.model import Model as OWWModel
    except ImportError:
        emit({"type": "error", "message": "openwakeword not installed (pip install openwakeword)"})
        sys.exit(1)

    # State — populated by the first CONFIGURE message.
    model: OWWModel | None = None
    confidence_threshold = DEFAULT_CONFIDENCE
    configured = False

    # Switch stdin to binary mode.
    stdin = sys.stdin.buffer

    emit({"type": "ready"})

    while True:
        try:
            header = read_exactly(stdin, HEADER_SIZE)
        except EOFError:
            break

        msg_type = header[0]
        length = struct.unpack(">I", header[1:5])[0]

        payload = read_exactly(stdin, length) if length > 0 else b""

        if msg_type == MSG_CONFIGURE:
            try:
                cfg = json.loads(payload.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                emit({"type": "error", "message": f"bad config payload: {exc}"})
                continue

            confidence_threshold = cfg.get("confidence", DEFAULT_CONFIDENCE)
            model_path = cfg.get("modelPath")
            triggers = cfg.get("triggers", [])

            try:
                if model_path:
                    model = OWWModel(wakeword_models=[model_path], inference_framework="onnx")
                elif triggers:
                    # Map trigger phrases to built-in model names.
                    # e.g. "hey jarvis" → "hey_jarvis_v0.1"
                    builtin_models = []
                    for t in triggers:
                        model_name = t.lower().replace(" ", "_")
                        builtin_models.append(model_name)
                    # Load only the matching built-in models.
                    # OWWModel accepts model names without version suffix.
                    try:
                        model = OWWModel(wakeword_models=builtin_models, inference_framework="onnx")
                    except Exception:
                        # If specific models not found, fall back to loading all.
                        emit({"type": "error", "message": f"could not load models {builtin_models}; loading all built-in models"})
                        model = OWWModel(inference_framework="onnx")
                else:
                    # No triggers or model path — load all built-in models.
                    model = OWWModel(inference_framework="onnx")
                configured = True
                emit({"type": "ready"})
            except Exception as exc:
                emit({"type": "error", "message": f"model load failed: {exc}"})
                model = None

        elif msg_type == MSG_AUDIO:
            if not configured or model is None:
                continue

            # Convert raw PCM bytes to numpy int16 array.
            import numpy as np

            audio = np.frombuffer(payload, dtype=np.int16)
            if audio.size == 0:
                continue

            # openWakeWord expects chunks; feed the audio and check predictions.
            prediction = model.predict(audio)

            for wake_word, score in prediction.items():
                if score >= confidence_threshold:
                    emit({
                        "type": "detection",
                        "trigger": wake_word,
                        "confidence": round(float(score), 4),
                        "timestamp": int(time.time() * 1000),
                    })
                    # Reset the model state after a detection to avoid
                    # re-firing on the same audio.
                    model.reset()
                    break

        else:
            emit({"type": "error", "message": f"unknown message type: {msg_type}"})


if __name__ == "__main__":
    main()
