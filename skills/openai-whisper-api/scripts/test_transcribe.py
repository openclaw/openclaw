#!/usr/bin/env python3
"""Regression tests for transcription output paths using a local HTTP endpoint."""

import io
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
import wave
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


@unittest.skipUnless(
    all(shutil.which(command) for command in ("bash", "curl", "node")),
    "bash, curl and node are required",
)
class TestTranscribeOutput(unittest.TestCase):
    def test_default_output_stays_beside_audio_in_dotted_directory(self):
        audio_buffer = io.BytesIO()
        with wave.open(audio_buffer, "wb") as sound:
            sound.setnchannels(1)
            sound.setsampwidth(2)
            sound.setframerate(8000)
            sound.writeframes(b"\x00\x00" * 800)
        audio_bytes = audio_buffer.getvalue()
        response = b'{"text":"Local transcript"}\n'
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                message = BytesParser(policy=default).parsebytes(
                    b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + body
                )
                files = [
                    part.get_payload(decode=True)
                    for part in message.iter_parts()
                    if part.get_param("name", header="content-disposition") == "file"
                ]
                received.append((self.path, files))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, *_):
                pass

        script = Path(__file__).with_name("transcribe.sh")
        with tempfile.TemporaryDirectory() as temporary:
            with HTTPServer(("127.0.0.1", 0), Handler) as server:
                worker = threading.Thread(
                    target=server.serve_forever, kwargs={"poll_interval": 0.01}
                )
                worker.start()
                try:
                    cases = [
                        ("default-text", "voice", False, False),
                        ("default-json", "voice", True, False),
                        ("explicit-output", "voice", False, True),
                        ("extension-control", "voice.wav", False, False),
                    ]
                    for label, filename, as_json, explicit in cases:
                        with self.subTest(case=label):
                            root = Path(temporary) / label
                            audio = root / "audio.v1" / filename
                            audio.parent.mkdir(parents=True)
                            audio.write_bytes(audio_bytes)
                            suffix = ".json" if as_json else ".txt"
                            unrelated = root / ("audio" + suffix)
                            unrelated.write_bytes(b"Keep this unrelated file\n")
                            output = root / "chosen.txt" if explicit else audio.with_suffix(suffix)
                            args = ["bash", str(script), str(audio)]
                            if as_json:
                                args.append("--json")
                            if explicit:
                                args.extend(["--out", str(output)])
                            received.clear()
                            result = subprocess.run(
                                args,
                                env={
                                    **os.environ,
                                    "OPENAI_API_KEY": "synthetic-local-key",
                                    "OPENAI_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
                                    "NO_PROXY": "127.0.0.1",
                                },
                                capture_output=True,
                                text=True,
                                timeout=10,
                            )
                            self.assertEqual(result.returncode, 0, result.stderr)
                            self.assertEqual(
                                received, [("/v1/audio/transcriptions", [audio_bytes])]
                            )
                            self.assertEqual(audio.read_bytes(), audio_bytes)
                            self.assertEqual(unrelated.read_bytes(), b"Keep this unrelated file\n")
                            self.assertEqual(result.stdout.strip(), str(output))
                            self.assertEqual(
                                output.read_bytes(), response if as_json else b"Local transcript"
                            )
                finally:
                    server.shutdown()
                    worker.join()


if __name__ == "__main__":
    unittest.main()
