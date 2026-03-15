"""Tests for ra2.redact"""

import pytest
from ra2.redact import redact, redact_dict, redact_messages, REDACTED


class TestRedact:
    def test_openai_key(self):
        text = "my key is sk-abc123def456ghi789jklmnopqrs"
        result = redact(text)
        assert "sk-abc" not in result
        assert REDACTED in result

    def test_anthropic_key(self):
        text = "key: sk-ant-abc123def456ghi789jklmnopqrs"
        result = redact(text)
        assert "sk-ant-" not in result
        assert REDACTED in result

    def test_discord_token(self):
        # Build a fake Discord-shaped token dynamically to avoid push protection.
        # Pattern: [MN][A-Za-z0-9]{23,}.[A-Za-z0-9_-]{6}.[A-Za-z0-9_-]{27,}
        prefix = "M" + "T" * 23              # 24 chars, starts with M
        mid = "G" + "a" * 5                   # 6 chars
        suffix = "x" * 27                     # 27 chars
        token = f"{prefix}.{mid}.{suffix}"
        text = f"token is {token}"
        result = redact(text)
        assert token not in result
        assert REDACTED in result

    def test_google_key(self):
        text = "key=AIzaSyD-abcdefghijklmnopqrstuvwxyz12345"
        result = redact(text)
        assert "AIza" not in result
        assert REDACTED in result

    def test_aws_key(self):
        text = "aws key: AKIAIOSFODNN7EXAMPLE"
        result = redact(text)
        assert "AKIA" not in result

    def test_slack_token(self):
        text = "token: xoxb-123456789012-abcdefghij"
        result = redact(text)
        assert "xoxb-" not in result

    def test_github_token(self):
        text = "auth: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl"
        result = redact(text)
        assert "ghp_" not in result

    def test_telegram_token(self):
        text = "bot: 123456789:ABCDefGHIJKlMNOpQRSTuvWXYz0123456789a"
        result = redact(text)
        assert "ABCDef" not in result

    def test_bearer_token(self):
        text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc"
        result = redact(text)
        assert "eyJh" not in result

    def test_generic_secret_key_value(self):
        text = 'api_key = "abcdefghijklmnopqrstuvwxyz1234567890ABCD"'
        result = redact(text)
        assert "abcdefghij" not in result
        # The label should still be there
        assert "api_key" in result

    def test_no_false_positive_normal_text(self):
        text = "Hello, this is a normal message with no secrets."
        assert redact(text) == text

    def test_multiple_secrets(self):
        text = "keys: sk-abc123def456ghi789jklmnopqrs and sk-ant-xyz123abc456def789ghi"
        result = redact(text)
        assert "sk-abc" not in result
        assert "sk-ant-" not in result
        assert result.count(REDACTED) == 2


class TestRedactDict:
    def test_flat_dict(self):
        d = {"key": "sk-abc123def456ghi789jklmnopqrs", "name": "test"}
        result = redact_dict(d)
        assert REDACTED in result["key"]
        assert result["name"] == "test"

    def test_nested_dict(self):
        d = {"outer": {"inner": "sk-abc123def456ghi789jklmnopqrs"}}
        result = redact_dict(d)
        assert REDACTED in result["outer"]["inner"]

    def test_list_values(self):
        d = {"tokens": ["sk-abc123def456ghi789jklmnopqrs", "normal"]}
        result = redact_dict(d)
        assert REDACTED in result["tokens"][0]
        assert result["tokens"][1] == "normal"


class TestRedactMessages:
    def test_redacts_content(self):
        msgs = [
            {"role": "user", "content": "my key is sk-abc123def456ghi789jklmnopqrs"},
            {"role": "assistant", "content": "I see a key"},
        ]
        result = redact_messages(msgs)
        assert REDACTED in result[0]["content"]
        assert result[1]["content"] == "I see a key"

    def test_preserves_non_string_content(self):
        msgs = [{"role": "user", "content": 42}]
        result = redact_messages(msgs)
        assert result[0]["content"] == 42
