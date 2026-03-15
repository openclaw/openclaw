export function extractText(message: unknown): string {
  if (!message) {
    return "";
  }
  if (typeof message === "string") {
    return message;
  }
  if (typeof message === "object") {
    const record = message as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (Array.isArray(record.content)) {
      return record.content
        .map((item) => {
          if (!item || typeof item !== "object") {
            return "";
          }
          const part = item as Record<string, unknown>;
          return typeof part.text === "string" ? part.text : "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

export function inferMessageKind(text: string, role: "user" | "assistant" | "system"): "reply" | "status" | "build" | "command" {
  const normalized = text.toLowerCase();
  if (role === "user") {
    return "reply";
  }
  if (
    normalized.includes("vite v") ||
    normalized.includes("built in") ||
    normalized.includes("gzip size") ||
    normalized.includes("build")
  ) {
    return "build";
  }
  if (
    normalized.includes("pwsh ") ||
    normalized.includes("node .\\node_modules") ||
    normalized.includes("git ") ||
    normalized.includes("checkpoint")
  ) {
    return "command";
  }
  if (
    normalized.includes("connected") ||
    normalized.includes("unauthorized") ||
    normalized.includes("status") ||
    normalized.includes("success") ||
    normalized.includes("失败") ||
    normalized.includes("成功")
  ) {
    return "status";
  }
  return "reply";
}

export function defaultGatewayUrl(): string {
  const pageUrl = new URL(window.location.href);
  const wsProtocol = pageUrl.protocol === "https:" ? "wss:" : "ws:";
  const host = pageUrl.hostname;
  const gatewayPort = "18789";
  return `${wsProtocol}//${host}:${gatewayPort}/gateway`;
}

export const CHAT_COLLAPSE_THRESHOLD = 600;
