"""Tests for openai-image-gen helpers."""

import tempfile
from pathlib import Path

import pytest
from gen import normalize_background, normalize_style, write_gallery


def test_normalize_background_allows_empty_for_non_gpt_models():
    assert normalize_background("dall-e-3", "transparent") == ""


def test_normalize_background_allows_empty_for_gpt_models():
    assert normalize_background("gpt-image-1", "") == ""
    assert normalize_background("gpt-image-1", "   ") == ""


def test_normalize_background_normalizes_case_for_gpt_models():
    assert normalize_background("gpt-image-1", "TRANSPARENT") == "transparent"


def test_normalize_background_warns_when_model_does_not_support_flag(capsys):
    assert normalize_background("dall-e-3", "transparent") == ""
    captured = capsys.readouterr()
    assert "--background is only supported for gpt-image models" in captured.err


def test_normalize_background_rejects_invalid_values():
    with pytest.raises(ValueError, match="Invalid --background"):
        normalize_background("gpt-image-1", "checkerboard")


def test_normalize_style_allows_empty_for_non_dalle3_models():
    assert normalize_style("gpt-image-1", "vivid") == ""


def test_normalize_style_allows_empty_for_dalle3():
    assert normalize_style("dall-e-3", "") == ""
    assert normalize_style("dall-e-3", "   ") == ""


def test_normalize_style_normalizes_case_for_dalle3():
    assert normalize_style("dall-e-3", "NATURAL") == "natural"


def test_normalize_style_warns_when_model_does_not_support_flag(capsys):
    assert normalize_style("gpt-image-1", "vivid") == ""
    captured = capsys.readouterr()
    assert "--style is only supported for dall-e-3" in captured.err


def test_normalize_style_rejects_invalid_values():
    with pytest.raises(ValueError, match="Invalid --style"):
        normalize_style("dall-e-3", "cinematic")


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
