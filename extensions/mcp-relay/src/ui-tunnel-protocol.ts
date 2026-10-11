import {
  GatewayControlUiIngressError,
  type GatewayPluginReadCookieV1,
} from "openclaw/plugin-sdk/gateway-ingress";
import { containsAsciiControlCharacter } from "openclaw/plugin-sdk/string-normalization-runtime";
import { MAX_FRAME_BYTES, RelayError } from "./protocol.js";

export const UI_CHUNK_BYTES = 512 * 1024;
export const UI_BUFFER_BYTES = 32 * 1024 * 1024;
export type UiErrorCode =
  | "grant_revoked"
  | "unavailable"
  | "forbidden"
  | "limit_exceeded"
  | "invalid";

export class UiTunnelError extends Error {
  constructor(
    readonly code: UiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function uiError(error: unknown): { code: UiErrorCode; message: string } {
  if (error instanceof UiTunnelError) {
    return error;
  }
  if (error instanceof RelayError && error.code === "grant_revoked") {
    return { code: "grant_revoked", message: error.message };
  }
  if (error instanceof GatewayControlUiIngressError) {
    const code =
      error.code === "invalid-options"
        ? "invalid"
        : error.code === "limit-exceeded"
          ? "limit_exceeded"
          : error.code === "forbidden"
            ? "forbidden"
            : "unavailable";
    return { code, message: error.message };
  }
  return {
    code: "unavailable",
    message: "The Control UI connection failed. Open OpenClaw from ChatGPT again.",
  };
}

export function invalid(message = "Invalid Control UI tunnel frame."): never {
  throw new UiTunnelError("invalid", message);
}

export function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") {
    return invalid("Supply an exact HTTPS origin.");
  }
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return invalid("Supply an exact HTTPS origin.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== value ||
    origin.username ||
    origin.password
  ) {
    return invalid("Supply an exact HTTPS origin.");
  }
  return value;
}

export function localPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n#]/.test(value)
  ) {
    return invalid("Supply an absolute local path and query.");
  }
  return value;
}

export function chunkBytes(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(UI_CHUNK_BYTES / 3) * 4) {
    return invalid("Supply a base64 chunk of at most 512 KiB.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > UI_CHUNK_BYTES || bytes.toString("base64") !== value) {
    return invalid("Supply a canonical base64 chunk of at most 512 KiB.");
  }
  return bytes;
}

export function moreFlag(value: unknown): boolean {
  if (typeof value !== "boolean") {
    return invalid("Supply the chunk's more flag.");
  }
  return value;
}

const HOP = new Set([
  "connection",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "proxy-authenticate",
  "proxy-authorization",
]);

export function tunnelHeaders(
  rawHeaders: unknown,
  direction: "request" | "response",
): [string, string][] {
  if (!Array.isArray(rawHeaders)) {
    return invalid("Supply a list of header pairs.");
  }
  const headers: [string, string][] = [];
  const nominated = new Set<string>();
  for (const pair of rawHeaders) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair[0]) ||
      /[\r\n\0]/.test(pair[1])
    ) {
      return invalid("Supply valid HTTP header pairs.");
    }
    const name = pair[0].toLowerCase();
    if (name === "connection") {
      for (const token of pair[1].split(",")) {
        nominated.add(token.trim().toLowerCase());
      }
    }
    headers.push([name, pair[1]]);
  }
  const filtered: [string, string][] = [];
  for (const [name, value] of headers) {
    if (HOP.has(name) || nominated.has(name) || name === "content-length") {
      continue;
    }
    if (direction === "request") {
      if (
        ["host", "forwarded", "x-real-ip", "true-client-ip", "cdn-loop"].includes(name) ||
        /^(proxy-|x-forwarded-|cf-|x-relay-)/.test(name)
      ) {
        continue;
      }
      if (name === "cookie") {
        const cookies = value
          .split(";")
          .map((cookie) => cookie.trim())
          .filter((cookie) => cookie.split("=", 1)[0]?.trim() !== "__Host-oc_ui")
          .join("; ");
        if (cookies) {
          filtered.push([name, cookies]);
        }
        continue;
      }
    } else if (
      [
        "set-cookie",
        "service-worker-allowed",
        "clear-site-data",
        "referrer-policy",
        "origin-agent-cluster",
      ].includes(name)
    ) {
      continue;
    }
    filtered.push([name, value]);
  }
  if (direction === "response") {
    // Compressed bodies and the Gateway's cache policy pass through; the relay keeps
    // every tunneled response out of shared caches (private) and owns that policy.
    filtered.push(["referrer-policy", "no-referrer"], ["origin-agent-cluster", "?1"]);
  }
  return filtered;
}

export function tunnelCookies(cookies: readonly GatewayPluginReadCookieV1[]) {
  return cookies.map(({ name, value, path, maxAgeSeconds }) => {
    if (
      name === "__Host-oc_ui" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value) ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[;\\ ]/.test(path) ||
      containsAsciiControlCharacter(path) ||
      !Number.isSafeInteger(maxAgeSeconds) ||
      maxAgeSeconds < 0
    ) {
      throw new UiTunnelError("invalid", "The Gateway returned an invalid Control UI read cookie.");
    }
    return { name, value, path, maxAgeSeconds };
  });
}

export function* textFrames(
  sid: string,
  text: string,
): Generator<{ type: string; sid: string; text: string; more: boolean }> {
  if (/[\uD800-\uDFFF]/u.test(text)) {
    invalid("WebSocket text must contain complete Unicode characters.");
  }
  let offset = 0;
  do {
    let end = Math.min(text.length, offset + UI_CHUNK_BYTES);
    const fit = () => {
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) {
        end--;
      }
      return { type: "ui.ws.msg", sid, text: text.slice(offset, end), more: end < text.length };
    };
    let frame = fit();
    while (
      Buffer.byteLength(frame.text) > UI_CHUNK_BYTES ||
      Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES
    ) {
      end = offset + Math.floor((end - offset) / 2);
      frame = fit();
    }
    yield frame;
    offset = end;
  } while (offset < text.length);
}

export function closeInfo(frame: Record<string, unknown>): { code: number; reason: string } {
  const { code, reason } = frame;
  if (
    typeof code !== "number" ||
    !Number.isInteger(code) ||
    !(
      (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999)
    ) ||
    typeof reason !== "string" ||
    /[\uD800-\uDFFF]/u.test(reason) ||
    Buffer.byteLength(reason) > 123
  ) {
    return invalid("Supply a valid WebSocket close code and reason.");
  }
  return { code, reason };
}
