import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import generate_image


class FakeResponse:
    def __init__(self, payload: bytes, url: str):
        self._payload = payload
        self._url = url

    def geturl(self):
        return self._url

    def read(self, _limit: int):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class LoadInputImageTests(unittest.TestCase):
    def test_load_input_image_accepts_local_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = Path(tmpdir) / "input.png"
            Image.new("RGB", (16, 12), (255, 0, 0)).save(image_path, "PNG")

            loaded = generate_image.load_input_image(str(image_path), Image)

            self.assertEqual(loaded.size, (16, 12))

    def test_load_input_image_accepts_public_https_url(self):
        img = Image.new("RGB", (20, 10), (0, 255, 0))
        buf = io.BytesIO()
        img.save(buf, "PNG")

        fake_opener = type(
            "FakeOpener",
            (),
            {
                "open": lambda self, req, timeout=0: FakeResponse(
                    buf.getvalue(),
                    req.full_url,
                )
            },
        )()

        with patch.object(
            generate_image.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("93.184.216.34", 443))],
        ), patch.object(generate_image.request, "build_opener", return_value=fake_opener):
            loaded = generate_image.load_input_image("https://example.com/input.png", Image)

        self.assertEqual(loaded.size, (20, 10))

    def test_load_input_image_rejects_private_network_url(self):
        with patch.object(
            generate_image.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("127.0.0.1", 443))],
        ):
            with self.assertRaisesRegex(ValueError, "private, loopback, or special-use hosts"):
                generate_image.load_input_image("https://localhost/input.png", Image)

    def test_load_input_image_rejects_file_url(self):
        with self.assertRaisesRegex(ValueError, "Use a local path instead of file:// URLs"):
            generate_image.load_input_image("file:///tmp/input.png", Image)


if __name__ == "__main__":
    unittest.main()
