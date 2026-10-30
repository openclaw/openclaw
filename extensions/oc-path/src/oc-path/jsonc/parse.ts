import {
  type Node as JsoncParserNode,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js";
import type { JsoncAst, JsoncEntry, JsoncValue } from "./ast.js";

const MAX_PARSE_DEPTH = 256;

// parseTree allocates before our depth check; cap source bytes to bound that allocation.
export const MAX_JSONC_INPUT_BYTES = 16 * 1024 * 1024;

type LineForOffset = (offset: number) => number;

export function parseJsonc(raw: string): JsoncAst & { oversizedInputBytes?: number } {
  const inputBytes = Buffer.byteLength(raw, "utf8");
  if (inputBytes > MAX_JSONC_INPUT_BYTES) {
    return { kind: "jsonc", raw, root: null, oversizedInputBytes: inputBytes };
  }

  if (raw.trim().length === 0) {
    return { kind: "jsonc", raw, root: null };
  }

  const parseSource = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const errors: ParseError[] = [];
  const tree = parseTree(parseSource, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: true,
  });
  const lineForOffset = createLineForOffset(parseSource);
  const treeEnd = tree ? tree.offset + tree.length : 0;
  let root: JsoncValue | null = null;
  if (
    tree &&
    errors.every((error) => {
      const code = printParseErrorCode(error.error);
      return code === "EndOfFileExpected" || (code === "InvalidSymbol" && error.offset >= treeEnd);
    })
  ) {
    try {
      root = nodeToJsoncValue(tree, lineForOffset, 0);
    } catch {
      // Depth-limited values remain unaddressable; raw bytes are retained.
    }
  }

  return { kind: "jsonc", raw, root };
}

function nodeToJsoncValue(
  node: JsoncParserNode,
  lineForOffset: LineForOffset,
  depth: number,
): JsoncValue {
  if (depth > MAX_PARSE_DEPTH) {
    throw new Error(`structural depth exceeded MAX_PARSE_DEPTH (${MAX_PARSE_DEPTH})`);
  }
  const line = lineForOffset(node.offset);
  switch (node.type) {
    case "object":
      return {
        kind: "object",
        line,
        entries: (node.children ?? []).flatMap((child): JsoncEntry[] => {
          if (child.type !== "property") {
            return [];
          }
          const keyNode = child.children?.[0];
          const valueNode = child.children?.[1];
          if (!keyNode || !valueNode) {
            return [];
          }
          return [
            {
              key: String(keyNode.value),
              line: lineForOffset(keyNode.offset),
              value: nodeToJsoncValue(valueNode, lineForOffset, depth + 1),
            },
          ];
        }),
      };
    case "array":
      return {
        kind: "array",
        line,
        items: (node.children ?? []).map((child) =>
          nodeToJsoncValue(child, lineForOffset, depth + 1),
        ),
      };
    case "string":
      return { kind: "string", value: String(node.value), line };
    case "number":
      return { kind: "number", value: Number(node.value), line };
    case "boolean":
      return { kind: "boolean", value: Boolean(node.value), line };
    case "null":
      return { kind: "null", line };
    default:
      return { kind: "null", line };
  }
}

function createLineForOffset(raw: string): LineForOffset {
  const starts = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\n" || (raw[i] === "\r" && raw[i + 1] !== "\n")) {
      starts.push(i + 1);
    }
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const start = starts[mid] ?? 0;
      if (start <= offset) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return Math.max(1, high + 1);
  };
}
