import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SsrFPolicy } from "../../../src/infra/net/ssrf.js";

export const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveTelegramApiRoot(apiRoot?: string | null): string {
  const trimmed = apiRoot?.trim();
  if (!trimmed) {
    return DEFAULT_TELEGRAM_API_ROOT;
  }
  return trimTrailingSlashes(trimmed);
}

export function buildTelegramBotApiBase(params: {
  token: string;
  apiRoot?: string | null;
}): string {
  return `${resolveTelegramApiRoot(params.apiRoot)}/bot${params.token}`;
}

export function buildTelegramBotApiUrl(params: {
  token: string;
  method: string;
  apiRoot?: string | null;
}): string {
  const method = params.method.replace(/^\/+/, "");
  return `${buildTelegramBotApiBase(params)}/${method}`;
}

export function buildTelegramFileDownloadUrl(params: {
  token: string;
  filePath: string;
  apiRoot?: string | null;
}): string {
  const filePath = params.filePath.replace(/^\/+/, "");
  return `${resolveTelegramApiRoot(params.apiRoot)}/file/bot${params.token}/${filePath}`;
}

export function resolveTelegramApiOriginDetails(apiRoot?: string | null): {
  hostname: string;
  protocol: "http:" | "https:";
  port?: number;
} | null {
  try {
    const parsed = new URL(resolveTelegramApiRoot(apiRoot));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : undefined;
    const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    return {
      hostname,
      protocol: parsed.protocol,
      ...(port ? { port } : {}),
    };
  } catch {
    return null;
  }
}

export function isTelegramApiRootLoopback(apiRoot?: string | null): boolean {
  const details = resolveTelegramApiOriginDetails(apiRoot);
  if (!details) {
    return false;
  }
  return (
    details.hostname === "localhost" ||
    details.hostname === "127.0.0.1" ||
    details.hostname === "::1"
  );
}

export function resolveTelegramMediaSsrFPolicy(apiRoot?: string | null): SsrFPolicy {
  const details = resolveTelegramApiOriginDetails(apiRoot);
  return {
    // Explicit apiRoot hostnames are allowed so local Bot API servers can be used
    // without relaxing SSRF checks globally.
    allowedHostnames: [details?.hostname ?? "api.telegram.org"],
    allowRfc2544BenchmarkRange: true,
  };
}

export function resolveTelegramLocalFilePath(filePath?: string | null): string | null {
  const trimmed = filePath?.trim();
  if (!trimmed) {
    return null;
  }
  if (/^file:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "file:") {
        return null;
      }
      if (parsed.hostname && parsed.hostname !== "localhost") {
        return null;
      }
      return fileURLToPath(parsed);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(trimmed) ? trimmed : null;
}
