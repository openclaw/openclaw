#!/usr/bin/env python3
"""
Quick validation script for skills - minimal version
"""

import json
import re
import sys
from pathlib import Path
from typing import Optional

try:
    import yaml
except ModuleNotFoundError:
    yaml = None

MAX_SKILL_NAME_LENGTH = 64


def _extract_frontmatter(content: str) -> Optional[str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i])
    return None


def _parse_simple_frontmatter(frontmatter_text: str) -> Optional[dict[str, str]]:
    """
    Minimal fallback parser used when PyYAML is unavailable.
    Supports simple `key: value` mappings used by SKILL.md frontmatter.
    """
    parsed: dict[str, str] = {}
    current_key: Optional[str] = None
    for raw_line in frontmatter_text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        is_indented = raw_line[:1].isspace()
        if is_indented:
            if current_key is None:
                return None
            current_value = parsed[current_key]
            parsed[current_key] = (
                f"{current_value}\n{stripped}" if current_value else stripped
            )
            continue

        if ":" not in stripped:
            return None
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            return None
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        parsed[key] = value
        current_key = key
    return parsed


def _coerce_fallback_scalar(token: str):
    stripped = token.strip()
    if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in {'"', "'"}:
        quote = stripped[0]
        inner = stripped[1:-1]
        if quote == '"':
            return bytes(inner, "utf-8").decode("unicode_escape")
        # YAML single-quoted strings escape apostrophes by doubling them.
        return inner.replace("''", "'")

    lowered = stripped.lower()
    if lowered in {"null", "~"}:
        return None
    if lowered == "true":
        return True
    if lowered == "false":
        return False

    if re.fullmatch(r"[+-]?\d+", stripped):
        try:
            return int(stripped)
        except ValueError:
            pass

    if re.fullmatch(r"[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?", stripped) or re.fullmatch(
        r"[+-]?\d+[eE][+-]?\d+", stripped
    ):
        try:
            return float(stripped)
        except ValueError:
            pass

    return stripped


def _parse_fallback_flow_list(value: str):
    """Best-effort parser for YAML/JSON flow lists in no-PyYAML mode."""
    stripped = value.strip()
    if not (stripped.startswith("[") and stripped.endswith("]")):
        return None

    inner = stripped[1:-1].strip()
    if not inner:
        return []

    raw_items = []
    current: list[str] = []
    quote: Optional[str] = None
    escape = False

    for char in inner:
        if quote is not None:
            current.append(char)
            if escape:
                escape = False
            elif quote == '"' and char == "\\":
                escape = True
            elif char == quote:
                quote = None
            continue

        if char in {'"', "'"}:
            quote = char
            current.append(char)
            continue
        if char == ",":
            raw_items.append("".join(current).strip())
            current = []
            continue
        current.append(char)

    if quote is not None or escape:
        return None

    raw_items.append("".join(current).strip())
    try:
        return [_coerce_fallback_scalar(item) for item in raw_items]
    except UnicodeDecodeError:
        return None


def _coerce_allowed_tools(value):
    """
    Normalize allowed-tools into a list when possible.

    The fallback parser (used without PyYAML) returns multiline values as strings,
    so we accept simple "- tool" lines and flow-style arrays.
    """
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            try:
                parsed = json.loads(stripped)
                return parsed
            except json.JSONDecodeError:
                parsed = _parse_fallback_flow_list(stripped)
                if parsed is not None:
                    return parsed

        lines = [line.strip() for line in value.splitlines() if line.strip()]
        if lines:
            parsed_lines = []
            for line in lines:
                if line == "-":
                    parsed_lines.append("")
                    continue
                if not line.startswith("- "):
                    break
                parsed_lines.append(line[2:].strip())
            else:
                return parsed_lines

    return value


def _validate_allowed_tools(value, *, allow_fallback_string_coercion=False):
    if value is None:
        return False, "'allowed-tools' must be a list of tool names"

    normalized = (
        _coerce_allowed_tools(value) if allow_fallback_string_coercion else value
    )
    if not isinstance(normalized, list):
        return False, "'allowed-tools' must be a list of tool names"

    for idx, tool in enumerate(normalized, start=1):
        if not isinstance(tool, str):
            return False, f"'allowed-tools' entry #{idx} must be a string"
        if not tool.strip():
            return False, f"'allowed-tools' entry #{idx} cannot be empty"

    return True, None


def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError as e:
        return False, f"Could not read SKILL.md: {e}"

    frontmatter_text = _extract_frontmatter(content)
    if frontmatter_text is None:
        return False, "Invalid frontmatter format"
    using_fallback_parser = yaml is None
    if not using_fallback_parser:
        try:
            frontmatter = yaml.safe_load(frontmatter_text)
            if not isinstance(frontmatter, dict):
                return False, "Frontmatter must be a YAML dictionary"
        except yaml.YAMLError as e:
            return False, f"Invalid YAML in frontmatter: {e}"
    else:
        frontmatter = _parse_simple_frontmatter(frontmatter_text)
        if frontmatter is None:
            return (
                False,
                "Invalid YAML in frontmatter: unsupported syntax without PyYAML installed",
            )

    allowed_properties = {"name", "description", "license", "allowed-tools", "metadata"}

    unexpected_keys = set(frontmatter.keys()) - allowed_properties
    if unexpected_keys:
        allowed = ", ".join(sorted(allowed_properties))
        unexpected = ", ".join(sorted(unexpected_keys))
        return (
            False,
            f"Unexpected key(s) in SKILL.md frontmatter: {unexpected}. Allowed properties are: {allowed}",
        )

    if "name" not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if "description" not in frontmatter:
        return False, "Missing 'description' in frontmatter"

    if "allowed-tools" in frontmatter:
        allowed_tools_valid, allowed_tools_error = _validate_allowed_tools(
            frontmatter.get("allowed-tools"),
            allow_fallback_string_coercion=using_fallback_parser,
        )
        if not allowed_tools_valid:
            return False, allowed_tools_error

    name = frontmatter.get("name", "")
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if name:
        if not re.match(r"^[a-z0-9-]+$", name):
            return (
                False,
                f"Name '{name}' should be hyphen-case (lowercase letters, digits, and hyphens only)",
            )
        if name.startswith("-") or name.endswith("-") or "--" in name:
            return (
                False,
                f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens",
            )
        if len(name) > MAX_SKILL_NAME_LENGTH:
            return (
                False,
                f"Name is too long ({len(name)} characters). "
                f"Maximum is {MAX_SKILL_NAME_LENGTH} characters.",
            )

    description = frontmatter.get("description", "")
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if description:
        if "<" in description or ">" in description:
            return False, "Description cannot contain angle brackets (< or >)"
        if len(description) > 1024:
            return (
                False,
                f"Description is too long ({len(description)} characters). Maximum is 1024 characters.",
            )

    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
