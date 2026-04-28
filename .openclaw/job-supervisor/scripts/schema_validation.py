import json
from functools import lru_cache
from pathlib import Path
from typing import Any


CONTRACTS_DIR = Path(__file__).resolve().parents[1] / "contracts"


@lru_cache(maxsize=None)
def load_contract(contract_name: str) -> dict[str, Any]:
    contract_path = CONTRACTS_DIR / contract_name
    with contract_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Contract is not a JSON object: {contract_path}")
    return payload


def validate_with_contract(payload: Any, contract_name: str) -> None:
    contract = load_contract(contract_name)
    _validate_schema_node(payload, contract, "$")


def _validate_schema_node(value: Any, schema: dict[str, Any], path: str) -> None:
    expected_type = schema.get("type")
    if expected_type is not None and not _matches_type(value, expected_type):
        raise ValueError(f"{path}: expected type {_format_expected_type(expected_type)}, got {_json_type_name(value)}")

    if "const" in schema and value != schema["const"]:
        raise ValueError(f"{path}: expected const {schema['const']!r}, got {value!r}")

    if "enum" in schema and value not in schema["enum"]:
        expected = ", ".join(repr(item) for item in schema["enum"])
        raise ValueError(f"{path}: expected one of {expected}, got {value!r}")

    if isinstance(value, str):
        min_length = schema.get("minLength")
        if min_length is not None and len(value) < min_length:
            raise ValueError(f"{path}: expected string length >= {min_length}, got {len(value)}")

    if _is_number(value):
        minimum = schema.get("minimum")
        if minimum is not None and value < minimum:
            raise ValueError(f"{path}: expected value >= {minimum}, got {value}")
        maximum = schema.get("maximum")
        if maximum is not None and value > maximum:
            raise ValueError(f"{path}: expected value <= {maximum}, got {value}")

    if isinstance(value, dict):
        required = schema.get("required") or []
        missing = [field_name for field_name in required if field_name not in value]
        if missing:
            raise ValueError(f"{path}: missing required fields: {', '.join(missing)}")

        properties = schema.get("properties") or {}
        for field_name, field_schema in properties.items():
            if field_name in value:
                _validate_schema_node(value[field_name], field_schema, f"{path}.{field_name}")

    if isinstance(value, list) and "items" in schema:
        item_schema = schema["items"]
        for index, item in enumerate(value):
            _validate_schema_node(item, item_schema, f"{path}[{index}]")


def _matches_type(value: Any, expected_type: Any) -> bool:
    if isinstance(expected_type, list):
        return any(_matches_type(value, type_name) for type_name in expected_type)

    if expected_type == "null":
        return value is None
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "number":
        return _is_number(value)
    if expected_type == "boolean":
        return isinstance(value, bool)

    raise ValueError(f"Unsupported schema type in local validator: {expected_type!r}")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _json_type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _format_expected_type(expected_type: Any) -> str:
    if isinstance(expected_type, list):
        return " | ".join(str(item) for item in expected_type)
    return str(expected_type)
