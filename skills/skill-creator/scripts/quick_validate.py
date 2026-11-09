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


_SURROGATE_PAIR = re.compile(r"[\uD800-\uDBFF][\uDC00-\uDFFF]")
_YAML12_EXTRA_BREAKS = "\u0085\u2028\u2029"
_EXPLICIT_TAG_PREFIX = re.compile(
    r"^(?:(?:&[^\s]+|#[^\n]*(?:\n|$))\s*)*"
    r"(?P<tag>!![^\s]+|!<[^>]+>|!(?=\s|$)|![^\s]+)"
)


def _js_string_value(value):
    """Recover JavaScript string identity from PyYAML's scalar value."""

    def join_pair(match):
        high, low = map(ord, match.group(0))
        return chr(0x10000 + ((high - 0xD800) << 10) + low - 0xDC00)

    return _SURROGATE_PAIR.sub(join_pair, value)


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


def _js_number(value):
    """Convert an integer to the runtime's IEEE-754 Number value."""

    try:
        return float(value)
    except OverflowError:
        return float("-inf" if value < 0 else "inf")


def _core_int(value):
    """Resolve a YAML core integer, including leading-zero decimals."""

    if _CORE_INT.fullmatch(value):
        return ("number", float(value))
    if _CORE_INT_OCT.fullmatch(value):
        return ("number", _js_number(int(value[2:], 8)))
    if _CORE_INT_HEX.fullmatch(value):
        return ("number", _js_number(int(value[2:], 16)))
    return None


def _core_float(value):
    """Resolve a YAML core float with JavaScript Number identity."""

    if not _CORE_FLOAT.fullmatch(value):
        return None
    lowered = value.lower()
    if lowered.endswith("nan"):
        # The runtime compares scalar values with ===, under which NaN is never equal.
        return ("number", float("nan"))
    if lowered.endswith("inf"):
        return ("number", float("-inf" if value.startswith("-") else "inf"))
    return ("number", float(value))


def _explicit_core_key(tag, value):
    """Resolve a key whose source carries an explicit YAML tag."""

    if tag in {
        "tag:yaml.org,2002:binary",
        "tag:yaml.org,2002:timestamp",
        "tag:yaml.org,2002:merge",
    }:
        # Runtime object values use reference identity, so separate nodes never collide.
        return ("object", object())
    if tag == "tag:yaml.org,2002:null":
        return ("null", None) if _CORE_NULL.fullmatch(value) else ("str", value)
    if tag == "tag:yaml.org,2002:bool":
        return ("bool", value[0] in "tT") if _CORE_BOOL.fullmatch(value) else ("str", value)
    if tag == "tag:yaml.org,2002:int":
        return _core_int(value) or ("str", value)
    if tag == "tag:yaml.org,2002:float":
        return _core_float(value) or ("str", value)
    return ("str", value)


def _core_scalar_key(node, source):
    """Resolve a scalar key the way the runtime's YAML core schema does.

    The loader treats `yes`/`on` as strings but `true` as a boolean, a quoted
    `"true"` stays a string, and an explicit tag wins over the plain spelling,
    so duplicate identity is the typed value.
    """

    value = node.value
    authored = source[node.start_mark.index : node.end_mark.index].lstrip()
    # YAML permits comments between node properties and allows either property order.
    tag_match = _EXPLICIT_TAG_PREFIX.match(authored)
    if tag_match:
        if tag_match.group("tag") == "!":
            # A non-specific `!` always selects the runtime's string scalar schema.
            return ("str", value)
        return _explicit_core_key(node.tag, value)
    if node.style is None:
        if _CORE_NULL.fullmatch(value):
            return ("null", None)
        if _CORE_BOOL.fullmatch(value):
            return ("bool", value[0] in "tT")
        resolved_number = _core_int(value) or _core_float(value)
        if resolved_number is not None:
            return resolved_number
    return ("str", value)


def _load_frontmatter(frontmatter_text: str):
    """Load YAML with the loader's duplicate-key rejection."""

    visited = set()
    alias_ids = set()
    object_identities = {}

    def object_identity(node):
        return object_identities.setdefault(id(node), ("object", object()))

    def check_omap_key(key, key_node, parent_node, keys):
        if key[0] == "number" and key[1] != key[1]:
            key = ("number", "nan")
        if key in keys:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                parent_node.start_mark,
                f"found duplicate key {getattr(key_node, 'value', key_node)!r}",
                key_node.start_mark,
            )
        keys.append(key)

    def validate_node(node, omap_keys=None):
        if id(node) in visited:
            return
        visited.add(id(node))
        if isinstance(node, yaml.ScalarNode):
            node.value = _js_string_value(node.value)
            return
        if isinstance(node, yaml.SequenceNode):
            ordered_map_keys = [] if node.tag == "tag:yaml.org,2002:omap" else None
            for child in node.value:
                if ordered_map_keys is None:
                    validate_node(child)
                    continue

                is_alias = id(child) in visited
                if is_alias:
                    alias_ids.add(id(child))
                if isinstance(child, yaml.MappingNode) and not is_alias:
                    if len(child.value) == 1:
                        validate_node(child, ordered_map_keys)
                    else:
                        validate_node(child)
                        if not child.value:
                            check_omap_key(("null", None), child, node, ordered_map_keys)
                    continue

                # resolvePairs wraps scalar and alias items as keys. An alias to
                # a mapping is an object key, not an expansion of that map's pair.
                validate_node(child)
                if isinstance(child, yaml.ScalarNode):
                    key = _core_scalar_key(child, frontmatter_text)
                    if key[0] == "object":
                        key = object_identity(child)
                else:
                    key = object_identity(child)
                check_omap_key(key, child, node, ordered_map_keys)
            return
        if not isinstance(node, yaml.MappingNode):
            return

        keys = [] if omap_keys is None else omap_keys
        for key_node, value_node in node.value:
            # PyYAML replaces an alias with its anchored node, while the runtime
            # keeps a distinct Alias node that never equals the anchored scalar.
            is_alias = id(key_node) in visited
            validate_node(key_node)
            key = None
            if omap_keys is not None:
                # Ordered maps also resolve aliases and check their final Map keys
                # with SameValueZero. Anchor object identity must survive aliasing.
                if isinstance(key_node, yaml.ScalarNode):
                    key = _core_scalar_key(key_node, frontmatter_text)
                    if key[0] == "object":
                        key = object_identity(key_node)
                else:
                    key = object_identity(key_node)
            elif isinstance(key_node, yaml.ScalarNode):
                # SafeLoader constructs YAML 1.1 values and flattens merge keys.
                # Check the raw core-schema identities before either behavior.
                key = ("alias", object()) if is_alias else _core_scalar_key(key_node, frontmatter_text)
            if key is not None:
                if omap_keys is not None:
                    check_omap_key(key, key_node, node, keys)
                else:
                    if key in keys:
                        raise yaml.constructor.ConstructorError(
                            "while constructing a mapping",
                            node.start_mark,
                            f"found duplicate key {key_node.value!r}",
                            key_node.start_mark,
                        )
                    keys.append(key)
            validate_node(value_node)

    class UniqueKeyLoader(yaml.SafeLoader):
        def scan_flow_scalar_non_spaces(self, double, start_mark):
            if self.peek() in _YAML12_EXTRA_BREAKS:
                # YAML 1.2 keeps NEL/LS/PS inside a quoted scalar instead of folding it.
                character = self.peek()
                self.forward()
                return [character]
            return super().scan_flow_scalar_non_spaces(double, start_mark)

        def scan_flow_scalar_spaces(self, double, start_mark):
            if self.peek() in _YAML12_EXTRA_BREAKS:
                return []
            if self.peek() in " \t":
                length = 0
                while self.peek(length) in " \t":
                    length += 1
                if self.peek(length) in _YAML12_EXTRA_BREAKS:
                    whitespace = self.prefix(length)
                    self.forward(length)
                    return [whitespace]
            return super().scan_flow_scalar_spaces(double, start_mark)

        def scan_flow_scalar_breaks(self, double, start_mark):
            chunks = []
            while True:
                prefix = self.prefix(3)
                if prefix in {"---", "..."} and self.peek(3) in (
                    "\0 \t\r\n" + _YAML12_EXTRA_BREAKS
                ):
                    raise yaml.scanner.ScannerError(
                        "while scanning a quoted scalar",
                        start_mark,
                        "found unexpected document separator",
                        self.get_mark(),
                    )
                while self.peek() in " \t":
                    self.forward()
                if self.peek() in _YAML12_EXTRA_BREAKS:
                    return chunks
                if self.peek() in "\r\n":
                    chunks.append(self.scan_line_break())
                else:
                    return chunks

        def construct_yaml_omap(self, node):
            # The runtime wraps scalar and alias items as keys, rather than
            # requiring every ordered-map entry to be a one-pair mapping.
            omap = []
            yield omap
            if not isinstance(node, yaml.SequenceNode):
                raise yaml.constructor.ConstructorError(
                    "while constructing an ordered map",
                    node.start_mark,
                    f"expected a sequence, but found {node.id}",
                    node.start_mark,
                )
            for subnode in node.value:
                if id(subnode) in alias_ids or not isinstance(subnode, yaml.MappingNode):
                    key_node, value_node = subnode, None
                elif len(subnode.value) > 1:
                    raise yaml.constructor.ConstructorError(
                        "while constructing an ordered map",
                        node.start_mark,
                        f"expected a single mapping item, but found {len(subnode.value)} items",
                        subnode.start_mark,
                    )
                elif subnode.value:
                    key_node, value_node = subnode.value[0]
                else:
                    key_node = value_node = None
                key = self.construct_object(key_node) if key_node is not None else None
                value = self.construct_object(value_node) if value_node is not None else None
                omap.append((key, value))

        def construct_document(self, node):
            validate_node(node)
            return super().construct_document(node)

    UniqueKeyLoader.add_constructor(
        "tag:yaml.org,2002:omap",
        UniqueKeyLoader.construct_yaml_omap,
    )
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
