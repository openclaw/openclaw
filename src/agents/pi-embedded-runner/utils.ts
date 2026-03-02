import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";

export function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh"; OpenClaw enables it for specific models.
  if (!level) {
    return "off";
  }
  // "adaptive" maps to "medium" at the pi-agent-core layer.  The Pi SDK
  // provider then translates this to `thinking.type: "adaptive"` with
  // `output_config.effort: "medium"` for models that support it (Opus 4.6,
  // Sonnet 4.6).
  if (level === "adaptive") {
    return "medium";
  }
  return level;
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    // Preserve upstream provider diagnostics when available.
    // Many SDK errors carry structured fields (status, error body, response) that
    // are not included in `message`, and losing them prevents failover
    // classification and user diagnosis.
    const parts: string[] = [];

    const message = error.message?.trim();
    if (message) {
      parts.push(message);
    }

    const anyErr = error as unknown as {
      status?: unknown;
      code?: unknown;
      error?: unknown;
      body?: unknown;
      response?: { data?: unknown; body?: unknown };
      cause?: unknown;
    };
    const status = typeof anyErr.status === "number" ? anyErr.status : undefined;
    const code = typeof anyErr.code === "string" ? anyErr.code : undefined;

    if (status !== undefined) {
      parts.push(`status=${status}`);
    }
    if (code) {
      parts.push(`code=${code}`);
    }

    const upstream =
      anyErr?.error ??
      anyErr?.body ??
      anyErr?.response?.data ??
      anyErr?.response?.body ??
      anyErr?.cause;

    if (upstream) {
      try {
        const serialized = typeof upstream === "string" ? upstream : JSON.stringify(upstream);
        if (serialized && serialized !== "{}") {
          parts.push(serialized);
        }
      } catch {
        // ignore
      }
    }

    return parts.join(" | ") || "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export type { ReasoningLevel, ThinkLevel };
