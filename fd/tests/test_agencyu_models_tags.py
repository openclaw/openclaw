from __future__ import annotations

from packages.agencyu.manychat.tags import parse_manychat_tags
from packages.agencyu.models import LeadStage, PainPoint, RevenueTier, Source


def test_parse_all_tags():
    tags = [
        "status:qualified",
        "revenue:15k_50k",
        "pain:acquisition",
        "source:meta_ad",
        "campaign:jan_blueprint",
        "engaged:replied",
        "engaged:link_clicked",
    ]
    result = parse_manychat_tags(tags)
    assert result.stage == LeadStage.QUALIFIED
    assert result.revenue_tier == RevenueTier._15K_50K
    assert result.pain_point == PainPoint.ACQUISITION
    assert result.source == Source.META_AD
    assert result.campaign == "jan_blueprint"
    assert result.engaged_flags == ["link_clicked", "replied"]


def test_parse_empty_tags():
    result = parse_manychat_tags([])
    assert result.stage is None
    assert result.revenue_tier is None
    assert result.campaign is None
    assert result.engaged_flags == []


def test_parse_unknown_values_ignored():
    tags = ["status:unknown_stage", "revenue:invalid", "pain:nope"]
    result = parse_manychat_tags(tags)
    assert result.stage is None
    assert result.revenue_tier is None
    assert result.pain_point is None


def test_parse_case_insensitive():
    tags = ["Status:BOOKED", "Source:CLICK_TO_DM"]
    result = parse_manychat_tags(tags)
    assert result.stage == LeadStage.BOOKED
    assert result.source == Source.CLICK_TO_DM


def test_parse_revenue_dash_to_underscore():
    tags = ["revenue:5k-15k"]
    result = parse_manychat_tags(tags)
    assert result.revenue_tier == RevenueTier._5K_15K


def test_lead_stage_values():
    assert LeadStage.NEW.value == "new"
    assert LeadStage.NURTURE.value == "nurture"


def test_source_values():
    assert Source.META_AD.value == "meta_ad"
    assert Source.STORY_REPLY.value == "story_reply"
