import os
import shutil
import subprocess
import tempfile
import unittest
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


@unittest.skipUnless(shutil.which("bash") and shutil.which("curl"), "requires bash and curl")
class TranscribeTests(unittest.TestCase):
    def test_prompt_is_sent_as_literal_text(self):
        received = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                message = BytesParser(policy=default).parsebytes(
                    f"Content-Type: {self.headers['Content-Type']}\r\n\r\n".encode() + body
                )
                for part in message.iter_parts():
                    received[part.get_param("name", header="content-disposition")] = (
                        part.get_payload(decode=True),
                        part.get_filename(),
                    )
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"transcript")

            def log_message(self, *_):
                pass

        with (
            tempfile.TemporaryDirectory() as directory,
            HTTPServer(("127.0.0.1", 0), Handler) as server,
        ):
            audio = Path(directory) / "audio.wav"
            audio.write_bytes(b"synthetic audio")
            server.timeout = 2
            env = {
                **os.environ,
                "OPENAI_API_KEY": "synthetic-test-key",
                "OPENAI_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
            }
            for prompt in ("Speaker names: Alice; Bob", "@" + str(audio), "<" + str(audio)):
                with self.subTest(prompt=prompt):
                    received.clear()
                    with subprocess.Popen(
                        [
                            "bash",
                            str(Path(__file__).with_name("transcribe.sh")),
                            str(audio),
                            "--model",
                            "whisper-1",
                            "--prompt",
                            prompt,
                        ],
                        env=env,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                    ) as process:
                        try:
                            server.handle_request()
                            _, stderr = process.communicate(timeout=5)
                        finally:
                            if process.poll() is None:
                                process.kill()
                    self.assertEqual(process.returncode, 0, stderr)
                    self.assertEqual(received.get("prompt"), (prompt.encode(), None))
                    self.assertEqual(received.get("file"), (audio.read_bytes(), audio.name))
                    self.assertEqual(audio.with_suffix(".txt").read_text(), "transcript")


if __name__ == "__main__":
    unittest.main()
