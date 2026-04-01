#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


PLUGIN_ID = "auto-session-closeout"


def default_openclaw_home() -> Path:
    return Path(os.environ.get("OPENCLAW_HOME", Path.home() / ".openclaw"))


def default_config_path() -> Path:
    return default_openclaw_home() / "openclaw.json"


def default_workspace_path() -> Path:
    return Path(os.environ.get("OPENCLAW_WORKSPACE", default_openclaw_home() / "workspace"))


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        return data
    raise SystemExit(f"Config file is not a JSON object: {path}")


def unique_strings(values: list[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        cleaned = value.strip()
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result


def resolve_list_arg(values: list[str] | None, defaults: list[str]) -> list[str]:
    if values is None:
        return defaults.copy()
    return unique_strings(values)


def update_config(data: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    plugins = data.get("plugins")
    if not isinstance(plugins, dict):
        plugins = {}

    plugin_dir = str((args.workspace / ".openclaw" / "extensions" / PLUGIN_ID).resolve())

    allow = plugins.get("allow")
    if not isinstance(allow, list):
        allow = []
    allow = unique_strings([*(item for item in allow if isinstance(item, str)), PLUGIN_ID])

    load = plugins.get("load")
    if not isinstance(load, dict):
        load = {}
    load_paths = load.get("paths")
    if not isinstance(load_paths, list):
        load_paths = []
    load_paths = unique_strings([*(item for item in load_paths if isinstance(item, str)), plugin_dir])

    entries = plugins.get("entries")
    if not isinstance(entries, dict):
        entries = {}

    existing_entry = entries.get(PLUGIN_ID)
    if not isinstance(existing_entry, dict):
        existing_entry = {}

    config_payload = existing_entry.get("config")
    if not isinstance(config_payload, dict):
        config_payload = {}

    config_payload.update(
        {
            "agentIds": resolve_list_arg(args.agent_id, ["main"]),
            "triggers": resolve_list_arg(args.trigger, ["user"]),
            "minItems": args.min_items,
            "applyCloseout": not args.no_apply_closeout,
            "applyMemory": not args.no_apply_memory,
            "timeoutSeconds": args.timeout_seconds,
            "harnessPath": str((args.workspace / "scripts" / "openclaw_harness.py").resolve()),
        }
    )
    if args.python_bin:
        config_payload["pythonBin"] = args.python_bin

    entries[PLUGIN_ID] = {
        **existing_entry,
        "enabled": True,
        "config": config_payload,
    }

    plugins["allow"] = allow
    plugins["load"] = {
        **load,
        "paths": load_paths,
    }
    plugins["entries"] = entries

    return {
        **data,
        "plugins": plugins,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Enable the workspace auto-session-closeout plugin in OpenClaw config.")
    parser.add_argument("--config", type=Path, default=default_config_path())
    parser.add_argument("--workspace", type=Path, default=default_workspace_path())
    parser.add_argument("--agent-id", action="append", default=None, help="Agent id to auto-closeout. Repeat for more ids.")
    parser.add_argument("--trigger", action="append", default=None, help="Allowed trigger kind. Repeat for more.")
    parser.add_argument("--min-items", type=int, default=2)
    parser.add_argument("--timeout-seconds", type=int, default=20)
    parser.add_argument("--python-bin")
    parser.add_argument("--no-apply-closeout", action="store_true")
    parser.add_argument("--no-apply-memory", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    data = load_json(args.config)
    updated = update_config(data, args)
    rendered = json.dumps(updated, ensure_ascii=False, indent=2) + "\n"

    if args.dry_run:
        print(rendered, end="")
        return 0

    args.config.parent.mkdir(parents=True, exist_ok=True)
    args.config.write_text(rendered, encoding="utf-8")
    print(f"Enabled {PLUGIN_ID} in {args.config}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
