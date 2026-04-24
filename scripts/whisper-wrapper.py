#!/usr/bin/env python3
"""Whisper CLI wrapper that routes calls to faster-whisper server for ~1s latency.

Install:
    # Backup original
    sudo mv /opt/homebrew/bin/whisper /opt/homebrew/bin/whisper.original
    # Install wrapper
    sudo cp whisper-wrapper.py /opt/homebrew/bin/whisper
    sudo chmod +x /opt/homebrew/bin/whisper

The wrapper connects to a faster-whisper server on port 15555. If the server
is unavailable, it falls back to the original OpenAI Whisper CLI automatically.
"""
import sys
import os
import json
import socket
import argparse
import subprocess
import warnings
warnings.filterwarnings("ignore")

SERVER = ("127.0.0.1", 15555)
ORIGINAL_BINARY = "/opt/homebrew/bin/whisper.original"

def call_server(audio: str, language: str = None, timeout: int = 8):
    sock = socket.socket()
    sock.settimeout(timeout)
    try:
        sock.connect(SERVER)
        payload = json.dumps({"audio": audio, "language": language}).encode() + b"\n"
        sock.sendall(payload)
        result = b""
        while True:
            chunk = sock.recv(8192)
            if not chunk:
                break
            result += chunk
            if b"\n" in result:
                break
        return json.loads(result.decode())
    except Exception:
        return {"error": "server unavailable"}
    finally:
        sock.close()

def fallback_to_original(audio: str, model: str, output_format: str, output_dir: str, language: str):
    cmd = [ORIGINAL_BINARY, audio,
           "--model", model,
           "--output_format", output_format,
           "--output_dir", output_dir]
    if language:
        cmd += ["--language", language]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        if output_format == "json":
            try:
                print(json.dumps(json.loads(result.stdout.strip())))
            except Exception:
                print(result.stdout)
        else:
            print(result.stdout)
    else:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", nargs="+")
    parser.add_argument("--model", default="base")
    parser.add_argument("--output_dir", default=".")
    parser.add_argument("--output_format", default="txt")
    parser.add_argument("--language", default=None)
    parser.add_argument("--task", default="transcribe")
    args, _ = parser.parse_known_args()

    audio = args.audio[0]
    output_format = args.output_format

    result = call_server(audio, args.language)

    if "error" in result:
        fallback_to_original(audio, args.model, output_format, args.output_dir, args.language)
        return

    text = result["text"].strip()

    if output_format == "txt":
        print(text)
    elif output_format == "json":
        print(json.dumps({"text": text}))
    elif output_format == "srt":
        print(f"1\n00:00:00,000 --> 00:00:05,000\n{text}")
    else:
        print(text)

if __name__ == "__main__":
    main()
