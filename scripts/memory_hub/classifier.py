from __future__ import annotations


def classify_observation(event: dict) -> dict:
    payload = event.get("payload", {})
    if (
        event.get("event_type") == "user_confirmed"
        and payload.get("stable")
        and payload.get("memory_type") in {"user", "feedback"}
    ):
        return {
            "bucket": "long_term_candidate",
            "risk_level": "low",
            "stability": "stable",
        }
    if event.get("event_type") == "task_completed":
        return {
            "bucket": "daily",
            "risk_level": "medium",
            "stability": "ephemeral",
        }
    return {
        "bucket": "daily",
        "risk_level": "medium",
        "stability": "ephemeral",
    }
