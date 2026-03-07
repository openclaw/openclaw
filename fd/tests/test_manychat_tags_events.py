from __future__ import annotations

from packages.integrations.manychat.events import (
    is_valid_event,
    parse_webhook_event,
)
from packages.integrations.manychat.tags import (
    build_tag,
    extract_campaign,
    extract_revenue_tier,
    extract_status,
    parse_tags,
)

# --- Tag parsing tests ---


def test_parse_tags_full():
    tags = ["campaign:test_camp", "source:ig_dm", "status:qualified", "revenue:growth", "random"]
    result = parse_tags(tags)
    assert result["campaign"] == ["test_camp"]
    assert result["source"] == ["ig_dm"]
    assert result["status"] == ["qualified"]
    assert result["revenue"] == ["growth"]
    assert result["other"] == ["random"]


def test_parse_tags_empty():
    result = parse_tags([])
    assert all(len(v) == 0 for v in result.values())


def test_parse_tags_multiple_same_category():
    tags = ["campaign:camp1", "campaign:camp2"]
    result = parse_tags(tags)
    assert result["campaign"] == ["camp1", "camp2"]


def test_build_tag():
    assert build_tag("campaign", "test_camp") == "campaign:test_camp"
    assert build_tag("status", "BOOKED") == "status:booked"
    assert build_tag("unknown", "value") == "value"


def test_extract_status():
    assert extract_status(["status:new", "campaign:test"]) == "new"
    assert extract_status(["campaign:test"]) is None


def test_extract_campaign():
    assert extract_campaign(["campaign:fd_warm", "status:new"]) == "fd_warm"
    assert extract_campaign(["status:new"]) is None


def test_extract_revenue_tier():
    assert extract_revenue_tier(["revenue:scale"]) == "scale"
    assert extract_revenue_tier([]) is None


# --- Event parsing tests ---


def test_parse_webhook_event_subscriber_object():
    payload = {
        "event": "tag_applied",
        "subscriber": {
            "id": "sub_123",
            "email": "test@example.com",
            "phone": "+15551234567",
            "first_name": "John",
            "last_name": "Doe",
            "tags": [{"name": "campaign:test"}, {"name": "status:qualified"}],
            "custom_fields": {"utm_source": "instagram"},
        },
    }
    result = parse_webhook_event(payload)
    assert result["event_type"] == "tag_applied"
    assert result["subscriber_id"] == "sub_123"
    assert result["tags"] == ["campaign:test", "status:qualified"]
    assert result["email"] == "test@example.com"
    assert result["custom_fields"]["utm_source"] == "instagram"


def test_parse_webhook_event_flat_tags():
    payload = {
        "event": "subscriber_created",
        "subscriber_id": "sub_456",
        "tags": ["campaign:fd_warm", "source:ig_dm"],
    }
    result = parse_webhook_event(payload)
    assert result["subscriber_id"] == "sub_456"
    assert result["tags"] == ["campaign:fd_warm", "source:ig_dm"]


def test_parse_webhook_event_minimal():
    result = parse_webhook_event({})
    assert result["event_type"] == "unknown"
    assert result["subscriber_id"] is None


def test_is_valid_event():
    valid = {"subscriber_id": "sub_123", "event_type": "tag_applied"}
    assert is_valid_event(valid) is True

    invalid_no_sub = {"event_type": "tag_applied"}
    assert is_valid_event(invalid_no_sub) is False

    invalid_unknown = {"subscriber_id": "sub_123", "event_type": "unknown"}
    assert is_valid_event(invalid_unknown) is False
