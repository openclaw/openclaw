import { createHash } from "node:crypto";
import type { JsonObject } from "./protocol.js";

type ExecutionArtifactKind =
  | "branch"
  | "diff"
  | "commit"
  | "tests"
  | "pr"
  | "deploy"
  | "canary"
  | "readback";

type CodexNativeExecutionReceipt = {
  kind: ExecutionArtifactKind;
  status: "ok" | "error";
  summary: string;
  detail: Record<string, unknown>;
};

const COMMAND_RECEIPT_RULES: ReadonlyArray<{
  kind: ExecutionArtifactKind;
  pattern: RegExp;
}> = [
  {
    kind: "branch",
    pattern:
      /\bgit\s+(?:branch\s+--show-current|switch\b|checkout\s+-b\b|rev-parse\s+--abbrev-ref\b)/iu,
  },
  { kind: "diff", pattern: /\bgit\s+(?:--\S+\s+)*diff\b/iu },
  { kind: "commit", pattern: /\bgit\s+(?:--\S+\s+)*commit\b/iu },
  {
    kind: "tests",
    pattern:
      /(?:^|[;&|]\s*)(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|(?:pnpm\s+)?vitest\b|pytest\b|cargo\s+test\b|go\s+test\b)/iu,
  },
  {
    kind: "pr",
    pattern: /\bgh\s+(?:--\S+\s+)*pr\s+create\b|\bgh\s+api\b[^\n]*\s-X\s+POST\b[^\n]*\/pulls\b/iu,
  },
  {
    kind: "deploy",
    pattern:
      /\b(?:vercel|fly|wrangler)\s+deploy\b|\bsupabase\s+functions\s+deploy\b|(?:^|[;&|]\s*)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:deploy|[\w:-]+:deploy)\b/iu,
  },
  {
    kind: "canary",
    pattern:
      /(?:^|[;&|]\s*)(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:canary|[\w:-]+:canary)\b|[./\w-]*canary(?:\s|$))/iu,
  },
  {
    kind: "readback",
    pattern:
      /(?:^|[;&|]\s*)(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:readback|verify[-:]deploy|smoke[-:]deploy)\b|[./\w-]*(?:readback|verify-deploy|smoke-deploy)(?:\s|$))/iu,
  },
];

const TOOL_RECEIPT_RULES: ReadonlyArray<{
  kind: ExecutionArtifactKind;
  pattern: RegExp;
}> = [
  { kind: "branch", pattern: /(?:^|[._/-])(?:create_?)?branch(?:$|[._/-])/iu },
  { kind: "diff", pattern: /(?:^|[._/-])(?:get_?)?diff(?:$|[._/-])/iu },
  { kind: "commit", pattern: /(?:^|[._/-])commit(?:_?files?)?(?:$|[._/-])/iu },
  { kind: "tests", pattern: /(?:^|[._/-])(?:run_?)?tests?(?:$|[._/-])/iu },
  { kind: "pr", pattern: /(?:^|[._/-])(?:create_?|open_?)(?:pr|pull_?request)(?:$|[._/-])/iu },
  { kind: "deploy", pattern: /(?:^|[._/-])deploy(?:_?site|ment)?(?:$|[._/-])/iu },
  { kind: "canary", pattern: /(?:^|[._/-])canary(?:$|[._/-])/iu },
  {
    kind: "readback",
    pattern:
      /(?:^|[._/-])(?:readback|verify_?deploy(?:ment)?|inspect_?deploy(?:ment)?)(?:$|[._/-])/iu,
  },
];

/**
 * Projects machine receipts only from completed app-server tool items.
 * Assistant text and aggregated command output are deliberately ignored.
 */
export function projectCodexNativeExecutionReceipts(
  item: JsonObject,
): CodexNativeExecutionReceipt[] {
  const itemType = readString(item, "type");
  const failed = isFailedItem(item);
  if (itemType === "fileChange") {
    const changes = readFileChanges(item.changes);
    if (changes.length === 0) {
      return [];
    }
    return [
      {
        kind: "diff",
        status: failed ? "error" : "ok",
        summary: failed
          ? "Codex file-change item failed."
          : "Codex file-change item produced a readable diff.",
        detail: {
          source: "codex-app-server-item",
          itemId: readString(item, "id") ?? "",
          readable: !failed,
          changes,
        },
      },
    ];
  }
  if (itemType === "commandExecution") {
    const command = readString(item, "command");
    if (!command) {
      return [];
    }
    return COMMAND_RECEIPT_RULES.filter((rule) => rule.pattern.test(command)).map((rule) => ({
      kind: rule.kind,
      status: failed ? "error" : "ok",
      summary: `Codex command item produced ${rule.kind} evidence.`,
      detail: {
        source: "codex-app-server-command",
        itemId: readString(item, "id") ?? "",
        commandFingerprint: fingerprint(command),
        ...(readString(item, "cwd") ? { cwd: readString(item, "cwd") } : {}),
        ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      },
    }));
  }
  if (itemType !== "dynamicToolCall" && itemType !== "mcpToolCall") {
    return [];
  }
  const toolName = [readString(item, "server"), readString(item, "tool")].filter(Boolean).join(".");
  if (!toolName) {
    return [];
  }
  return TOOL_RECEIPT_RULES.filter((rule) => rule.pattern.test(toolName)).map((rule) => ({
    kind: rule.kind,
    status: failed ? "error" : "ok",
    summary: `Codex tool item produced ${rule.kind} evidence.`,
    detail: {
      source: "codex-app-server-tool",
      itemId: readString(item, "id") ?? "",
      tool: toolName,
    },
  }));
}

function isFailedItem(item: JsonObject): boolean {
  const status = readString(item, "status");
  return (
    status === "failed" ||
    status === "declined" ||
    (typeof item.exitCode === "number" && item.exitCode !== 0)
  );
}

function readFileChanges(value: unknown): Array<{ path: string; kind: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return typeof record.path === "string" && typeof record.kind === "string"
      ? [{ path: record.path, kind: record.kind }]
      : [];
  });
}

function readString(value: JsonObject, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry : undefined;
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
