import type { ToolResultMessage } from "@mariozechner/pi-ai";
import fs from "node:fs";
import type { ArtifactRef } from "./session-artifacts.js";
import { withToolResultArtifactRef } from "./session-artifacts.js";

export type ToolResultArtifactPayload = {
  id: string;
  type: "tool-result";
  toolName?: string;
  createdAt: string;
  sizeBytes: number;
  summary: string;
  content: ToolResultMessage["content"];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function readToolResultArtifactPayload(
  artifactPath: string,
): ToolResultArtifactPayload | null {
  try {
    const raw = fs.readFileSync(artifactPath, "utf-8").trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as ToolResultArtifactPayload;
    if (!isRecord(parsed) || parsed.type !== "tool-result") {
      return null;
    }
    if (!Array.isArray(parsed.content)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function rehydrateToolResultMessage(params: {
  artifactRef: ArtifactRef;
  toolCallId?: string;
}): ToolResultMessage | null {
  const payload = readToolResultArtifactPayload(params.artifactRef.path);
  if (!payload) {
    return null;
  }
  const details = withToolResultArtifactRef(undefined, params.artifactRef);
  const timestamp = Number.isFinite(Date.parse(payload.createdAt))
    ? Date.parse(payload.createdAt)
    : Date.now();
  return {
    role: "toolResult",
    toolCallId: params.toolCallId ?? "",
    toolName: payload.toolName ?? params.artifactRef.toolName ?? "unknown",
    content: payload.content,
    details,
    isError: false,
    timestamp,
  };
}
