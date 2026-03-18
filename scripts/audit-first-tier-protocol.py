#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path


FIRST_TIER = {
    "tony",
    "bobby-digital",
    "angela",
    "machine",
    "martina",
    "reverend-run",
    "deb",
}

BANNED_BOBBY_TEMPLATES = [
    "method-man.md",
    "odb.md",
    "gza.md",
    "raekwon.md",
    "cilvaringz.md",
    "inspectah-deck.md",
]


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise SystemExit(f"missing required file: {path}")


def extract_allow_agents(text: str) -> list[str]:
    match = re.search(r'"allowAgents"\s*:\s*\[(.*?)\]', text, re.S)
    if not match:
        return []
    return re.findall(r'"([^"]+)"', match.group(1))


def check(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def main() -> int:
    home = Path.home()
    root = home / ".openclaw"
    failures: list[str] = []

    tools_config = read_text(root / "config" / "tools.json5")
    check(
        '"sessionScope": "main_only"' in tools_config,
        "tools.agentToAgent.sessionScope is not set to main_only",
        failures,
    )

    bobby_config = read_text(root / "config" / "agents" / "bobby-digital.json5")
    angela_config = read_text(root / "config" / "agents" / "angela.json5")
    machine_config = read_text(root / "config" / "agents" / "machine.json5")
    bobby_allow = set(extract_allow_agents(bobby_config))
    angela_allow = set(extract_allow_agents(angela_config))
    machine_allow = set(extract_allow_agents(machine_config))
    check(
        len(bobby_allow & (FIRST_TIER - {"bobby-digital"})) == 0,
        "bobby-digital subagents.allowAgents still contains a first-tier lead",
        failures,
    )
    check(
        len(angela_allow & (FIRST_TIER - {"angela"})) == 0,
        "angela subagents.allowAgents still contains a first-tier lead",
        failures,
    )
    check(
        len(machine_allow & (FIRST_TIER - {"machine"})) == 0,
        "machine subagents.allowAgents still contains a first-tier lead",
        failures,
    )

    angela_template = read_text(root / "workspace-angela" / "references" / "spawn-templates" / "angela.md")
    machine_template = read_text(root / "workspace-machine" / "references" / "spawn-templates" / "machine.md")
    martina_template = read_text(root / "workspace-martina" / "references" / "spawn-templates" / "martina.md")
    for label, text in {
        "angela": angela_template,
        "machine": machine_template,
        "martina": martina_template,
    }.items():
        check("sessions_send" in text, f"{label} first-tier template is missing sessions_send", failures)
        check("L1_TASK_V1" in text, f"{label} first-tier template is missing L1_TASK_V1", failures)
        check("L1_STATUS_V1" in text, f"{label} first-tier template is missing L1_STATUS_V1", failures)
        check(
            "sessions_spawn({" not in text,
            f"{label} first-tier template still advertises sessions_spawn",
            failures,
        )

    bobby_templates_root = root / "workspace-bobby-digital" / "references" / "spawn-templates"
    for name in BANNED_BOBBY_TEMPLATES:
        text = read_text(bobby_templates_root / name)
        check(
            "Preferred dispatch path from Tony" not in text,
            f"bobby specialist template still names Tony directly: {name}",
            failures,
        )

    delegations = read_text(root / "workspace-tony" / "memory" / "active" / "delegations.md")
    check("- Current owner:" in delegations, "tony delegations ledger is missing Current owner fields", failures)
    check("- Last status:" in delegations, "tony delegations ledger is missing Last status fields", failures)
    check("- Owner:" not in delegations, "tony delegations ledger still contains legacy Owner fields", failures)
    check(
        "- Current status:" not in delegations,
        "tony delegations ledger still contains legacy Current status fields",
        failures,
    )

    lead_agent_files = {
        "tony": root / "workspace-tony" / "AGENTS.md",
        "bobby-digital": root / "workspace-bobby-digital" / "AGENTS.md",
        "angela": root / "workspace-angela" / "AGENTS.md",
        "machine": root / "workspace-machine" / "AGENTS.md",
        "martina": root / "workspace-martina" / "AGENTS.md",
        "reverend-run": root / "workspace-reverend-run" / "AGENTS.md",
        "deb": root / "workspace-deb" / "AGENTS.md",
    }
    for agent_id, path in lead_agent_files.items():
        text = read_text(path)
        check("L1_TASK_V1" in text, f"{agent_id} AGENTS.md is missing L1_TASK_V1", failures)
        check("L1_STATUS_V1" in text, f"{agent_id} AGENTS.md is missing L1_STATUS_V1", failures)

    if failures:
        print("FIRST_TIER_PROTOCOL_AUDIT: FAIL")
        for item in failures:
            print(f"- {item}")
        return 1

    print("FIRST_TIER_PROTOCOL_AUDIT: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
