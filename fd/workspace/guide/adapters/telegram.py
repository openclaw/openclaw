"""Telegram adapter — renders guide content for Telegram chat.

Supports the following commands:
  /help          — show available commands
  /guide         — start the walkthrough
  /howto <topic> — get a step-by-step guide
  /whatcanido <section> — see section capabilities
  /explain <action>     — what happens if I do this?
"""

from __future__ import annotations

from ..engine import OpenClawGuideEngine
from ..explain import explain_action
from ..prompts import (
    format_contextual_help,
    format_howto,
    format_possibility,
    format_section_description,
    format_walkthrough_step,
)

_engine = OpenClawGuideEngine()


def handle_help() -> str:
    """Respond to /help."""
    return (
        "OpenClaw Guide\n"
        "\n"
        "Available commands:\n"
        "  /help — show this message\n"
        "  /guide — walkthrough of the whole system\n"
        "  /howto <topic> — step-by-step guide\n"
        "  /whatcanido <section> — what's possible here\n"
        "  /explain <action> — what happens if I do this\n"
        "\n"
        "Topics: start_day, grants, scale_ads, health, ads, "
        "onboarding, invoices, telegram, website\n"
        "\n"
        "Sections: command_center, finance, marketing, webops, "
        "grantops, cluster, telegram\n"
        "\n"
        "Or just ask in plain English — I'll figure it out."
    )


def handle_guide(step_index: int = 0) -> str:
    """Respond to /guide with a walkthrough step."""
    step = _engine.get_walkthrough_step(step_index)
    if not step:
        return "That's the end of the tour. You're ready to go."

    total = _engine.walkthrough_length()
    header = f"[{step['step']}/{total}] "
    body = format_walkthrough_step(step)

    if step_index < total - 1:
        body += f"\n\nSend /guide {step_index + 1} for the next step."

    return header + body


def handle_howto(topic: str) -> str:
    """Respond to /howto <topic>."""
    result = _engine.howto(topic)
    return format_howto(result)


def handle_whatcanido(section: str) -> str:
    """Respond to /whatcanido <section>."""
    result = _engine.what_can_i_do(section)
    if result["ok"]:
        return result["message"]
    return result.get("message", "I don't have info on that section yet.")


def handle_explain(action: str) -> str:
    """Respond to /explain <action>."""
    result = explain_action(action)
    lines = [f"**{result['action']}**", "", result["what_happens"]]

    if result.get("automated"):
        lines.append("\nThis is automated — it runs on its own.")
    if result.get("needs_approval"):
        lines.append("This needs your approval before it executes.")

    return "\n".join(lines)


def handle_is_possible(question: str) -> str:
    """Respond to natural-language 'can OpenClaw do X?' questions."""
    result = _engine.is_possible(question)
    return format_possibility(result)


def route_command(text: str) -> str:
    """Route a Telegram message to the right guide handler."""
    text = text.strip()

    if text == "/help":
        return handle_help()

    if text.startswith("/guide"):
        parts = text.split(maxsplit=1)
        index = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        return handle_guide(index)

    if text.startswith("/howto"):
        parts = text.split(maxsplit=1)
        topic = parts[1] if len(parts) > 1 else ""
        return handle_howto(topic)

    if text.startswith("/whatcanido"):
        parts = text.split(maxsplit=1)
        section = parts[1] if len(parts) > 1 else ""
        return handle_whatcanido(section)

    if text.startswith("/explain"):
        parts = text.split(maxsplit=1)
        action = parts[1] if len(parts) > 1 else ""
        return handle_explain(action)

    return ""
