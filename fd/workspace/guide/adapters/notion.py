"""Notion adapter — generates guide blocks for Notion HQ pages.

Each Notion dashboard page gets standardized guide blocks:
  - "What this page does"
  - "What's possible here"
  - "Common prompts"
  - "Need help?" link
"""

from __future__ import annotations

from ..capabilities import CAPABILITIES
from ..contextual_help import HELP_SECTIONS


def generate_guide_blocks(section_key: str) -> list[dict]:
    """Generate Notion-compatible guide blocks for a section.

    Returns a list of block dicts that can be inserted into a Notion page
    via the Notion API.
    """
    section = CAPABILITIES.get(section_key)
    if not section:
        return []

    blocks: list[dict] = []

    # --- Divider ---
    blocks.append({"type": "divider", "divider": {}})

    # --- Header: OpenClaw Guide ---
    blocks.append({
        "type": "heading_3",
        "heading_3": {
            "rich_text": [{"type": "text", "text": {"content": "OpenClaw Guide"}}],
        },
    })

    # --- What this page does ---
    blocks.append({
        "type": "callout",
        "callout": {
            "icon": {"type": "emoji", "emoji": "ℹ️"},
            "rich_text": [
                {
                    "type": "text",
                    "text": {
                        "content": f"What this page does\n{section['description']}",
                    },
                },
            ],
        },
    })

    # --- What's possible here ---
    actions_text = "What's possible here\n" + "\n".join(
        f"  • {action}" for action in section["can_do"]
    )
    blocks.append({
        "type": "callout",
        "callout": {
            "icon": {"type": "emoji", "emoji": "⚡"},
            "rich_text": [
                {"type": "text", "text": {"content": actions_text}},
            ],
        },
    })

    # --- Common prompts ---
    prompts_text = "Try asking\n" + "\n".join(
        f'  "{prompt}"' for prompt in section["common_prompts"][:4]
    )
    blocks.append({
        "type": "callout",
        "callout": {
            "icon": {"type": "emoji", "emoji": "💬"},
            "rich_text": [
                {"type": "text", "text": {"content": prompts_text}},
            ],
        },
    })

    # --- Approval note (if any) ---
    if section.get("requires_approval"):
        approval_text = "Requires approval\n" + "\n".join(
            f"  • {item}" for item in section["requires_approval"]
        )
        blocks.append({
            "type": "callout",
            "callout": {
                "icon": {"type": "emoji", "emoji": "🔒"},
                "rich_text": [
                    {"type": "text", "text": {"content": approval_text}},
                ],
            },
        })

    # --- Need help? ---
    blocks.append({
        "type": "paragraph",
        "paragraph": {
            "rich_text": [
                {
                    "type": "text",
                    "text": {
                        "content": "Need help? ",
                    },
                },
                {
                    "type": "text",
                    "text": {
                        "content": "Ask OpenClaw in Telegram or the Command Center.",
                    },
                    "annotations": {"italic": True},
                },
            ],
        },
    })

    return blocks


def generate_all_guide_blocks() -> dict[str, list[dict]]:
    """Generate guide blocks for all sections."""
    return {key: generate_guide_blocks(key) for key in CAPABILITIES}


def generate_guide_markdown(section_key: str) -> str:
    """Generate a markdown version of the guide for a section.

    Useful for rendering in Notion's markdown-friendly blocks or
    for export.
    """
    section = CAPABILITIES.get(section_key)
    if not section:
        return ""

    lines = [
        "---",
        "",
        "### OpenClaw Guide",
        "",
        f"**What this page does:** {section['description']}",
        "",
        "**What's possible here:**",
    ]
    for action in section["can_do"]:
        lines.append(f"- {action}")

    lines.append("")
    lines.append("**Try asking:**")
    for prompt in section["common_prompts"][:4]:
        lines.append(f'- "{prompt}"')

    if section.get("requires_approval"):
        lines.append("")
        lines.append("**Requires approval:**")
        for item in section["requires_approval"]:
            lines.append(f"- {item}")

    lines.append("")
    lines.append("*Need help? Ask OpenClaw in Telegram or the Command Center.*")

    return "\n".join(lines)
