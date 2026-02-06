import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChannelMediaMaxBytes, type OpenClawConfig } from "openclaw/plugin-sdk";
import type { ZulipApiSuccess, ZulipAuth } from "./client.js";
import { getZulipRuntime } from "../runtime.js";
import { normalizeZulipBaseUrl } from "./normalize.js";

const HTTP_URL_RE = /^https?:\/\//i;
const USER_UPLOAD_MARKER = "/user_uploads/";
const MB = 1024 * 1024;
const DEFAULT_MAX_BYTES = 5 * MB;

function resolveLocalMediaPath(source: string): string {
  if (!source.startsWith("file://")) {
    return source;
  }
  try {
    return fileURLToPath(source);
  } catch {
    throw new Error(`Invalid file:// URL: ${source}`);
  }
}

function cleanCandidateUrl(raw: string): string {
  // Zulip content may include HTML entities when apply_markdown=true.
  let cleaned = raw.replace(/&amp;/g, "&").trim();
  // Trim common Markdown/HTML delimiters.
  cleaned = cleaned.replace(/^[<("'[]+/, "");
  cleaned = cleaned.replace(/[>")'\],.!?;:]+$/, "");
  return cleaned;
}

function resolveUploadUrl(raw: string, baseUrl: string): string | null {
  const base = normalizeZulipBaseUrl(baseUrl);
  if (!base) {
    return null;
  }
  const cleaned = cleanCandidateUrl(raw);
  if (!cleaned.includes(USER_UPLOAD_MARKER)) {
    return null;
  }
  try {
    const url = cleaned.startsWith("/")
      ? new URL(cleaned, base)
      : HTTP_URL_RE.test(cleaned)
        ? new URL(cleaned)
        : null;
    if (!url) {
      return null;
    }
    // Only allow uploads hosted on the same origin as the configured Zulip server.
    const baseOrigin = new URL(base).origin;
    if (url.origin !== baseOrigin) {
      return null;
    }
    if (!url.pathname.includes(USER_UPLOAD_MARKER)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function extractZulipUploadUrls(content: string, baseUrl: string): string[] {
  const text = content ?? "";
  if (!text.includes(USER_UPLOAD_MARKER)) {
    return [];
  }

  // Match either absolute URLs or /user_uploads/... paths. Keep it permissive and clean after.
  const re =
    /https?:\/\/[^\s<>"')\]]+\/user_uploads\/[^\s<>"')\]]+|\/user_uploads\/[^\s<>"')\]]+/gi;
  const matches = text.match(re) ?? [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const resolved = resolveUploadUrl(match, baseUrl);
    if (!resolved) {
      continue;
    }
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function buildZulipAuthFetch(params: {
  auth: ZulipAuth;
  includeAuthForOrigin?: string;
}): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const token = Buffer.from(`${params.auth.email}:${params.auth.apiKey}`, "utf8").toString(
    "base64",
  );
  const includeAuthForOrigin = params.includeAuthForOrigin;
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    if (includeAuthForOrigin) {
      try {
        if (new URL(url).origin === includeAuthForOrigin) {
          headers.set("Authorization", `Basic ${token}`);
        } else {
          headers.delete("Authorization");
        }
      } catch {
        headers.delete("Authorization");
      }
    } else {
      headers.set("Authorization", `Basic ${token}`);
    }
    return await fetch(input, { ...init, headers });
  };
}

function resolveFilenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    return base || undefined;
  } catch {
    return undefined;
  }
}

export type ZulipInboundUpload = {
  url: string;
  path: string;
  contentType?: string;
  placeholder: string;
};

export async function downloadZulipUploads(params: {
  cfg: OpenClawConfig;
  accountId: string;
  auth: ZulipAuth;
  content: string;
  abortSignal?: AbortSignal;
  maxFiles?: number;
}): Promise<ZulipInboundUpload[]> {
  const core = getZulipRuntime();

  const maxBytes =
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.zulip?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.zulip?.mediaMaxMb,
      accountId: params.accountId,
    }) ?? DEFAULT_MAX_BYTES;

  const urls = extractZulipUploadUrls(params.content, params.auth.baseUrl);
  if (urls.length === 0) {
    return [];
  }
  const maxFiles = Math.max(0, Math.floor(params.maxFiles ?? 3));
  const limited = maxFiles > 0 ? urls.slice(0, maxFiles) : urls;

  const base = normalizeZulipBaseUrl(params.auth.baseUrl);
  const baseOrigin = base ? new URL(base).origin : undefined;
  const fetchImpl = buildZulipAuthFetch({ auth: params.auth, includeAuthForOrigin: baseOrigin });

  const out: ZulipInboundUpload[] = [];
  for (const url of limited) {
    try {
      const fetched = await core.channel.media.fetchRemoteMedia({
        url,
        fetchImpl,
        maxBytes,
      });
      const saved = await core.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
        fetched.fileName ?? resolveFilenameFromUrl(url),
      );
      const label = fetched.fileName ?? resolveFilenameFromUrl(url);
      out.push({
        url,
        path: saved.path,
        contentType: saved.contentType ?? fetched.contentType,
        placeholder: label ? `[Zulip upload: ${label}]` : "[Zulip upload]",
      });
    } catch {
      // Ignore download errors (auth, size, redirects, etc). The original URL is still present in text.
    }
  }
  return out;
}

type ZulipUploadResponse = ZulipApiSuccess & {
  uri?: string;
};

export async function uploadZulipFile(params: {
  auth: ZulipAuth;
  buffer: Uint8Array;
  filename: string;
  contentType?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const base = normalizeZulipBaseUrl(params.auth.baseUrl);
  if (!base) {
    throw new Error("Missing Zulip baseUrl");
  }

  const url = new URL(`${base}/api/v1/user_uploads`);
  const token = Buffer.from(`${params.auth.email}:${params.auth.apiKey}`, "utf8").toString(
    "base64",
  );

  const form = new FormData();
  const blob = new Blob([params.buffer], {
    type: params.contentType?.trim() || "application/octet-stream",
  });
  form.append("file", blob, params.filename);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${token}`,
    },
    body: form,
    signal: params.abortSignal,
  });
  const text = await res.text();
  let json: ZulipUploadResponse | null = null;
  try {
    json = text ? (JSON.parse(text) as ZulipUploadResponse) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg =
      json && typeof json === "object" && typeof json.msg === "string"
        ? json.msg
        : text?.trim()
          ? text.trim()
          : `HTTP ${res.status}`;
    throw new Error(`Zulip API error (${res.status}): ${msg}`);
  }
  if (!json || json.result !== "success" || !json.uri) {
    throw new Error("Zulip upload failed: missing uri");
  }

  // Zulip returns a relative "/user_uploads/..." path.
  return new URL(json.uri, base).toString();
}

export async function resolveOutboundMedia(params: {
  cfg: OpenClawConfig;
  accountId: string;
  mediaUrl: string;
}): Promise<{ buffer: Uint8Array; contentType?: string; filename?: string }> {
  const core = getZulipRuntime();
  const maxBytes =
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.zulip?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.zulip?.mediaMaxMb,
      accountId: params.accountId,
    }) ?? DEFAULT_MAX_BYTES;

  const source = params.mediaUrl.trim();
  if (!source) {
    throw new Error("Missing mediaUrl");
  }

  if (HTTP_URL_RE.test(source)) {
    const fetched = await core.channel.media.fetchRemoteMedia({ url: source, maxBytes });
    return { buffer: fetched.buffer, contentType: fetched.contentType, filename: fetched.fileName };
  }

  const resolvedPath = resolveLocalMediaPath(source);
  const fs = await import("node:fs/promises");
  const stats = await fs.stat(resolvedPath);
  if (stats.size > maxBytes) {
    const maxLabel = (maxBytes / MB).toFixed(0);
    const sizeLabel = (stats.size / MB).toFixed(2);
    throw new Error(`Media exceeds ${maxLabel}MB limit (got ${sizeLabel}MB)`);
  }
  const buffer = await fs.readFile(resolvedPath);
  const detected = await core.media.detectMime({ buffer, filePath: resolvedPath });
  return {
    buffer: new Uint8Array(buffer),
    contentType: detected ?? undefined,
    filename: path.basename(resolvedPath) || undefined,
  };
}
