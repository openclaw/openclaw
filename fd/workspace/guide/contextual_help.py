"""Contextual help — hover/info-icon content for every UI panel.

Each panel declares what it does, what's possible, common prompts,
and what requires approval.  The UI renders this as info icons,
hover cards, and inline guidance.
"""

from __future__ import annotations

HELP_SECTIONS: dict[str, dict] = {
    # ------------------------------------------------------------------
    # Command Center panels
    # ------------------------------------------------------------------
    "today_panel": {
        "title": "Today Panel",
        "description": (
            "Shows what matters right now: priorities, schedule, "
            "deadlines, and action items."
        ),
        "possible_here": [
            "start the day routine",
            "review priorities",
            "check overdue work",
            "see schedule for the next 10 hours",
        ],
        "prompts": [
            "What should I focus on today?",
            "Run the start of day routine.",
            "Show me what's overdue.",
        ],
        "approval_note": "Starting the day routine is safe and doesn't need approval.",
    },
    "schedule_panel": {
        "title": "Schedule Panel",
        "description": (
            "Shows your upcoming events, deadlines, and time blocks "
            "for the next 10 hours."
        ),
        "possible_here": [
            "view upcoming events",
            "check deadline proximity",
            "see today's time blocks",
        ],
        "prompts": [
            "What's on the schedule today?",
            "Show me upcoming deadlines.",
            "What's next?",
        ],
        "approval_note": "Viewing the schedule is always safe.",
    },
    "health_panel": {
        "title": "System Health Panel",
        "description": (
            "Quick status of your cluster nodes, services, and "
            "shared storage. Green means healthy."
        ),
        "possible_here": [
            "check node status",
            "view service health",
            "inspect shared storage",
            "run a deep health check",
        ],
        "prompts": [
            "Are all nodes online?",
            "Run a full health check.",
            "What's the cluster status?",
        ],
        "approval_note": "Health checks are read-only. Restarts need approval.",
    },
    "approvals_panel": {
        "title": "Pending Approvals",
        "description": (
            "Actions waiting for your review. OpenClaw never executes "
            "sensitive changes without your say-so."
        ),
        "possible_here": [
            "review pending actions",
            "approve safe changes",
            "reject risky changes",
            "see what's waiting",
        ],
        "prompts": [
            "What needs my approval?",
            "Show me pending actions.",
            "Approve the top item.",
        ],
        "approval_note": "This panel IS the approval layer.",
    },
    "kpi_chips": {
        "title": "Brand KPI Chips",
        "description": (
            "At-a-glance performance indicators for Full Digital and CUTMV. "
            "Tap any chip for details."
        ),
        "possible_here": [
            "view brand KPIs",
            "drill into performance",
            "compare brands",
        ],
        "prompts": [
            "How is CUTMV performing?",
            "Show me Full Digital KPIs.",
            "Compare both brands.",
        ],
        "approval_note": "Viewing KPIs is always safe.",
    },
    # ------------------------------------------------------------------
    # Finance panels
    # ------------------------------------------------------------------
    "finance_overview": {
        "title": "Finance Overview",
        "description": (
            "Your financial snapshot: cash position, revenue, expenses, "
            "and 30-day forecast."
        ),
        "possible_here": [
            "view cash position",
            "check revenue trends",
            "review expenses",
            "forecast next 30 days",
        ],
        "prompts": [
            "Show me the finance summary.",
            "Forecast next 30 days.",
            "What are our biggest expenses?",
        ],
        "approval_note": "Viewing financials is safe. Adjustments need approval.",
    },
    "grantops_panel": {
        "title": "GrantOps Panel",
        "description": (
            "Grant discovery, scoring, and drafting engine. "
            "Finds opportunities and prepares applications."
        ),
        "possible_here": [
            "scan for grants",
            "score opportunities",
            "draft applications",
            "track submissions",
        ],
        "prompts": [
            "Find grants for Full Digital.",
            "Draft the top two grants.",
            "Show me grants needing review.",
        ],
        "approval_note": "Scanning is automatic. Submitting requires approval.",
    },
    "invoices_panel": {
        "title": "Invoices Panel",
        "description": (
            "Tracks pending, paid, and overdue invoices. "
            "Helps you follow up on late payments."
        ),
        "possible_here": [
            "view pending invoices",
            "check overdue payments",
            "draft follow-up messages",
        ],
        "prompts": [
            "What invoices need attention?",
            "Show me overdue invoices.",
            "Draft a payment reminder.",
        ],
        "approval_note": "Viewing is safe. Sending reminders needs approval.",
    },
    # ------------------------------------------------------------------
    # Marketing panels
    # ------------------------------------------------------------------
    "marketing_panel": {
        "title": "Marketing Panel",
        "description": (
            "Tracks creative testing, ad performance, and "
            "safe scaling opportunities."
        ),
        "possible_here": [
            "generate ad concepts",
            "analyze campaign performance",
            "prepare safe scaling actions",
            "review blocked scaling plans",
        ],
        "prompts": [
            "Generate three CUTMV ad concepts.",
            "Why are ads underperforming?",
            "Show me scaling opportunities.",
        ],
        "approval_note": (
            "Generating concepts is safe. Launching campaigns and "
            "increasing budgets require approval."
        ),
    },
    "ad_performance": {
        "title": "Ad Performance",
        "description": (
            "Campaign metrics: spend, ROAS, CPA, CTR, and conversion data. "
            "Updated in near real-time."
        ),
        "possible_here": [
            "review campaign metrics",
            "identify winners and losers",
            "compare time periods",
        ],
        "prompts": [
            "Which campaigns are winning?",
            "Show me this week's performance.",
            "Why did performance drop?",
        ],
        "approval_note": "Viewing performance data is always safe.",
    },
    # ------------------------------------------------------------------
    # WebOps panels
    # ------------------------------------------------------------------
    "webops_panel": {
        "title": "WebOps Panel",
        "description": (
            "Website health, uptime, speed, tracking pixels, "
            "and recent incidents."
        ),
        "possible_here": [
            "check website health",
            "review incidents",
            "verify tracking",
            "generate repair plans",
        ],
        "prompts": [
            "Check website health.",
            "What's wrong with the site?",
            "Show me recent incidents.",
        ],
        "approval_note": "Health checks are safe. Deploying fixes needs approval.",
    },
    # ------------------------------------------------------------------
    # Prompt bar
    # ------------------------------------------------------------------
    "prompt_bar": {
        "title": "Ask OpenClaw Anything",
        "description": (
            "Type any question or request in plain English. "
            "OpenClaw will understand and help."
        ),
        "possible_here": [
            "ask what to focus on",
            "request reports",
            "generate content",
            "check system status",
            "get how-to guides",
        ],
        "prompts": [
            "What should I focus on today?",
            "Can you find grants for Full Digital?",
            "How do I scale ads safely?",
            "What does this section do?",
        ],
        "approval_note": "Asking questions is always safe.",
    },
}


class ContextualHelpProvider:
    """Serves contextual help content for UI panels."""

    def get_help(self, panel_key: str) -> dict:
        """Return help content for *panel_key*."""
        section = HELP_SECTIONS.get(panel_key)
        if not section:
            return {
                "ok": False,
                "message": "No help content available for this panel yet.",
            }
        return {"ok": True, **section}

    def list_panels(self) -> list[str]:
        """Return all panel keys with help content."""
        return list(HELP_SECTIONS.keys())

    def get_tooltip(self, panel_key: str) -> str | None:
        """Return a short tooltip string for *panel_key*."""
        section = HELP_SECTIONS.get(panel_key)
        if not section:
            return None
        return section["description"]
