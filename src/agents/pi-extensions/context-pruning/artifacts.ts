import type { ToolResultMessage, TextContent, ImageContent } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactRef } from "../../session-artifacts.js";
export type { ArtifactRef } from "../../session-artifacts.js";
import { appendArtifactRegistryEntry, computeArtifactHash } from "../../artifact-registry.js";

type ToolResultArtifact = {
  id: string;
  type: "tool-result";
  toolName?: string;
  createdAt: string;
  sizeBytes: number;
  summary: string;
  content: ToolResultMessage["content"];
};

export function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts;
}

function summarizeText(parts: string[]): string {
  if (parts.length === 0) {
    return "";
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return "";
  }
  const max = 200;
  if (joined.length <= max) {
    return joined;
  }
  return `${joined.slice(0, max)}…`;
}

export function countImages(content: ReadonlyArray<TextContent | ImageContent>): number {
  let count = 0;
  for (const block of content) {
    if (block.type === "image") {
      count += 1;
    }
  }
  return count;
}

export function shouldExternalizeToolResult(params: {
  content: ReadonlyArray<TextContent | ImageContent>;
  maxChars?: number;
}): boolean {
  const maxChars = typeof params.maxChars === "number" ? params.maxChars : 4000;
  if (countImages(params.content) > 0) {
    return true;
  }
  const rawLen = collectTextSegments(params.content).reduce((sum, part) => sum + part.length, 0);
  return rawLen > maxChars;
}

export function buildToolResultPlaceholder(ref: ArtifactRef): string {
  return [
    `[Tool result omitted: stored as artifact]`,
    `id: ${ref.id}`,
    ref.toolName ? `tool: ${ref.toolName}` : null,
    `size: ${Math.round(ref.sizeBytes / 1024)}KB`,
    `created: ${ref.createdAt}`,
    `summary: ${ref.summary}`,
    `path: ${ref.path}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function writeToolResultArtifact(params: {
  artifactDir: string;
  toolName?: string;
  content: ToolResultMessage["content"];
  sessionId?: string;
  sessionKey?: string;
}): ArtifactRef {
  const id = `art_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  const textParts = collectTextSegments(params.content);
  const imageCount = countImages(params.content);
  const summaryText = summarizeText(textParts);
  const summary = summaryText
    ? imageCount > 0
      ? `${summaryText} (${imageCount} image${imageCount === 1 ? "" : "s"})`
      : summaryText
    : imageCount > 0
      ? `${imageCount} image${imageCount === 1 ? "" : "s"}`
      : "tool result";

  const payload: ToolResultArtifact = {
    id,
    type: "tool-result",
    toolName: params.toolName,
    createdAt,
    summary,
    sizeBytes: 0,
    content: params.content,
  };

  const hash = computeArtifactHash(payload.content);
  const serialized = JSON.stringify(payload);
  payload.sizeBytes = Buffer.byteLength(serialized, "utf8");
  const finalSerialized = JSON.stringify(payload, null, 2);

  fs.mkdirSync(params.artifactDir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(params.artifactDir, `${id}.json`);
  fs.writeFileSync(artifactPath, `${finalSerialized}\n`, { mode: 0o600 });

  const ref: ArtifactRef = {
    id,
    type: payload.type,
    toolName: payload.toolName,
    createdAt,
    sizeBytes: payload.sizeBytes,
    summary: payload.summary,
    path: artifactPath,
    hash,
  };

  appendArtifactRegistryEntry({
    artifactDir: params.artifactDir,
    entry: {
      hash,
      artifact: ref,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    },
  });

  return ref;
}
