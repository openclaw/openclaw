#!/usr/bin/env python3
"""Faster-Whisper transcription server.

Keeps the model preloaded in memory for sub-second transcription latency.
Listens on port 15555. Run via launchd or directly.

Usage:
    python3 faster-whisper-server.py

Protocol:
    Send JSON: {"audio": "/path/to/file.ogg", "language": "en"}
    Receive:   {"text": "transcribed text", "language": "en"}
"""
import socket
import json
import warnings
import os
import sys

warnings.filterwarnings("ignore")

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("ERROR: faster-whisper not installed. Run: pip install faster-whisper", file=sys.stderr)
    sys.exit(1)

MODEL = None
MODEL_NAME = "base"
PORT = 15555

def get_model():
    global MODEL
    if MODEL is None:
        MODEL = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
        print(f"faster-whisper model '{MODEL_NAME}' loaded", flush=True)
    return MODEL

def handle_request(audio_path: str, language: str = None):
    model = get_model()
    kwargs = {"beam_size": 1, "vad_filter": True}
    if language:
        kwargs["language"] = language

    segments, info = model.transcribe(audio_path, **kwargs)
    text = "".join([s.text for s in segments]).strip()
    return {"text": text, "language": info.language}

def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", PORT))
    sock.listen(1)
    print(f"faster-whisper server ready on 127.0.0.1:{PORT}", flush=True)

    while True:
        conn, addr = sock.accept()
        try:
            data = b""
            conn.settimeout(10)
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\n" in data:
                    break

            if data:
                request = json.loads(data.decode())
                audio_path = request.get("audio")
                language = request.get("language")
                result = handle_request(audio_path, language)
                conn.sendall(json.dumps(result).encode() + b"\n")
            else:
                conn.sendall(json.dumps({"error": "empty request"}).encode() + b"\n")
        except json.JSONDecodeError:
            conn.sendall(json.dumps({"error": "invalid JSON"}).encode() + b"\n")
        except Exception as e:
            conn.sendall(json.dumps({"error": str(e)}).encode() + b"\n")
        finally:
            conn.close()

if __name__ == "__main__":
    main()
