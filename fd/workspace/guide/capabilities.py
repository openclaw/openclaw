"""Capabilities registry — the brain of "what can OpenClaw do?"

Each section declares its name, plain-English description, action list,
common prompts, and which actions require approval.  The Guide Engine
queries this registry to answer questions like "what can I do here?"
"""

from __future__ import annotations

CAPABILITIES: dict[str, dict] = {
    "command_center": {
        "name": "Command Center",
        "description": (
            "Your main operating dashboard for OpenClaw. "
            "It shows priorities, schedule, system health, and what needs action."
        ),
        "can_do": [
            "show priorities",
            "show system health",
            "show today's schedule",
            "run daily workflows",
            "open brand dashboards",
            "review pending approvals",
            "check overdue deadlines",
        ],
        "common_prompts": [
            "What should we focus on today?",
            "Run the start of day routine.",
            "Show me what needs attention.",
            "What's overdue?",
        ],
        "requires_approval": [
            "executing budget changes",
            "launching campaigns",
            "infrastructure changes",
        ],
    },
    "finance": {
        "name": "Finance",
        "description": (
            "Tracks cash, invoices, expenses, forecasts, and grant operations. "
            "Gives you a real-time picture of your financial position."
        ),
        "can_do": [
            "show financial overview",
            "track grants",
            "show pending invoices",
            "forecast cash position",
            "reconcile expenses",
            "generate financial reports",
        ],
        "common_prompts": [
            "Show me the finance summary.",
            "Find grants for Full Digital.",
            "What invoices need attention?",
            "Forecast next 30 days.",
        ],
        "requires_approval": [
            "sending invoices",
            "recording payments",
            "adjusting forecasts",
        ],
    },
    "marketing": {
        "name": "Marketing",
        "description": (
            "Runs campaign analysis, ad generation, testing logic, and "
            "scaling recommendations. Helps you spend smarter."
        ),
        "can_do": [
            "analyze ad performance",
            "generate ad concepts",
            "suggest next tests",
            "prepare scaling plans",
            "rotate creatives",
            "propose campaign changes",
        ],
        "common_prompts": [
            "Generate 3 CUTMV ad concepts.",
            "Why are ads underperforming?",
            "Scale winners carefully.",
            "What should we test next?",
        ],
        "requires_approval": [
            "launching campaigns",
            "increasing budget",
            "applying high-risk changes",
        ],
    },
    "webops": {
        "name": "WebOps",
        "description": (
            "Monitors sites, health, tracking, webhooks, and deployment risks. "
            "Keeps your web presence stable and fast."
        ),
        "can_do": [
            "check website health",
            "show incidents",
            "run safe fixes",
            "generate repair plans",
            "verify tracking pixels",
            "audit webhook status",
        ],
        "common_prompts": [
            "Check website health.",
            "Fix what's broken safely.",
            "What's wrong with the site?",
            "Show me recent incidents.",
        ],
        "requires_approval": [
            "deploying changes",
            "modifying DNS",
            "restarting services",
        ],
    },
    "grantops": {
        "name": "GrantOps",
        "description": (
            "Finds, scores, drafts, and manages grant opportunities. "
            "Automates the tedious parts of grant work."
        ),
        "can_do": [
            "scan for grants",
            "score opportunities",
            "prepare drafts",
            "track submissions",
            "manage deadlines",
            "generate application packages",
        ],
        "common_prompts": [
            "Find grants for Full Digital.",
            "Draft the top two grants.",
            "Show me grants needing review.",
            "What deadlines are coming up?",
        ],
        "requires_approval": [
            "submitting applications",
            "committing to deliverables",
        ],
    },
    "cluster": {
        "name": "Cluster",
        "description": (
            "Manages your compute nodes, shared storage, and service health. "
            "The infrastructure layer that keeps everything running."
        ),
        "can_do": [
            "check node status",
            "show service health",
            "inspect shared storage",
            "run health checks",
            "trigger failover",
            "warm AI models",
        ],
        "common_prompts": [
            "Check cluster health.",
            "Are all nodes online?",
            "Warm the AI models.",
            "Run a full health check.",
        ],
        "requires_approval": [
            "restarting services",
            "triggering failover",
            "modifying cluster config",
        ],
    },
    "telegram": {
        "name": "Telegram Control",
        "description": (
            "Your mobile control layer for approvals, alerts, and prompt-based "
            "actions. Operate OpenClaw from your phone."
        ),
        "can_do": [
            "receive alerts",
            "approve or reject actions",
            "send quick prompts",
            "check status on the go",
            "run guided commands",
        ],
        "common_prompts": [
            "/help — see what you can do",
            "/guide — start the guided tour",
            "/howto start_day — learn the morning routine",
            "/whatcanido marketing — see marketing capabilities",
        ],
        "requires_approval": [],
    },
}


def get_section(key: str) -> dict | None:
    """Return a capability section by key, or ``None``."""
    return CAPABILITIES.get(key)


def list_sections() -> list[str]:
    """Return all registered section keys."""
    return list(CAPABILITIES.keys())


def search_capabilities(query: str) -> list[dict]:
    """Return sections whose capabilities match *query* (case-insensitive)."""
    q = query.lower()
    results = []
    for key, section in CAPABILITIES.items():
        if q in section["name"].lower() or q in section["description"].lower():
            results.append({"key": key, **section})
            continue
        for action in section["can_do"]:
            if q in action.lower():
                results.append({"key": key, **section})
                break
    return results
