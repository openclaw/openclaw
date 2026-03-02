"""Tests for write_gallery HTML escaping (fixes #12538 - stored XSS)."""

import tempfile
from pathlib import Path

from gen import write_gallery


def test_write_gallery_escapes_prompt_xss():
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir)
        items = [{"prompt": '<script>alert("xss")</script>', "file": "001-test.png"}]
        write_gallery(out, items)
        html = (out / "index.html").read_text()
        assert "<script>" not in html
        assert "&lt;script&gt;" in html


def test_write_gallery_escapes_filename():
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir)
        items = [{"prompt": "safe prompt", "file": '" onload="alert(1)'}]
        write_gallery(out, items)
        html = (out / "index.html").read_text()
        assert 'onload="alert(1)"' not in html
        assert "&quot;" in html


def test_write_gallery_escapes_ampersand():
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir)
        items = [{"prompt": "cats & dogs <3", "file": "001-test.png"}]
        write_gallery(out, items)
        html = (out / "index.html").read_text()
        assert "cats &amp; dogs &lt;3" in html


def test_write_gallery_normal_output():
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir)
        items = [
            {"prompt": "a lobster astronaut, golden hour", "file": "001-lobster.png"},
            {"prompt": "a cozy reading nook", "file": "002-nook.png"},
        ]
        write_gallery(out, items)
        html = (out / "index.html").read_text()
        assert "a lobster astronaut, golden hour" in html
        assert 'src="001-lobster.png"' in html
        assert "002-nook.png" in html

