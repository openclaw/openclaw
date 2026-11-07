import os
import signal
import subprocess
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


class TranscriptionHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        status = int(self.path.split("/")[1])
        payload = b'{"text":"hello"}' if status == 200 else b'{"error":"unavailable"}'
        self.send_response(status)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


class TranscribeTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(os, "fork"), "requires POSIX shell environment")
    def test_http_errors_do_not_report_success(self):
        script = Path(__file__).with_name("transcribe.sh")
        with HTTPServer(("127.0.0.1", 0), TranscriptionHandler) as server:
            child = os.fork()
            if child == 0:
                server.serve_forever()
                os._exit(0)
            try:
                with tempfile.TemporaryDirectory() as directory:
                    audio = Path(directory) / "audio.wav"
                    audio.write_bytes(b"synthetic audio")
                    output = Path(directory) / "transcript.json"
                    for status in (200, 401, 429, 500):
                        with self.subTest(status=status):
                            result = subprocess.run(
                                ["bash", str(script), str(audio), "--json", "--out", str(output)],
                                env={
                                    **os.environ,
                                    "CURL_HOME": directory,
                                    "NO_PROXY": "127.0.0.1",
                                    "OPENAI_API_KEY": "test-key",
                                    "OPENAI_BASE_URL": f"http://127.0.0.1:{server.server_port}/{status}",
                                },
                                capture_output=True,
                                text=True,
                                timeout=5,
                            )
                            if status == 200:
                                self.assertEqual(result.returncode, 0, result.stderr)
                                self.assertEqual(output.read_text(), '{"text":"hello"}')
                            else:
                                self.assertNotEqual(result.returncode, 0)
                                self.assertEqual(result.stdout, "")
                                self.assertIn(str(status), result.stderr)
            finally:
                os.kill(child, signal.SIGTERM)
                os.waitpid(child, 0)


if __name__ == "__main__":
    unittest.main()
