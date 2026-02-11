"""
Unit tests for Google Places API place_id validation.

These tests ensure that the _validate_place_id function correctly:
1. Accepts valid Google Place IDs
2. Rejects path traversal attempts (including URL-encoded variants)
3. Rejects malformed place IDs
4. Handles edge cases properly
"""

import pytest
from fastapi import HTTPException

from local_places.google_places import _validate_place_id, get_place_details


class TestValidatePlaceId:
    """Test suite for place_id validation."""
    
    def test_valid_place_ids(self):
        """Test that valid Google Place IDs are accepted."""
        valid_ids = [
            "ChIJN1t_tDeuEmsRUsoyG83frY4",  # Common format starting with ChIJ
            "Ei1Tb21lIFBsYWNlIE5hbWU",      # Base64-like format
            "GhIJQWJjZGVmZ2hpamtsbW5vcA",   # Starting with GhIJ
            "valid-place_id+123",            # With underscores, hyphens, plus
            "place_id=value",                # With equals sign
            "valid/place-id_123",            # With forward slash (legitimate in Google Place IDs)
            "A" * 100,                       # Long valid ID
            "1234567890",                    # Numeric only (minimum length)
            "ChIJ+abc-def_ghi=jkl/mno",     # All allowed special chars
        ]
        
        for place_id in valid_ids:
            # Should not raise exception
            try:
                _validate_place_id(place_id)
            except HTTPException:
                pytest.fail(f"Valid place_id '{place_id}' was incorrectly rejected")
    
    def test_path_traversal_attempts(self):
        """Test that path traversal attempts are rejected."""
        malicious_ids = [
            "../../../etc/passwd",
            "place/../other",
            "./local/file",
            "..\\..\\windows\\system32",
            "place/../../file",
            "//network/share",
            "place\\\\share",
        ]
        
        for place_id in malicious_ids:
            with pytest.raises(HTTPException) as exc_info:
                _validate_place_id(place_id)
            assert exc_info.value.status_code == 400
            assert "path traversal" in exc_info.value.detail.lower() or "Invalid place_id format" in exc_info.value.detail
    
    def test_url_encoded_traversal(self):
        """Test that URL-encoded path traversal attempts are rejected."""
        encoded_attacks = [
            "%2e%2e%2f%2e%2e%2ffile",  # Lowercase URL-encoded ../
            "%2E%2E%2Ffile",           # Uppercase URL-encoded ../
            "%2e%2e/file",             # Mixed encoding
            "place%2f%2fshare",        # URL-encoded //
            "%2E%2E%5C%2E%2E%5Cfile",  # URL-encoded ..\..\file
        ]
        
        for place_id in encoded_attacks:
            with pytest.raises(HTTPException) as exc_info:
                _validate_place_id(place_id)
            assert exc_info.value.status_code == 400
    
    def test_special_characters(self):
        """Test that place IDs with dangerous special characters are rejected."""
        invalid_ids = [
            "place@id",              # @ symbol
            "place id",              # Space
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
            "place'quote",           # Single quote
            'place"quote',           # Double quote
            "place%percent",         # Percent (not part of valid encoding)
        ]
        
        for place_id in invalid_ids:
            with pytest.raises(HTTPException) as exc_info:
                _validate_place_id(place_id)
            assert exc_info.value.status_code == 400
    
    def test_empty_or_none(self):
        """Test that empty or None place IDs are rejected."""
        invalid_ids = [
            "",
            None,
        ]
        
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
        ]
        
        for place_id in valid_ids:
            try:
                _validate_place_id(place_id)
            except HTTPException:
                pytest.fail(f"Valid mixed-case place_id '{place_id}' was incorrectly rejected")
    
    def test_allowed_special_characters(self):
        """Test that allowed special characters (+ = / _ -) are accepted."""
        valid_ids = [
            "place_with_underscores_123",
            "place-with-hyphens-456",
            "place+with+plus+789",
            "place=with=equals=012",
            "place/with/slashes/345",
            "place_with-mixed+special=chars/678",
        ]
        
        for place_id in valid_ids:
            try:
                _validate_place_id(place_id)
            except HTTPException:
                pytest.fail(f"Valid place_id '{place_id}' with allowed special chars was incorrectly rejected")
    
    def test_double_dot_variations(self):
        """Test that various double-dot patterns are caught."""
        patterns = [
            "..",
            "../",
            "/..",
            "/../",
            "place..id",
            "..place",
            "place..",
        ]
        
        for pattern in patterns:
            with pytest.raises(HTTPException) as exc_info:
                _validate_place_id(pattern)
            assert exc_info.value.status_code == 400
    
    def test_double_slash_variations(self):
        """Test that double slashes are rejected (even though single slashes are allowed)."""
        patterns = [
            "//",
            "place//id",
            "//place",
            "place//",
            "place///id",
        ]
        
        for pattern in patterns:
            with pytest.raises(HTTPException) as exc_info:
                _validate_place_id(pattern)
            assert exc_info.value.status_code == 400


class TestGetPlaceDetailsValidation:
    """Integration tests for place_id validation in get_place_details."""
    
    def test_get_place_details_rejects_path_traversal(self, monkeypatch):
        """Test that get_place_details rejects path traversal attempts."""
        # The validation should fail before any network calls
        
        with pytest.raises(HTTPException) as exc_info:
            get_place_details("../../../etc/passwd")
        
        assert exc_info.value.status_code == 400
    
    def test_get_place_details_rejects_special_chars(self, monkeypatch):
        """Test that get_place_details rejects special characters."""
        
        with pytest.raises(HTTPException) as exc_info:
            get_place_details("place@invalid")
        
        assert exc_info.value.status_code == 400
    
    def test_get_place_details_rejects_url_encoded_traversal(self, monkeypatch):
        """Test that get_place_details rejects URL-encoded traversal (both cases)."""
        
        # Lowercase encoding
        with pytest.raises(HTTPException) as exc_info:
            get_place_details("%2e%2e%2ffile")
        assert exc_info.value.status_code == 400
        
        # Uppercase encoding
        with pytest.raises(HTTPException) as exc_info:
            get_place_details("%2E%2E%2Ffile")
        assert exc_info.value.status_code == 400
    
    def test_get_place_details_accepts_valid_id(self, monkeypatch):
        """Test that get_place_details accepts valid place IDs."""
        # Mock the _request function to avoid actual API calls
        def mock_request(*args, **kwargs):
            class MockResponse:
                status_code = 200
                def json(self):
                    return {
                        "id": "ChIJN1t_tDeuEmsRUsoyG83frY4",
                        "displayName": {"text": "Test Place"},
                        "formattedAddress": "123 Test St",
                    }
                @property
                def text(self):
                    return "{}"
            return MockResponse()
        
        # Patch the _request function
        import local_places.google_places
        monkeypatch.setattr(local_places.google_places, "_request", mock_request)
        
        # Should not raise exception during validation
        try:
            result = get_place_details("ChIJN1t_tDeuEmsRUsoyG83frY4")
            # If we get here, validation passed (API call was mocked)
            assert result.place_id == "ChIJN1t_tDeuEmsRUsoyG83frY4"
        except HTTPException as e:
            # If it fails, it should NOT be due to validation
            assert "Invalid place_id" not in e.detail


if __name__ == "__main__":
    # Run tests
    pytest.main([__file__, "-v"])
