"""How-to planner — step-by-step guides for common operations.

Users ask things like "how do I start the day?" or "how do I run grants?"
and the planner returns a structured, plain-English response.
"""

from __future__ import annotations

HOWTO_LIBRARY: dict[str, dict] = {
    "start_day": {
        "title": "How to start the day",
        "steps": [
            "Open the Today panel in the Command Center.",
            "Review the brand KPI chips for Full Digital and CUTMV.",
            "Check the schedule for the next 10 hours.",
            "Review overdue deadlines.",
            "Press Start the Day to run sync and refresh widgets.",
            "Review any warnings or approvals that need attention.",
        ],
        "notes": [
            "This routine gives you the clearest snapshot of what matters right now.",
            "Sensitive changes still require approval.",
        ],
        "section": "command_center",
    },
    "grant_scan": {
        "title": "How to run a grant scan",
        "steps": [
            "Go to Finance > GrantOps.",
            "Review the GrantOps summary panel.",
            "Run the daily grant scan.",
            "Review the top scored opportunities.",
            "Approve draft generation for strong matches.",
            "Review packages before submission.",
        ],
        "notes": [
            "GrantOps can automate discovery and drafting, but some submissions "
            "may still require approval or manual review.",
        ],
        "section": "grantops",
    },
    "scale_ads": {
        "title": "How to scale ads safely",
        "steps": [
            "Go to Marketing.",
            "Ask OpenClaw to analyze campaign performance.",
            "Review the recommended scaling actions.",
            "Check spend impact, cap usage, and projected totals.",
            "If safe, approve the scaling action.",
            "If blocked, review the reallocation or alternative scaling plan.",
        ],
        "notes": [
            "Budget increases and high-risk changes require approval.",
            "OpenClaw will warn you before you exceed caps.",
        ],
        "section": "marketing",
    },
    "check_health": {
        "title": "How to check system health",
        "steps": [
            "Open the Command Center.",
            "Look at the System Health widget for a quick status.",
            "For a deeper check, ask 'Run a full health check.'",
            "Review node status, service health, and shared storage.",
            "If any node is degraded, OpenClaw will suggest next steps.",
        ],
        "notes": [
            "Health checks are read-only and never require approval.",
            "If M1 is down, OpenClaw can failover to M4 automatically.",
        ],
        "section": "cluster",
    },
    "generate_ads": {
        "title": "How to generate ad concepts",
        "steps": [
            "Go to Marketing.",
            "Ask OpenClaw to generate ad concepts (e.g., 'Generate 3 CUTMV ad concepts').",
            "Review the generated hooks, angles, and copy.",
            "Pick the ones you like and request full creative briefs.",
            "Approve for production or request revisions.",
        ],
        "notes": [
            "Generation is automatic. Launching campaigns requires approval.",
        ],
        "section": "marketing",
    },
    "onboard_client": {
        "title": "How to onboard a new client",
        "steps": [
            "Ask OpenClaw 'Start client onboarding.'",
            "Provide the client name and brand (Full Digital or CUTMV).",
            "OpenClaw will create the Trello board, Notion page, and GHL contact.",
            "Review the generated onboarding checklist.",
            "Complete each step — OpenClaw tracks progress automatically.",
        ],
        "notes": [
            "Board creation and contact setup may require approval depending on your settings.",
        ],
        "section": "command_center",
    },
    "manage_invoices": {
        "title": "How to manage invoices",
        "steps": [
            "Go to Finance.",
            "Ask 'Show me pending invoices.'",
            "Review the list of outstanding invoices and aging.",
            "For overdue items, ask OpenClaw to draft a follow-up.",
            "Approve sending the follow-up message.",
        ],
        "notes": [
            "Sending invoices and payment reminders requires approval.",
        ],
        "section": "finance",
    },
    "use_telegram": {
        "title": "How to use Telegram with OpenClaw",
        "steps": [
            "Open Telegram and find the OpenClaw bot.",
            "Send /help to see available commands.",
            "Use /guide to start a guided tour.",
            "Use plain English prompts just like in the Command Center.",
            "Approve or reject actions directly in the chat.",
        ],
        "notes": [
            "Telegram supports all the same prompts as the Command Center.",
            "Approvals appear as inline buttons you can tap.",
        ],
        "section": "telegram",
    },
    "check_website": {
        "title": "How to check website health",
        "steps": [
            "Go to WebOps.",
            "Ask 'Check website health.'",
            "Review the health report: uptime, speed, tracking, errors.",
            "If issues are found, review the suggested repair plan.",
            "Approve safe fixes or escalate complex ones.",
        ],
        "notes": [
            "Health checks are read-only. Deploying fixes requires approval.",
        ],
        "section": "webops",
    },
}

# Aliases so users can use natural language topic names
_ALIASES: dict[str, str] = {
    "start day": "start_day",
    "morning routine": "start_day",
    "daily routine": "start_day",
    "grants": "grant_scan",
    "grant": "grant_scan",
    "find grants": "grant_scan",
    "scale": "scale_ads",
    "scaling": "scale_ads",
    "ads": "generate_ads",
    "ad concepts": "generate_ads",
    "health": "check_health",
    "health check": "check_health",
    "cluster": "check_health",
    "onboarding": "onboard_client",
    "new client": "onboard_client",
    "invoices": "manage_invoices",
    "billing": "manage_invoices",
    "telegram": "use_telegram",
    "website": "check_website",
    "site health": "check_website",
}


class HowToPlanner:
    """Resolves how-to topics and returns step-by-step plans."""

    def get_plan(self, topic: str) -> dict:
        """Return a step-by-step plan for *topic*.

        Accepts exact keys (``start_day``) or natural aliases (``morning routine``).
        """
        key = _ALIASES.get(topic.lower().strip(), topic.lower().strip())
        if key in HOWTO_LIBRARY:
            return {"ok": True, **HOWTO_LIBRARY[key]}
        return {
            "ok": False,
            "title": "No guide found yet",
            "steps": [
                "Ask in plain English what you want to do and OpenClaw "
                "will help break it down."
            ],
            "notes": [],
        }

    def list_topics(self) -> list[dict]:
        """Return a summary of all available how-to topics."""
        return [
            {"key": key, "title": entry["title"], "section": entry.get("section", "")}
            for key, entry in HOWTO_LIBRARY.items()
        ]

    def search(self, query: str) -> list[dict]:
        """Find how-to topics matching *query*."""
        q = query.lower()
        results = []
        for key, entry in HOWTO_LIBRARY.items():
            if q in key or q in entry["title"].lower():
                results.append({"key": key, **entry})
                continue
            for step in entry["steps"]:
                if q in step.lower():
                    results.append({"key": key, **entry})
                    break
        return results
