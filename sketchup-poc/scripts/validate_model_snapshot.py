#!/usr/bin/env python3

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any


class ValidationError(Exception):
    pass


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def ensure_type(value: Any, expected: Any, path: str) -> None:
    expected_types = expected if isinstance(expected, list) else [expected]
    for item in expected_types:
        if item == "object" and isinstance(value, dict):
            return
        if item == "array" and isinstance(value, list):
            return
        if item == "string" and isinstance(value, str):
            return
        if item == "integer" and isinstance(value, int) and not isinstance(value, bool):
            return
        if item == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
            return
        if item == "boolean" and isinstance(value, bool):
            return
        if item == "null" and value is None:
            return
    raise ValidationError(f"{path}: expected {expected_types}, got {type(value).__name__}")


def validate_datetime(value: str, path: str) -> None:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(f"{path}: invalid date-time '{value}'") from exc


def resolve_pointer(document: Any, pointer: str) -> Any:
    current = document
    if not pointer:
        return current
    for part in pointer.lstrip("/").split("/"):
        token = part.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            current = current[token]
        elif isinstance(current, list):
            current = current[int(token)]
        else:
            raise KeyError(token)
    return current


def resolve_schema_ref(ref: str, schema_root: dict[str, Any], schema_path: Path) -> tuple[dict[str, Any], dict[str, Any], Path]:
    ref_path, _, fragment = ref.partition("#")
    if ref_path:
        target_path = (schema_path.parent / ref_path).resolve()
        target_root = load_json(target_path)
    else:
        target_path = schema_path
        target_root = schema_root

    target_schema = target_root
    if fragment:
        target_schema = resolve_pointer(target_root, fragment)
    if not isinstance(target_schema, dict):
        raise ValidationError(f"{ref}: resolved schema is not an object")
    return target_schema, target_root, target_path


def validate(value: Any, schema: dict[str, Any], path: str = "$", schema_root: dict[str, Any] | None = None, schema_path: Path | None = None) -> None:
    schema_root = schema if schema_root is None else schema_root
    if schema_path is None:
        raise ValidationError(f"{path}: schema path is required for validation")

    if "$ref" in schema:
        target_schema, target_root, target_path = resolve_schema_ref(schema["$ref"], schema_root, schema_path)
        validate(value, target_schema, path, target_root, target_path)
        return

    if "type" in schema:
        ensure_type(value, schema["type"], path)

    if "const" in schema and value != schema["const"]:
        raise ValidationError(f"{path}: expected const {schema['const']!r}, got {value!r}")

    if "enum" in schema and value not in schema["enum"]:
        raise ValidationError(f"{path}: expected one of {schema['enum']}, got {value!r}")

    if schema.get("format") == "date-time" and isinstance(value, str):
        validate_datetime(value, path)

    if "minLength" in schema and isinstance(value, str) and len(value) < schema["minLength"]:
        raise ValidationError(f"{path}: expected minimum length {schema['minLength']}, got {len(value)}")

    if "minimum" in schema and isinstance(value, (int, float)) and value < schema["minimum"]:
        raise ValidationError(f"{path}: value {value} is below minimum {schema['minimum']}")

    if "allOf" in schema:
        for index, nested_schema in enumerate(schema["allOf"]):
            validate(value, nested_schema, f"{path}.allOf[{index}]", schema_root, schema_path)

    if "oneOf" in schema:
        matches = []
        errors = []
        for nested_schema in schema["oneOf"]:
            try:
                validate(value, nested_schema, path, schema_root, schema_path)
                matches.append(nested_schema)
            except ValidationError as exc:
                errors.append(str(exc))
        if len(matches) != 1:
            raise ValidationError(f"{path}: expected exactly one matching schema in oneOf, got {len(matches)} ({'; '.join(errors)})")

    condition = schema.get("if")
    if isinstance(condition, dict):
        condition_matched = True
        try:
            validate(value, condition, path, schema_root, schema_path)
        except ValidationError:
            condition_matched = False
        if condition_matched and isinstance(schema.get("then"), dict):
            validate(value, schema["then"], path, schema_root, schema_path)
        if (not condition_matched) and isinstance(schema.get("else"), dict):
            validate(value, schema["else"], path, schema_root, schema_path)

    if isinstance(value, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in value:
                raise ValidationError(f"{path}: missing required property '{key}'")

        properties = schema.get("properties", {})
        additional_allowed = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in properties:
                validate(item, properties[key], f"{path}.{key}", schema_root, schema_path)
            elif additional_allowed is False:
                raise ValidationError(f"{path}: unexpected property '{key}'")
            elif isinstance(additional_allowed, dict):
                validate(item, additional_allowed, f"{path}.{key}", schema_root, schema_path)

    if isinstance(value, list):
        min_items = schema.get("minItems")
        if min_items is not None and len(value) < min_items:
            raise ValidationError(f"{path}: expected at least {min_items} items, got {len(value)}")

        max_items = schema.get("maxItems")
        if max_items is not None and len(value) > max_items:
            raise ValidationError(f"{path}: expected at most {max_items} items, got {len(value)}")

        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(value):
                validate(item, item_schema, f"{path}[{index}]", schema_root, schema_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a snapshot JSON against the local schema.")
    parser.add_argument(
        "--schema",
        default="contracts/model-snapshot.schema.json",
        help="Path to the schema file.",
    )
    parser.add_argument(
        "--input",
        default="samples/sample-model-snapshot.json",
        help="Path to the snapshot JSON to validate.",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    schema_path = (repo_root / args.schema).resolve()
    input_path = (repo_root / args.input).resolve()

    schema = load_json(schema_path)
    payload = load_json(input_path)
    validate(payload, schema, schema_root=schema, schema_path=schema_path)

    print(f"VALID {input_path} against {schema_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
