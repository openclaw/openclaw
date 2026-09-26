import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedBrowserProfile } from "./browser/config.js";
import { parseBrowserErrorPayload, type BrowserErrorPayload } from "./browser/errors.js";

/** Additive opt-in for structured browser route errors over node.invoke. */
export const BROWSER_PROXY_ERROR_ENVELOPE = "browser-v1" as const;
/** Additive request envelope for Gateway-owned files sent to a browser node. */
export const BROWSER_PROXY_UPLOAD_ENVELOPE = "browser-upload-v1" as const;
/** Private node-host operation; unknown older nodes reject it before closing anything. */
export const BROWSER_PROXY_OWNED_TAB_CLOSE_PATH = "/__openclaw/session-tab/close-owned";

export const BROWSER_PROXY_MAX_FILE_BYTES = 10 * 1024 * 1024;
// 16 MiB expands to about 21.4 MiB in base64, leaving JSON/result headroom
// below the Gateway's 25 MiB WebSocket frame limit.
const BROWSER_PROXY_MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const BROWSER_PROXY_MAX_FILES = 256;

/** Bound filesystem work even when one action emits many tiny downloads. */
export function assertBrowserProxyFileCountWithinLimit(
  fileCount: number,
  direction: "request" | "response" = "response",
): void {
  if (fileCount > BROWSER_PROXY_MAX_FILES) {
    throw new Error(`browser proxy ${direction} exceeds 256 file limit`);
  }
}

/** Enforce the shared per-file and raw aggregate Browser proxy limits. */
export function assertBrowserProxyFileBytesWithinLimits(
  fileBytes: number,
  totalBytes: number,
): void {
  if (fileBytes > BROWSER_PROXY_MAX_FILE_BYTES) {
    throw new Error("browser proxy file exceeds 10 MiB limit");
  }
  if (totalBytes > BROWSER_PROXY_MAX_TOTAL_FILE_BYTES) {
    throw new Error("browser proxy files exceed 16 MiB aggregate limit");
  }
}

export type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

export type BrowserProxyUploadFile = {
  name: string;
  contentBase64: string;
};

export type BrowserProxyUploadV1 = {
  envelope: typeof BROWSER_PROXY_UPLOAD_ENVELOPE;
  files: BrowserProxyUploadFile[];
};

export type BrowserProxyRoute =
  | {
      status: "resolved";
      profile: string;
      driver: ResolvedBrowserProfile["driver"];
    }
  | { status: "unavailable" };

/** Visit the route-owned file paths that may cross the Browser node boundary. */
export function visitBrowserProxyFilePaths(
  result: unknown,
  visit: (filePath: string) => string | void,
): void {
  const root = asNullableRecord(result);
  if (!root) {
    return;
  }
  const visitPath = (owner: Record<string, unknown>, key: "path" | "imagePath") => {
    const filePath = owner[key];
    if (typeof filePath !== "string" || !filePath.trim()) {
      return;
    }
    const replacement = visit(filePath);
    if (typeof replacement === "string") {
      owner[key] = replacement;
    }
  };

  visitPath(root, "path");
  visitPath(root, "imagePath");

  const download = asNullableRecord(root.download);
  if (download) {
    visitPath(download, "path");
  }

  // Stay shallow: evaluate results contain page-controlled objects whose
  // path-like fields must never become node filesystem reads.
  if (Array.isArray(root.downloads)) {
    for (const entry of root.downloads) {
      const record = asNullableRecord(entry);
      if (record) {
        visitPath(record, "path");
      }
    }
  }
}

type BrowserProxySuccess = {
  result: unknown;
  files?: BrowserProxyFile[];
  route?: BrowserProxyRoute;
};

type BrowserProxyFailure = {
  error: {
    status: number;
    body: BrowserErrorPayload;
  };
  route?: BrowserProxyRoute;
};

export type BrowserProxyEnvelope = BrowserProxySuccess | BrowserProxyFailure;

/** Build a route-failure envelope while allowing only closed Browser metadata. */
export function createBrowserProxyFailure(
  status: number,
  body: unknown,
  route?: BrowserProxyRoute,
): BrowserProxyFailure {
  return {
    error: {
      status,
      body: parseBrowserErrorPayload(body) ?? { error: `HTTP ${status}` },
    },
    ...(route ? { route } : {}),
  };
}

export function parseBrowserProxyRoute(value: unknown): BrowserProxyRoute | undefined {
  const route = asNullableRecord(asNullableRecord(value)?.route);
  if (!route) {
    return undefined;
  }
  if (route.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (
    route.status !== "resolved" ||
    typeof route.profile !== "string" ||
    !route.profile ||
    route.profile.trim() !== route.profile ||
    (route.driver !== "openclaw" &&
      route.driver !== "existing-session" &&
      route.driver !== "extension")
  ) {
    return undefined;
  }
  return {
    status: "resolved",
    // This is execution identity, not user input; normalization could name another profile.
    profile: route.profile,
    driver: route.driver,
  };
}

/** Parse an untrusted node response without forwarding arbitrary metadata. */
export function parseBrowserProxyFailure(value: unknown): BrowserProxyFailure | null {
  const candidate = asNullableRecord(asNullableRecord(value)?.error);
  if (!candidate) {
    return null;
  }
  if (
    typeof candidate.status !== "number" ||
    !Number.isInteger(candidate.status) ||
    candidate.status < 400 ||
    candidate.status > 599
  ) {
    return null;
  }
  const body = parseBrowserErrorPayload(candidate.body);
  if (!body) {
    return null;
  }
  const route = parseBrowserProxyRoute(value);
  return {
    error: { status: candidate.status, body },
    ...(route ? { route } : {}),
  };
}
