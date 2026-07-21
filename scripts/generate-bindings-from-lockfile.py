#!/usr/bin/env python3
"""
Generate openclaw.json bindings from agents.lock.toml.

Reads a TOML lockfile produced by scripts/generate-agents-lock.py and merges
route bindings into openclaw.json.  Existing bindings whose agentId is NOT in
the lockfile are preserved unchanged.

Usage:
    python scripts/generate-bindings-from-lockfile.py [OPTIONS]

Options:
    --lockfile PATH       Path to agents.lock.toml  (default: agents.lock.toml)
    --config PATH         Path to openclaw.json     (default: openclaw.json)
    --dry-run             Print the merged JSON to stdout without writing
    -h, --help            Show this help message
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# TOML parsing — prefer stdlib (3.11+), fall back to tomli, else naive parser
# ---------------------------------------------------------------------------

def _parse_toml(text: str) -> dict:
    """Parse TOML text into a dict.  Tries tomllib/tomli, falls back to a
    minimal inline parser sufficient for the lockfile shape."""
    # Python 3.11+
    try:
        import tomllib  # type: ignore[import-untyped]
        return tomllib.loads(text)
    except ModuleNotFoundError:
        pass

    # tomli (pip install tomli)
    try:
        import tomli  # type: ignore[import-untyped]
        return tomli.loads(text)
    except ModuleNotFoundError:
        pass

    # Minimal parser — handles [section] headers, bare key = "value", and
    # key = ["array"] patterns.  Good enough for the lockfile contract.
    return _naive_toml(text)


def _naive_toml(text: str) -> dict:
    """Extremely minimal TOML parser for the lockfile shape."""
    result: dict = {}
    current: dict = result
    path_stack: list[str] = []

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        # Section header: [agents.linux_desktop_seed]
        if line.startswith("[") and line.endswith("]"):
            inner = line[1:-1].strip()
            parts = [p.strip() for p in inner.split(".")]
            current = result
            path_stack = []
            for part in parts:
                if part not in current:
                    current[part] = {}
                current = current[part]
                path_stack.append(part)
            continue

        # Key = value
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()

        # Strip comments (naive: only trailing #)
        # Be careful not to strip '#' inside quotes
        in_string = False
        quote_char = ""
        comment_pos = -1
        for i, ch in enumerate(value):
            if ch in ('"', "'") and not in_string:
                in_string = True
                quote_char = ch
            elif ch == quote_char and in_string:
                in_string = False
                quote_char = ""
            elif ch == "#" and not in_string:
                comment_pos = i
                break
        if comment_pos >= 0:
            value = value[:comment_pos].rstrip()

        # Parse value
        parsed = _parse_toml_value(value)
        current[key] = parsed

    return result


def _parse_toml_value(value: str):
    """Parse a single TOML value from a string."""
    value = value.strip()

    # Quoted string
    if (value.startswith('"') and value.endswith('"')) or \
       (value.startswith("'") and value.endswith("'")):
        return value[1:-1]

    # Boolean
    if value.lower() in ("true", "false"):
        return value.lower() == "true"

    # Integer
    try:
        return int(value)
    except ValueError:
        pass

    # Float
    try:
        return float(value)
    except ValueError:
        pass

    # Array
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        items = []
        for item in _split_toml_array(inner):
            items.append(_parse_toml_value(item.strip()))
        return items

    # Bare string fallback
    return value


def _split_toml_array(inner: str) -> list[str]:
    """Split a TOML array string, respecting quoted strings."""
    items: list[str] = []
    depth = 0
    in_string = False
    quote_char = ""
    current: list[str] = []

    for ch in inner:
        if ch in ('"', "'") and not in_string:
            in_string = True
            quote_char = ch
        elif ch == quote_char and in_string:
            in_string = False
            quote_char = ""
        elif ch == "[" and not in_string:
            depth += 1
        elif ch == "]" and not in_string:
            depth -= 1
        elif ch == "," and depth == 0 and not in_string:
            items.append("".join(current))
            current = []
            continue
        current.append(ch)

    if current:
        items.append("".join(current))

    return items


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def load_lockfile(path: Path) -> dict:
    """Load and parse the agents lockfile."""
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    return _parse_toml(text)


def load_config(path: Path) -> dict:
    """Load openclaw.json.  Returns empty dict if missing."""
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    return json.loads(text)


def build_bindings_from_lockfile(data: dict) -> list[dict]:
    """Extract route bindings from lockfile data."""
    bindings: list[dict] = []
    agents = data.get("agents", {})
    if not isinstance(agents, dict):
        return bindings

    for agent_id, agent_data in agents.items():
        if not isinstance(agent_data, dict):
            continue

        allowed_channels = agent_data.get("allowed_channels", [])
        if not isinstance(allowed_channels, list) or not allowed_channels:
            continue

        for channel_id in allowed_channels:
            channel_id_str = str(channel_id)
            binding: dict = {
                "agentId": agent_id,
                "match": {
                    "channel": "discord",
                    "peer": {"id": channel_id_str},
                },
            }
            bindings.append(binding)

    return bindings


def merge_bindings(existing: list[dict], lockfile_bindings: list[dict]) -> list[dict]:
    """Merge lockfile bindings into existing bindings.

    Strategy:
      - Keep all existing bindings whose agentId is NOT in the lockfile set.
      - Replace all bindings whose agentId IS in the lockfile set with the
        lockfile-generated ones.
    """
    lockfile_agent_ids = {b["agentId"] for b in lockfile_bindings}

    # Preserve non-lockfile bindings (in their original order)
    preserved = [b for b in existing if b.get("agentId") not in lockfile_agent_ids]

    # Lockfile bindings appended (order doesn't matter for matching, but
    # keeping them grouped is cleaner)
    return preserved + lockfile_bindings


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate openclaw.json bindings from agents.lock.toml",
    )
    parser.add_argument(
        "--lockfile",
        type=Path,
        default=Path("agents.lock.toml"),
        help="Path to agents.lock.toml (default: agents.lock.toml)",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("openclaw.json"),
        help="Path to openclaw.json (default: openclaw.json)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the merged JSON to stdout without writing",
    )
    args = parser.parse_args()

    # --- Load lockfile ---------------------------------------------------
    if not args.lockfile.exists():
        print(
            f"warning: lockfile not found at {args.lockfile}, no changes made",
            file=sys.stderr,
        )
        return 0

    try:
        lockfile_data = load_lockfile(args.lockfile)
    except Exception as exc:
        print(f"error: failed to parse lockfile {args.lockfile}: {exc}", file=sys.stderr)
        return 1

    # --- Load config -----------------------------------------------------
    try:
        config = load_config(args.config)
    except json.JSONDecodeError as exc:
        print(
            f"error: failed to parse {args.config}: {exc}",
            file=sys.stderr,
        )
        return 1

    # --- Build & merge bindings ------------------------------------------
    lockfile_bindings = build_bindings_from_lockfile(lockfile_data)
    existing_bindings = config.get("bindings", [])
    if not isinstance(existing_bindings, list):
        existing_bindings = []

    merged_bindings = merge_bindings(existing_bindings, lockfile_bindings)
    config["bindings"] = merged_bindings

    # --- Output ----------------------------------------------------------
    output = json.dumps(config, indent=2, ensure_ascii=False) + "\n"

    if args.dry_run:
        print(output)
        return 0

    args.config.write_text(output, encoding="utf-8")
    print(
        f"written {len(merged_bindings)} binding(s) to {args.config}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
