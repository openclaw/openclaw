"""
Unit tests for Google Places API place_id validation.

These tests ensure that the _validate_place_id function correctly:
1. Accepts valid Google Place IDs
2. Rejects path traversal attempts (including URL-encoded variants)
3. Rejects malformed place IDs
4. Validates length constraints
"""

import pytest
from fastapi import HTTPException
from local_places.google_places import _validate_place_id

class TestValidatePlaceId:
    """Test suite for place_id validation."""

    def test_valid_place_ids(self):
        """Test that valid Google Place IDs are accepted."""
        valid_ids = [
            "ChIJN1t_tDeuEmsRUsoyG83frY4",  # Common format starting with ChIJ
            "Ei1Tb21lIFBsYWNlIE5hbWU",      # Base64-like format
            "GhIJQWJjZGVmZ2hpamtsbW5vcA",   # Starting with GhIJ
            "valid_place-id_123",            # With underscores and hyphens
            "A" * 100,                       # Long valid ID
            "1234567890",                    # Numeric only (minimum length)
            "Ei1Tb21lIFBsYWNlIE5hbWU+SlBh",  # Contains '+'
            "GhIJQWJjZGVmZ2hpamtsbW5vcA==",  # Contains '='
            "valid/place-id_123",            # Contains '/'
            "place/with/slashes/123",        # Multiple slashes
            "ChIJAbCdEfGhIjKlMnOpQrStUvWxYz",  # Mixed case alphanumeric
            "UPPERCASE123",                  # Uppercase
            "lowercase456",                  # Lowercase
            "MiXeDCaSe789",                   # Mixed case
            "place_with_underscores_123",    # Underscores
            "place-with-hyphens-456",        # Hyphens
            "place_with-both_789",            # Both underscores and hyphens
            "___underscores___",              # Multiple underscores
            "---hyphens---mixed123",           # Multiple hyphens
        ]

        for place_id in valid_ids:
            try:
                _validate_place_id(place_id)
            except HTTPException:
                pytest.fail(f"Valid place_id '{place_id}' was incorrectly rejected")

    def test_path_traversal_attempts(self):
        """Test that path traversal attempts are rejected."""
        malicious_ids = [
            "../../../etc/passwd",      # Classic traversal
            "place/../other",           # Relative traversal
            "./local/file",             # Current directory traversal
            "..\\..\\windows\\system32", # Windows-style traversal
            "%2e%2e%2f%2e%2e%2ffile",    # URL-encoded traversal (lowercase)
            "%2E%2E%2F%2E%2E%2Ffile",    # URL-encoded traversal (uppercase)
            "place/../../file",         # Multiple level traversal
            "//network/share",          # Network path
            "mixed\\/slashes",          # Mixed slashes
            "../etc/passwd",            # Simple parent traversal
            "./secret",                 # Current directory traversal
            "traversal/..",             # Traversal in middle
            "normal/../traversal",      # Traversal in middle
            "%2e%2fsecret",             # URL-encoded current directory (lowercase)
            "%2E%2Fsecret",             # URL-encoded current directory (uppercase)
            "traversal%2e%2e%2fpath",   # URL-encoded traversal (lowercase)
            "traversal%2E%2E%2Fpath",    # URL-encoded traversal (uppercase)
            "C:/windows/system32",      # Absolute Windows path
            "/etc/passwd",              # Absolute Unix path
            "normal/./traversal",       # Current directory in middle
            "path/with/../traversal",   # Traversal in middle of path
            "path\\with\\..\\traversal", # Windows-style traversal in middle
            "..%2F..%2Fetc%2Fpasswd",    # Mixed encoded traversal
            "%2e%2e%5c%2e%2e%5cwindows%5csystem32",  # URL-encoded Windows traversal
        ]

        for place_id in malicious_ids:
            with pytest.raises(HTTPException) as exc_info:
                _validate_place_id(place_id)
            assert exc_info.value.status_code == 400  # Only assert status code

    def test_special_characters(self):
        """Test that place IDs with special characters are rejected."""
        invalid_ids = [
            "place@id",              # @ symbol
            "place id",              # Space
            "place\\id",             # Backslash
            "place?id=123",          # Query string
            "place#anchor",          # Hash
            "place;drop table",      # Semicolon (SQL injection attempt)
            "place&param=value",     # Ampersand
            "place|command",         # Pipe
            "place`whoami`",         # Backticks (command injection)
            "place$variable",        # Dollar sign
            "place!important",       # Exclamation
            "place*wildcard",        # Asterisk
            "place(parens)",         # Parentheses
            "place[brackets]",       # Brackets
            "place{braces}",         # Braces
            "place<tag>",            # Angle brackets (XSS attempt)
            "place%invalid",          # Percent without encoding
            "place%2",                # Incomplete percent encoding
            "place%zz",              # Invalid percent encoding
        ]

        for place_id in invalid_ids:
            with pytest.raises(HTTPException) as exc_info:
                _validate_place_id(place_id)
            assert exc_info.value.status_code == 400  # Only assert status code

    def test_empty_or_none(self):
        """Test that empty or None place IDs are rejected."""
        invalid_ids = ["", None]

        for place_id in invalid_ids:
            with pytest.raises(HTTPException) as exc_info:
                _validate_place_id(place_id)
            assert exc_info.value.status_code == 400
            assert "must be a non-empty string" in exc_info.value.detail

    def test_length_validation(self):
        """Test that place IDs are validated for appropriate length."""
        # Too short
        with pytest.raises(HTTPException) as exc_info:
            _validate_place_id("short")
        assert exc_info.value.status_code == 400
        assert "Invalid place_id length" in exc_info.value.detail

        # Too long
        with pytest.raises(HTTPException) as exc_info:
            _validate_place_id("A" * 301)
        assert exc_info.value.status_code == 400
        assert "Invalid place_id length" in exc_info.value.detail

        # Boundary cases - should pass
        _validate_place_id("A" * 10)   # Minimum length
        _validate_place_id("A" * 300)  # Maximum length

    def test_mixed_case(self):
        """Test that mixed case alphanumeric IDs are accepted."""
        valid_ids = [
            "ChIJAbCdEfGhIjKlMnOpQrStUvWxYz",
            "UPPERCASE123",
            "lowercase456",
            "MiXeDCaSe789",
            "aBcDeFgHiJkLmNoPqRsTuVwXyZ",
        ]

        for place_id in valid_ids:
            try:
                _validate_place_id(place_id)
            except HTTPException:
                pytest.fail(f"Valid mixed-case place_id '{place_id}' was incorrectly rejected")

    def test_underscores_and_hyphens(self):
        """Test that underscores and hyphens are allowed."""
        valid_ids = [
            "place_with_underscores_123",
            "place-with-hyphens-456",
            "place_with-both_789",
            "___underscores___",
            "---hyphens---mixed123",
            "_single_underscore_",
            "-single-hyphen-",
            "mixed_-_hyphens-and_underscores",
        ]

        for place_id in valid_ids:
            try:
                _validate_place_id(place_id)
            except HTTPException:
                pytest.fail(f"Valid place_id '{place_id}' with underscores/hyphens was incorrectly rejected")

    def test_valid_slashes(self):
        """Test that valid place IDs with slashes are accepted."""
        valid_ids = [
            "valid/place-id_123",
            "place/with/slashes/123",
            "multiple/slashes/here/123/456",
            "a/b/c/d/e/f/g/h/i/j",  # Exactly 10 characters with slashes
            "slash/at/start" + "a" * 5,
            "slash" + "a" * 5 + "/at/middle",
            "a" * 5 + "/slash/at/end",
        ]

        for place_id in valid_ids:
            try:
                _validate_place_id(place_id)
            except HTTPException:
                pytest.fail(f"Valid place_id with slashes '{place_id}' was incorrectly rejected")

    def test_url_encoded_traversal_uppercase(self):
        """Test that URL-encoded traversal attempts with uppercase are rejected."""
        malicious_ids = [
            "%2E%2E%2Fetc%2Fpasswd",          # ../etc/passwd (uppercase)
            "path%2E%2E%2Ftraversal",        # path/../traversal (uppercase)
            "%2E%2Fsecret",                 # ./secret (uppercase)
            "traversal%2E%2E%2Fpath",       # traversal/../path (uppercase)
            "%2E%2E%5C%2E%2E%5Cwindows%5Csystem32",  # ..\..\windows\system32 (uppercase)
            "C%3A%2Fwindows%2Fsystem32",     # C:/windows/system32 (uppercase)
        ]

        for place_id in malicious_ids:
            with pytest.raises(HTTPException) as exc_info:
                _validate_place_id(place_id)
            assert exc_info.value.status_code == 400

if __name__ == "__main__":
    # Run tests
    pytest.main([__file__, "-v"])
