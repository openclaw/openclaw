import { object, records, text } from "./files.js";
import type {
  GrokMcpServer,
  GrokSourceAgent,
  GrokSourceIssue,
  GrokSourceSection,
} from "./types.js";

/** Optional snapshot metadata preserves unavailable/partial data from a live read. */
export function snapshotSection<T>(
  section: GrokSourceSection<T>,
  metadata: unknown,
  contentPresent: boolean,
): GrokSourceSection<T> {
  if (metadata === undefined) {
    return section;
  }
  const row = object(metadata);
  const status = row?.status;
  if (
    (status !== "complete" && status !== "partial" && status !== "unavailable") ||
    (row?.reason !== undefined && typeof row.reason !== "string") ||
    (!contentPresent && status !== "unavailable")
  ) {
    throw new Error("Invalid Grok snapshot section completeness.");
  }
  return { status, value: section.value, reason: text(row?.reason) };
}

export function snapshotStatus(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  const result = object(value);
  if (!result) {
    throw new Error("Invalid Grok snapshot section metadata.");
  }
  return result;
}

export function snapshotIssues(value: unknown): GrokSourceIssue[] {
  return records(value).map((row) => {
    if (
      typeof row.code !== "string" ||
      !/^[a-z][a-z0-9_]+$/u.test(row.code) ||
      typeof row.message !== "string" ||
      (row.agentId !== undefined && typeof row.agentId !== "string")
    ) {
      throw new Error("Invalid Grok snapshot source issue.");
    }
    return { code: row.code, message: row.message, agentId: text(row.agentId) };
  });
}

export function snapshotAvatar(value: unknown): NonNullable<GrokSourceAgent["avatar"]>["image"] {
  if (value === undefined) {
    return undefined;
  }
  const row = object(value);
  if (
    !row ||
    typeof row.base64 !== "string" ||
    row.base64.length > Math.ceil((1024 * 1024) / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(row.base64)
  ) {
    throw new Error("Invalid or oversized Grok snapshot avatar.");
  }
  const bytes = Buffer.from(row.base64, "base64");
  const extension = row.extension;
  const matches =
    (extension === "png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (extension === "jpg" && bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) ||
    (extension === "gif" && /^(?:GIF87a|GIF89a)$/u.test(bytes.subarray(0, 6).toString("ascii"))) ||
    (extension === "webp" &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP");
  if (!matches || bytes.length > 1024 * 1024 || bytes.toString("base64") !== row.base64) {
    throw new Error("Grok snapshot avatar must contain a matching PNG, JPEG, GIF, or WebP image.");
  }
  if (extension !== "png" && extension !== "jpg" && extension !== "gif" && extension !== "webp") {
    throw new Error("Unsupported Grok snapshot avatar format.");
  }
  return { bytes, extension };
}

export function applySnapshotMcpMetadata(servers: GrokMcpServer[], value: unknown): void {
  const metadata = snapshotStatus(value);
  for (const server of servers) {
    const row = object(metadata[server.name]);
    if (!row) {
      if (metadata[server.name] !== undefined) {
        throw new Error("Invalid Grok snapshot MCP metadata.");
      }
      continue;
    }
    if (row.instructions !== undefined && typeof row.instructions !== "string") {
      throw new Error("Invalid Grok snapshot MCP instructions.");
    }
    if (
      row.disabledTools !== undefined &&
      (!Array.isArray(row.disabledTools) ||
        !row.disabledTools.every((tool) => typeof tool === "string"))
    ) {
      throw new Error("Invalid Grok snapshot MCP restrictions.");
    }
    server.instructions = text(row.instructions);
    server.disabledTools = row.disabledTools;
  }
}
