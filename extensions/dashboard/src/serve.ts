// Static-file serving for approved custom widgets, under the `auth:"plugin"`
// (unauthenticated) HTTP route. This route is safe ONLY because it is static-file
// only: no query-selected state, no data, GET only. Every rejection returns 404
// (never 403) so the route never leaks whether a widget or file exists.
//
// The path jail copies the canvas idiom verbatim (`extensions/canvas/src/
// documents.ts:79,107,180-184`): charset-checked name, logical-path normalization,
// then a resolve-based containment check against the widget's own directory.

import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { CUSTOM_WIDGET_NAME_PATTERN, resolveWidgetDir } from "./manifest.js";
import type { DashboardStore } from "./store.js";

export const WIDGETS_ROUTE_PREFIX = "/plugins/dashboard/widgets";

// Spec §Server side: strict CSP on every widget response. `connect-src 'none'` is
// the structural backstop that makes "no network" a property of the frame, not a
// convention. `frame-ancestors 'self'` keeps the frame embeddable only by the
// Control UI.
export const WIDGET_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'";

// Content-Type allowlist keyed by lowercase extension (spec §Server side). Any
// extension not in this map is not served (→ 404), so no widget can ship, e.g., an
// `.mjs`/`.wasm`/`.map` or an extensionless file.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

export type WidgetServeDeps = {
  store: DashboardStore;
  stateDir?: string;
};

export type WidgetServeRequest = {
  method: string | undefined;
  /** URL pathname (no query/hash), already URL-decoded per segment by the caller. */
  pathname: string;
};

/** Copy of the canvas logical-path normalizer (documents.ts:79). */
function normalizeLogicalPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some(
      (part) => part === "." || part === ".." || part.includes(":") || hasControlCharacter(part),
    )
  ) {
    throw new Error("widget logical path invalid");
  }
  return parts.join("/");
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** True when the pathname is under this route's prefix (so the route owns it). */
export function isWidgetRoutePath(pathname: string): boolean {
  return pathname === WIDGETS_ROUTE_PREFIX || pathname.startsWith(`${WIDGETS_ROUTE_PREFIX}/`);
}

/**
 * Splits a request pathname under the widgets prefix into `{ name, logicalPath }`.
 * Returns null when the pathname is not under the prefix or is malformed. Each
 * segment is URL-decoded; a decode failure yields null (→ 404).
 */
export function parseWidgetRequestPath(
  pathname: string,
): { name: string; logicalPath: string } | null {
  const prefix = `${WIDGETS_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  const rawSegments = rest.split("/");
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (!segment) {
      // A trailing/duplicated slash collapses; an empty leading segment is dropped.
      continue;
    }
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  if (segments.length < 2) {
    return null;
  }
  const [name, ...entry] = segments;
  // The charset pattern permits dots, so `.`/`..` slip through it — reject the
  // traversal names explicitly (mirrors normalizeCanvasDocumentId, documents.ts:107).
  if (name === "." || name === ".." || !CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
    return null;
  }
  let logicalPath: string;
  try {
    logicalPath = normalizeLogicalPath(entry.join("/"));
  } catch {
    return null;
  }
  return { name, logicalPath };
}

function extensionContentType(logicalPath: string): string | null {
  const extension = path.extname(logicalPath).toLowerCase();
  return CONTENT_TYPES[extension] ?? null;
}

/**
 * The strict security headers EVERY widget-route response must carry — 200 and
 * 404 alike. A 404 is still an attacker-influenced response served from the
 * widget origin, so it needs the same `connect-src 'none'` lockdown. Shared here
 * so the two response paths can never drift apart again. Content-Type is set
 * per-path (it differs) and is intentionally not included.
 */
function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", WIDGET_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function notFound(res: ServerResponse): true {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  setSecurityHeaders(res);
  res.end("not found");
  return true;
}

/**
 * Resolves and serves a static asset for an approved custom widget, writing the
 * response directly. Returns true when the request was under this route (handled),
 * false when the pathname is not a widget path (caller may fall through).
 *
 * Every failure mode (wrong method, unknown/pending/rejected widget, jail
 * violation, disallowed extension, missing file) is a 404 — never 403 — so the
 * unauthenticated route reveals nothing about what exists on disk.
 */
export async function serveWidgetAsset(
  req: WidgetServeRequest,
  res: ServerResponse,
  deps: WidgetServeDeps,
): Promise<boolean> {
  // A pathname NOT under this route falls through (returns false); a pathname
  // under the route but malformed (traversal, bad charset, encoded escape) is
  // OWNED by this route and answered with 404 — never fall-through, never 403.
  if (!isWidgetRoutePath(req.pathname)) {
    return false;
  }
  const parsed = parseWidgetRequestPath(req.pathname);
  if (!parsed) {
    return notFound(res);
  }
  // Non-GET is not merely rejected — it is indistinguishable from a miss (404).
  if (req.method !== "GET" && req.method !== "HEAD") {
    return notFound(res);
  }

  const contentType = extensionContentType(parsed.logicalPath);
  if (!contentType) {
    return notFound(res);
  }

  // Serving gate: only `status === "approved"` widgets are served AT ALL. This is
  // belt-and-braces with the UI render gate (the UI never builds an iframe for a
  // pending/rejected widget, and the server refuses its assets regardless).
  try {
    const doc = await deps.store.read();
    if (doc.widgetsRegistry[parsed.name]?.status !== "approved") {
      return notFound(res);
    }
  } catch {
    return notFound(res);
  }

  const stateDir = deps.stateDir ?? resolveStateDir();
  let widgetDir: string;
  try {
    widgetDir = resolveWidgetDir(parsed.name, stateDir);
  } catch {
    return notFound(res);
  }
  const candidate = path.resolve(widgetDir, parsed.logicalPath);
  // Containment check (canvas documents.ts:180-184): the resolved file must live
  // inside the widget's own directory. This is the last line of defense against a
  // symlink or normalization edge that escapes the jail.
  if (candidate !== widgetDir && !candidate.startsWith(`${widgetDir}${path.sep}`)) {
    return notFound(res);
  }

  let data: Buffer;
  try {
    // realpath resolves symlinks; re-check containment against the widget dir's
    // OWN real path so a symlink INSIDE the widget dir pointing OUT cannot be
    // served. Resolving both sides also makes the check correct on platforms
    // where the state dir itself is a symlink (e.g. macOS /tmp → /private/tmp).
    const realDir = await fs.realpath(widgetDir);
    const real = await fs.realpath(candidate);
    if (real !== realDir && !real.startsWith(`${realDir}${path.sep}`)) {
      return notFound(res);
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) {
      return notFound(res);
    }
    data = await fs.readFile(real);
  } catch {
    return notFound(res);
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  setSecurityHeaders(res);
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(data);
  }
  return true;
}
