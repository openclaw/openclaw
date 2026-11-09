"""Exercise output paths through the shipped CLI and a local HTTP endpoint."""

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
    def test_leading_dash_output_paths(self):
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\x00\x00" * 80)
        audio_bytes = buffer.getvalue()
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

        script = Path(__file__).with_name("transcribe.sh").resolve()
        with (
            tempfile.TemporaryDirectory() as temporary,
            HTTPServer(("127.0.0.1", 0), Handler) as server,
        ):
            worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
            worker.start()
            try:
                cases = [
                    ("default", "-recording.wav", [], "-recording.txt", b"Local transcript"),
                    (
                        "explicit",
                        "voice.wav",
                        ["--out", "-out.txt"],
                        "-out.txt",
                        b"Local transcript",
                    ),
                    (
                        "directory",
                        "voice.wav",
                        ["--out", "-dir/out.txt"],
                        "-dir/out.txt",
                        b"Local transcript",
                    ),
                    ("json", "-recording.wav", ["--json"], "-recording.json", response),
                    ("ordinary", "voice.wav", [], "voice.txt", b"Local transcript"),
                ]
                for label, filename, flags, output, expected in cases:
                    with self.subTest(case=label):
                        root = Path(temporary) / label
                        root.mkdir()
                        source = root / filename
                        source.write_bytes(audio_bytes)
                        received.clear()
                        result = subprocess.run(
                            ["bash", str(script), filename, *flags],
                            cwd=root,
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
                        self.assertEqual(received, [("/v1/audio/transcriptions", [audio_bytes])])
                        self.assertEqual(source.read_bytes(), audio_bytes)
                        self.assertEqual(result.stdout.strip(), output)
                        self.assertEqual((root / output).read_bytes(), expected)
            finally:
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    unittest.main()
