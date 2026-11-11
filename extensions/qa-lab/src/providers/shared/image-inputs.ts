import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function countImageInputs(value: unknown, maxVisited = 50_000): number {
  const stack = [value];
  let count = 0;
  let visited = 0;
  while (stack.length > 0 && visited < maxVisited) {
    visited += 1;
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }
    const record = asOptionalRecord(current);
    if (!record) {
      continue;
    }
    const type = record.type;
    if (type === "input_image" || type === "image" || type === "image_url" || type === "media") {
      count += 1;
    }
    stack.push(record.content, record.image_url, record.source);
  }
  return count;
}
