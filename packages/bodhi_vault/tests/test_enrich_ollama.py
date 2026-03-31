"""
Tests for expand_content Ollama integration.
All tests use unittest.mock — no live Ollama required.

Run: cd packages/bodhi_vault && pytest tests/test_enrich_ollama.py -v
"""
from unittest.mock import AsyncMock, MagicMock, patch
import pytest


@pytest.mark.asyncio
async def test_expand_content_returns_response_text():
    """expand_content returns the stripped response from Ollama."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"response": "Expanded thought here."}

    with patch("httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.post = AsyncMock(return_value=mock_resp)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=None)
        MockClient.return_value = instance

        from bodhi_vault.enrich import expand_content
        result = await expand_content("quick note")

    assert result == "Expanded thought here."


@pytest.mark.asyncio
async def test_expand_content_passes_model_to_ollama():
    """Model parameter is forwarded correctly to the Ollama API payload."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"response": "ok"}

    with patch("httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.post = AsyncMock(return_value=mock_resp)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=None)
        MockClient.return_value = instance

        from bodhi_vault.enrich import expand_content
        await expand_content("thought", model="gemma3:12b")

    _, kwargs = instance.post.call_args
    assert kwargs["json"]["model"] == "gemma3:12b"


@pytest.mark.asyncio
async def test_expand_content_strips_whitespace():
    """Response text is stripped before returning."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"response": "  padded  \n"}

    with patch("httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.post = AsyncMock(return_value=mock_resp)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=None)
        MockClient.return_value = instance

        from bodhi_vault.enrich import expand_content
        result = await expand_content("thought")

    assert result == "padded"


@pytest.mark.asyncio
async def test_expand_content_prompt_preserves_original_content():
    """The prompt sent to Ollama contains the original content string."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"response": "ok"}

    with patch("httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.post = AsyncMock(return_value=mock_resp)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=None)
        MockClient.return_value = instance

        from bodhi_vault.enrich import expand_content
        await expand_content("specific raw thought xyz")

    _, kwargs = instance.post.call_args
    assert "specific raw thought xyz" in kwargs["json"]["prompt"]
