import fs from "node:fs/promises";
import path from "node:path";

import type {
  AgentMessage,
  AgentToolResult,
} from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  normalizeThinkLevel,
  type ThinkLevel,
} from "../auto-reply/thinking.js";

import { sanitizeContentBlocksImages } from "./tool-images.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

export type EmbeddedContextFile = { path: string; content: string };

const MAX_BOOTSTRAP_CHARS = 4000;
const BOOTSTRAP_HEAD_CHARS = 2800;
const BOOTSTRAP_TAIL_CHARS = 800;

function trimBootstrapContent(content: string, fileName: string): string {
  const trimmed = content.trimEnd();
  if (trimmed.length <= MAX_BOOTSTRAP_CHARS) return trimmed;

  const head = trimmed.slice(0, BOOTSTRAP_HEAD_CHARS);
  const tail = trimmed.slice(-BOOTSTRAP_TAIL_CHARS);
  return [
    head,
    "",
    `[...truncated, read ${fileName} for full content...]`,
    "",
    tail,
  ].join("\n");
}

export async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}) {
  const file = params.sessionFile;
  try {
    await fs.stat(file);
    return;
  } catch {
    // create
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const sessionVersion = 2;
  const entry = {
    type: "session",
    version: sessionVersion,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
  await fs.writeFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}

type ContentBlock = AgentToolResult<unknown>["content"][number];

export async function sanitizeSessionMessagesImages(
  messages: AgentMessage[],
  label: string,
): Promise<AgentMessage[]> {
  // We sanitize historical session messages because Anthropic can reject a request
  // if the transcript contains oversized base64 images (see MAX_IMAGE_DIMENSION_PX).
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolMsg = msg as Extract<AgentMessage, { role: "toolResult" }>;
      const content = Array.isArray(toolMsg.content) ? toolMsg.content : [];
      const nextContent = (await sanitizeContentBlocksImages(
        content as ContentBlock[],
        label,
      )) as unknown as typeof toolMsg.content;
      out.push({ ...toolMsg, content: nextContent });
      continue;
    }

    if (role === "user") {
      const userMsg = msg as Extract<AgentMessage, { role: "user" }>;
      const content = userMsg.content;
      if (Array.isArray(content)) {
        const nextContent = (await sanitizeContentBlocksImages(
          content as unknown as ContentBlock[],
          label,
        )) as unknown as typeof userMsg.content;
        out.push({ ...userMsg, content: nextContent });
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}

export function buildBootstrapContextFiles(
  files: WorkspaceBootstrapFile[],
): EmbeddedContextFile[] {
  const result: EmbeddedContextFile[] = [];
  for (const file of files) {
    if (file.missing) {
      result.push({
        path: file.name,
        content: `[MISSING] Expected at: ${file.path}`,
      });
      continue;
    }
    const trimmed = trimBootstrapContent(file.content ?? "", file.name);
    if (!trimmed) continue;
    result.push({
      path: file.name,
      content: trimmed,
    });
  }
  return result;
}

export function formatAssistantErrorText(
  msg: AssistantMessage,
): string | undefined {
  if (msg.stopReason !== "error") return undefined;
  const raw = (msg.errorMessage ?? "").trim();
  if (!raw) return "LLM request failed with an unknown error.";

  const invalidRequest = raw.match(
    /"type":"invalid_request_error".*?"message":"([^"]+)"/,
  );
  if (invalidRequest?.[1]) {
    return `LLM request rejected: ${invalidRequest[1]}`;
  }

  // Keep it short for WhatsApp.
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

export function isRateLimitAssistantError(
  msg: AssistantMessage | undefined,
): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  const raw = (msg.errorMessage ?? "").toLowerCase();
  if (!raw) return false;
  return isRateLimitErrorMessage(raw);
}

export function isRateLimitErrorMessage(raw: string): boolean {
  const value = raw.toLowerCase();
  return (
    /rate[_ ]limit|too many requests|429/.test(value) ||
    value.includes("exceeded your current quota")
  );
}

export function isAuthErrorMessage(raw: string): boolean {
  const value = raw.toLowerCase();
  if (!value) return false;
  return (
    /invalid[_ ]?api[_ ]?key/.test(value) ||
    value.includes("incorrect api key") ||
    value.includes("invalid token") ||
    value.includes("authentication") ||
    value.includes("unauthorized") ||
    value.includes("forbidden") ||
    value.includes("access denied") ||
    /\b401\b/.test(value) ||
    /\b403\b/.test(value)
  );
}

export function isAuthAssistantError(
  msg: AssistantMessage | undefined,
): boolean {
  if (!msg || msg.stopReason !== "error") return false;
  return isAuthErrorMessage(msg.errorMessage ?? "");
}

function extractSupportedValues(raw: string): string[] {
  const match =
    raw.match(/supported values are:\s*([^\n.]+)/i) ??
    raw.match(/supported values:\s*([^\n.]+)/i);
  if (!match?.[1]) return [];
  const fragment = match[1];
  const quoted = Array.from(fragment.matchAll(/['"]([^'"]+)['"]/g)).map(
    (entry) => entry[1]?.trim(),
  );
  if (quoted.length > 0) {
    return quoted.filter((entry): entry is string => Boolean(entry));
  }
  return fragment
    .split(/,|\band\b/gi)
    .map((entry) => entry.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "").trim())
    .filter(Boolean);
}

export function pickFallbackThinkingLevel(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined {
  const raw = params.message?.trim();
  if (!raw) return undefined;
  const supported = extractSupportedValues(raw);
  if (supported.length === 0) return undefined;
  for (const entry of supported) {
    const normalized = normalizeThinkLevel(entry);
    if (!normalized) continue;
    if (params.attempted.has(normalized)) continue;
    return normalized;
  }
  return undefined;
}
