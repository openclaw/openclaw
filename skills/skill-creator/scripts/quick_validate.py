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
_BLOCK_SCALAR_HEADER = re.compile(r"[>|](?:[1-9][+-]?|[+-][1-9]?)?")


def _split_lines(content: str) -> list[str]:
    """Split like the runtime parser: normalize CRLF/CR, then break on LF only."""
    return content.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _extract_frontmatter(content: str) -> Optional[str]:
    lines = _split_lines(content)
    # The loader only recognizes a fence that starts the file; leading indentation
    # leaves the frontmatter unparsed even though the rest looks like YAML.
    if not lines or lines[0].rstrip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].rstrip() == "---":
            return "\n".join(lines[1:i])
    return None


def _strip_scalar_comment(value: str) -> str:
    if value.startswith("#"):
        return ""
    # Only a leading quote delimits a quoted scalar; apostrophes in plain text do not.
    return re.sub(r"""^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^'"].*?)[ \t]+#.*$""", r"\1", value)


def _parse_simple_frontmatter(frontmatter_text: str) -> Optional[dict[str, str]]:
    """
    Minimal fallback parser used when PyYAML is unavailable.
    Supports simple `key: value` mappings used by SKILL.md frontmatter.
    """
    parsed: dict[str, str] = {}
    current_key: Optional[str] = None
    block_scalar = False
    for raw_line in frontmatter_text.split("\n"):
        stripped = raw_line.strip()
        is_indented = raw_line[:1].isspace()
        if not stripped or (stripped.startswith("#") and not (block_scalar and is_indented)):
            continue

        if is_indented:
            if current_key is None:
                return None
            current_value = parsed[current_key]
            if not block_scalar:
                if not current_value:
                    stripped = _strip_scalar_comment(stripped)
                elif not current_value.startswith(("'", '"')):
                    # Quotes on a plain scalar's continuation are literal text.
                    stripped = re.sub(r"[ \t]+#.*$", "", stripped)
            parsed[current_key] = f"{current_value}\n{stripped}" if current_value else stripped
            continue

        if ":" not in stripped:
            return None
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = _strip_scalar_comment(value.strip())
        if not key:
            return None
        # Block headers describe the scalar; only its indented body is content.
        block_scalar = bool(_BLOCK_SCALAR_HEADER.fullmatch(value))
        if block_scalar:
            value = ""
        elif (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        parsed[key] = value
        current_key = key
    return parsed


def _strip_quotes(value: str) -> str:
    quote = value[:1]
    return value[1:-1] if quote in {"'", '"'} and value.endswith(quote) else value


_CORE_NULL = re.compile(r"^(?:~|[Nn]ull|NULL)?$")
_CORE_BOOL = re.compile(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$")
_CORE_INT = re.compile(r"^[-+]?[0-9]+$")
_CORE_INT_OCT = re.compile(r"^0o[0-7]+$")
_CORE_INT_HEX = re.compile(r"^0x[0-9a-fA-F]+$")
_CORE_FLOAT = re.compile(
    r"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+"
    r"|[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)"
    r"|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$"
)


def _core_scalar_key(node):
    """Resolve a plain scalar key the way the runtime's YAML core schema does.

    The loader treats `yes`/`on` as strings but `true` as a boolean, and a
    quoted `"true"` stays a string, so duplicate identity is the typed value.
    """

    value = node.value
    if node.style is None:
        if _CORE_NULL.fullmatch(value):
            return ("null", None)
        if _CORE_BOOL.fullmatch(value):
            return ("bool", value[0] in "tT")
        if _CORE_INT.fullmatch(value):
            return ("int", int(value, 10))
        if _CORE_INT_OCT.fullmatch(value):
            return ("int", int(value[2:], 8))
        if _CORE_INT_HEX.fullmatch(value):
            return ("int", int(value[2:], 16))
        if _CORE_FLOAT.fullmatch(value):
            lowered = value.lower()
            if lowered.endswith("nan"):
                return ("float", "nan")
            if lowered.endswith("inf"):
                return ("float", -1 if value.startswith("-") else 1, "inf")
            return ("float", float(value))
    return ("str", value)


def _load_frontmatter(frontmatter_text: str):
    """Load YAML with the loader's duplicate-key rejection."""

    class UniqueKeyLoader(yaml.SafeLoader):
        def construct_mapping(self, node, deep=False):
            keys = []
            for key_node, _ in node.value:
                # Merge keys are flattened by SafeConstructor and have no constructor.
                if key_node.tag == "tag:yaml.org,2002:merge":
                    continue
                # SafeLoader constructs YAML 1.1 booleans, so `yes`/`on` collide
                # with `true`; the core schema used by the runtime reader keeps
                # them distinct. Compare typed core values, not constructed keys.
                if not isinstance(key_node, yaml.ScalarNode):
                    continue
                key = _core_scalar_key(key_node)
                if key in keys:
                    raise yaml.constructor.ConstructorError(
                        "while constructing a mapping",
                        node.start_mark,
                        f"found duplicate key {key_node.value!r}",
                        key_node.start_mark,
                    )
                keys.append(key)
            return super().construct_mapping(node, deep=deep)

    return yaml.load(frontmatter_text, Loader=UniqueKeyLoader)


def _recover_colon_rich_description(frontmatter_text: str, error) -> Optional[dict[str, str]]:
    """Quote the `description` value the loader would recover, then parse again.

    The loader recovers free-form description text when YAML fails at that line
    because the plain scalar contains `: `. Mirror that single-line recovery so
    the validator accepts the files the loader loads, and leave every other YAML
    defect (including duplicate keys) an error.
    """
    if not isinstance(error, yaml.scanner.ScannerError):
        return None
    mark = getattr(error, "problem_mark", None)
    lines = frontmatter_text.split("\n")
    if mark is None or not 0 <= mark.line < len(lines):
        return None
    pattern = r"""(?:description|"description"|'description'):[ \t]*(.*)"""
    match = re.fullmatch(pattern, lines[mark.line])
    if not match:
        return None
    value = match.group(1).strip()
    # Only recover the mapping-value failure; a missing space after the mapping
    # colon leaves no top-level description pair for the loader to recover.
    colon_rich = ": " in value or getattr(error, "problem", None) == (
        "mapping values are not allowed here"
    )
    if not value or not colon_rich or _BLOCK_SCALAR_HEADER.fullmatch(value):
        return None
    lines[mark.line] = f"description: {json.dumps(_strip_quotes(value), ensure_ascii=False)}"
    try:
        parsed = _load_frontmatter("\n".join(lines))
    except yaml.YAMLError:
        return None
    return parsed if isinstance(parsed, dict) else None


def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    try:
        content = skill_md.read_text(encoding="utf-8-sig")
    except OSError as e:
        return False, f"Could not read SKILL.md: {e}"

    frontmatter_text = _extract_frontmatter(content)
    if frontmatter_text is None:
        return False, "Invalid frontmatter format"
    if yaml is not None:
        try:
            frontmatter = _load_frontmatter(frontmatter_text)
            if not isinstance(frontmatter, dict):
                return False, "Frontmatter must be a YAML dictionary"
        except yaml.YAMLError as e:
            frontmatter = _recover_colon_rich_description(frontmatter_text, e)
            if frontmatter is None:
                return False, f"Invalid YAML in frontmatter: {e}"
    else:
        frontmatter = _parse_simple_frontmatter(frontmatter_text)
        if frontmatter is None:
            return (
                False,
                "Invalid YAML in frontmatter: unsupported syntax without PyYAML installed",
            )

    allowed_properties = {
        "name",
        "description",
        "homepage",
        "license",
        "allowed-tools",
        "user-invocable",
        "disable-model-invocation",
        "command-dispatch",
        "command-tool",
        "command-arg-mode",
        "metadata",
    }

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

    name = frontmatter.get("name", "")
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if not name:
        return False, "Name must not be empty"
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
    if not description:
        return False, "Description must not be empty"
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
