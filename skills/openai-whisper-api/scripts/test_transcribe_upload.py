import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


@unittest.skipUnless(shutil.which("curl"), "curl is required")
class TranscribeUploadTests(unittest.TestCase):
    def test_uploads_literal_audio_paths(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                if self.headers.get("Content-Length") is None:
                    self.rfile.read()
                    self.close_connection = True
                    return
                body = self.rfile.read(int(self.headers["Content-Length"]))
                message = BytesParser(policy=default).parsebytes(
                    b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + body
                )
                received.append(
                    [
                        part.get_payload(decode=True)
                        for part in message.iter_parts()
                        if part.get_param("name", header="content-disposition") == "file"
                    ]
                )
                self.send_response(200)
                self.send_header("Content-Length", "10")
                self.end_headers()
                self.wfile.write(b"transcript")

            def log_message(self, *_):
                pass

        script = Path(__file__).with_name("transcribe.sh")
        with (
            tempfile.TemporaryDirectory() as directory,
            HTTPServer(("127.0.0.1", 0), Handler) as server,
        ):
            worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
            worker.start()
            try:
                root = Path(directory)
                output = root / "result.txt"
                for name in (
                    "plain.wav",
                    "meeting,part.wav",
                    "meeting;part.wav",
                    'say"hi\\there.wav',
                ):
                    with self.subTest(name=name):
                        audio = root / name
                        audio.write_bytes(b"audio fixture")
                        received.clear()
                        result = subprocess.run(
                            [
                                "bash",
                                str(script),
                                str(audio),
                                "--model",
                                "whisper-1",
                                "--out",
                                str(output),
                            ],
                            env={
                                **os.environ,
                                "OPENAI_API_KEY": "test-key",
                                "OPENAI_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
                                "NO_PROXY": "127.0.0.1",
                            },
                            capture_output=True,
                            text=True,
                            timeout=5,
                        )
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(received, [[b"audio fixture"]])
                        self.assertEqual(output.read_text(), "transcript")
            finally:
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    unittest.main()
