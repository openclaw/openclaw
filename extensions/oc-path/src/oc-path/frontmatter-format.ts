import { isScalar, parseDocument } from "yaml";

// Frontmatter values are string leaves (docs/cli/path.md "Mutation contract"),
// so a value written bare must read back as the same string. Numeric, boolean,
// null, and reserved spellings would otherwise change type or corrupt the block.
function readsBackAsString(value: string): boolean {
  try {
    const node = parseDocument(`value: ${value}`).get("value", true);
    return isScalar(node) && typeof node.value === "string" && node.value === value;
  } catch {
    return false;
  }
}

export function formatFrontmatterValue(value: string): string {
  // Frontmatter is yaml-ish; quote values with structural chars.
  if (value.length === 0) {
    return '""';
  }
  if (
    value.trim() !== value ||
    /^["']/.test(value) ||
    /[:#&*?|<>=!%@`,[\]{}\r\n]/.test(value) ||
    !readsBackAsString(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}
