import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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


class FakeImage:
    def __init__(self, size):
        self.size = size

    def copy(self):
        return FakeImage(self.size)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class FakePILImageModule:
    def __init__(self, sizes_by_source):
        self._sizes_by_source = sizes_by_source

    def open(self, source):
        if isinstance(source, (str, Path)):
            key = source
        else:
            key = type(source).__name__
        size = self._sizes_by_source[key]
        return FakeImage(size)


class LoadInputImageTests(unittest.TestCase):
    def test_load_input_image_accepts_local_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = Path(tmpdir) / "input.png"
            image_path.write_bytes(b"not-a-real-image")
            fake_pil = FakePILImageModule({image_path: (16, 12)})

            loaded = generate_image.load_input_image(str(image_path), fake_pil)

            self.assertEqual(loaded.size, (16, 12))

    def test_load_input_image_accepts_public_https_url(self):
        fake_opener = type(
            "FakeOpener",
            (),
            {
                "open": lambda self, req, timeout=0: FakeResponse(
                    b"fake-image-bytes",
                    req.full_url,
                )
            },
        )()
        fake_pil = FakePILImageModule({"BytesIO": (20, 10)})

        with patch.object(
            generate_image.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("93.184.216.34", 443))],
        ), patch.object(generate_image.request, "build_opener", return_value=fake_opener):
            loaded = generate_image.load_input_image("https://example.com/input.png", fake_pil)

        self.assertEqual(loaded.size, (20, 10))

    def test_load_input_image_rejects_private_network_url(self):
        with patch.object(
            generate_image.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("127.0.0.1", 443))],
        ):
            with self.assertRaisesRegex(ValueError, "private, loopback, or special-use hosts"):
                generate_image.load_input_image(
                    "https://localhost/input.png",
                    FakePILImageModule({}),
                )

    def test_load_input_image_rejects_file_url(self):
        with self.assertRaisesRegex(ValueError, "Use a local path instead of file:// URLs"):
            generate_image.load_input_image(
                "file:///tmp/input.png",
                FakePILImageModule({}),
            )


if __name__ == "__main__":
    unittest.main()
