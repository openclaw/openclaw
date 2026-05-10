import type { JsoncValue } from "@openclaw/oc-path/api.js";

export function jsoncValueToUnknown(value: JsoncValue): unknown {
  switch (value.kind) {
    case "object":
      return Object.fromEntries(
        value.entries.map((entry) => [entry.key, jsoncValueToUnknown(entry.value)]),
      );
    case "array":
      return value.items.map((item) => jsoncValueToUnknown(item));
    case "string":
      return value.value;
    case "number":
      return value.value;
    case "boolean":
      return value.value;
    case "null":
      return null;
  }
}
