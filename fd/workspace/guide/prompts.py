"""Prompt templates for guide responses.

These templates produce the plain-English output that adapters render
to the user.  All output reads like a helpful operator, never technical.
"""

from __future__ import annotations


def format_section_description(data: dict) -> str:
    """Format a section description for display."""
    if not data.get("ok"):
        return data.get("message", "No information available.")

    lines = [f"**{data['title']}**", "", data["description"], ""]

    lines.append("What you can do here:")
    for action in data["can_do"]:
        lines.append(f"  - {action}")

    if data.get("requires_approval"):
        lines.append("")
        lines.append("Requires approval:")
        for item in data["requires_approval"]:
            lines.append(f"  - {item}")

    lines.append("")
    lines.append("Try asking:")
    for prompt in data.get("common_prompts", [])[:3]:
        lines.append(f'  "{prompt}"')

    return "\n".join(lines)


def format_howto(data: dict) -> str:
    """Format a how-to plan for display."""
    if not data.get("ok"):
        return data.get("steps", ["Ask in plain English."])[0]

    lines = [f"**{data['title']}**", ""]
    for i, step in enumerate(data["steps"], 1):
        lines.append(f"  {i}. {step}")

    if data.get("notes"):
        lines.append("")
        for note in data["notes"]:
            lines.append(f"  Note: {note}")

    return "\n".join(lines)


def format_possibility(data: dict) -> str:
    """Format an is-it-possible response for display."""
    lines = [data["message"]]
    if data.get("next_step"):
        lines.append(f"\nNext step: {data['next_step']}")
    return "\n".join(lines)


def format_walkthrough_step(step: dict) -> str:
    """Format a single walkthrough step for display."""
    lines = [f"**{step['title']}**", "", step["body"]]
    if step.get("tip"):
        lines.append(f"\nTip: {step['tip']}")
    return "\n".join(lines)


def format_contextual_help(data: dict) -> str:
    """Format contextual help for a panel."""
    if not data.get("ok"):
        return data.get("message", "No help available.")

    lines = [f"**{data['title']}**", "", data["description"], ""]

    lines.append("What's possible here:")
    for action in data["possible_here"]:
        lines.append(f"  - {action}")

    lines.append("")
    lines.append("Try asking:")
    for prompt in data.get("prompts", [])[:3]:
        lines.append(f'  "{prompt}"')

    if data.get("approval_note"):
        lines.append(f"\n{data['approval_note']}")

    return "\n".join(lines)
