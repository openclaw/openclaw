"""
bodhi_vault.validate — JSON Schema validation for vault nodes.

Validates at the I/O boundary only: on write and on explicit integrity checks.
Uses jsonschema draft-07 to match vault/schema/nodes.json.
"""

import json
from pathlib import Path
from typing import Any

import jsonschema
import jsonschema.exceptions


class ValidationError(ValueError):
    """Raised when a node dict fails schema validation."""


def validate_node(data: dict[str, Any], schema_path: Path) -> None:
    """
    Validate a node dict against the JSON Schema.

    Args:
        data: Raw node dict to validate.
        schema_path: Path to vault/schema/nodes.json.

    Raises:
        ValidationError: If validation fails. Message includes the failing field.
        FileNotFoundError: If schema_path does not exist.
    """
    schema = _load_schema(schema_path)
    try:
        jsonschema.validate(instance=data, schema=schema)
    except jsonschema.exceptions.ValidationError as exc:
        field = " -> ".join(str(p) for p in exc.absolute_path) or "root"
        raise ValidationError(f"Node validation failed at '{field}': {exc.message}") from exc


def _load_schema(schema_path: Path) -> dict[str, Any]:
    """Load and parse schema from disk. No caching — schema files are small."""
    with open(schema_path, encoding="utf-8") as f:
        return json.load(f)
