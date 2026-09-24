/**
 * Node-host browser.proxy command implementation for delegated Browser control
 * requests.
 */
import fsPromises from "node:fs/promises";
import { toUSVString } from "node:util";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import {
  asNullableRecord,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasBrowserControlWork } from "../browser-control-state.js";
import { BROWSER_PROXY_COMMAND, BROWSER_PROXY_UPLOAD_COMMAND } from "../browser-node-commands.js";
import {
  assertBrowserProxyFileCountWithinLimit,
  assertBrowserProxyFileBytesWithinLimits,
  BROWSER_PROXY_ERROR_ENVELOPE,
  BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
  createBrowserProxyFailure,
  type BrowserProxyEnvelope,
  type BrowserProxyFile,
  type BrowserProxyRoute,
  type BrowserProxyUploadV1,
  visitBrowserProxyFilePaths,
} from "../browser-proxy-envelope.js";
import { resolveBrowserProxyTimeoutMs } from "../browser-proxy-timeouts.js";
import {
  discardStagedBrowserProxyUpload,
  ensureBrowserProxyUploadCleanup,
  hasBrowserProxyUploadWork,
  stageBrowserProxyUploadRequest,
} from "../browser-proxy-upload.js";
import { resolveCdpControlPolicy } from "../browser/cdp-reachability-policy.js";
import { closeTrackedCdpTarget, redactCdpUrl } from "../browser/cdp.helpers.js";
import { loadBrowserConfigForRuntimeRefresh } from "../browser/config-refresh-source.js";
import {
  resolveBrowserConfig,
  resolveProfile,
  type ResolvedBrowserProfile,
} from "../browser/config.js";
import {
  isBrowserHostLocalRoute,
  isPersistentBrowserProfileMutation,
  normalizeBrowserRequestPath,
  resolveRequestedBrowserProfile,
} from "../browser/request-policy.js";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
} from "../control-service.js";
import { describeBrowserControlUnavailable } from "../plugin-enabled.js";
import { withTimeout } from "../sdk-node-runtime.js";

type BrowserProxyParams = {
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
  errorEnvelope?: unknown;
  upload?: BrowserProxyUploadV1;
};

function readOwnedTabCloseRequest(value: unknown) {
  const record = asNullableRecord(value);
  const ownership = asNullableRecord(record?.ownership);
  if (
    ownership?.status !== "durable" ||
    typeof ownership.nativeTargetId !== "string" ||
    !ownership.nativeTargetId.trim() ||
    typeof ownership.profileFingerprint !== "string" ||
    !ownership.profileFingerprint.trim() ||
    typeof ownership.browserInstanceFingerprint !== "string" ||
    !ownership.browserInstanceFingerprint.trim()
  ) {
    throw new Error("INVALID_REQUEST: valid durable tab ownership required");
  }
  return {
    ownership: {
      status: "durable" as const,
      nativeTargetId: ownership.nativeTargetId.trim(),
      profileFingerprint: ownership.profileFingerprint.trim(),
      browserInstanceFingerprint: ownership.browserInstanceFingerprint.trim(),
    },
  };
}

const BROWSER_PROXY_STATUS_TIMEOUT_MS = 750;
// Leave one MiB for the fixed node.invoke.result frame around payloadJSON.
const BROWSER_PROXY_MAX_ENCODED_PAYLOAD_BYTES = 24 * 1024 * 1024;

function countBrowserProxyEncodedPayloadBytes(serialized: string): number {
  // Native JSON serialization has already escaped C0 units; raw JSON cannot contain them.
  let bytes = Buffer.byteLength(serialized, "utf8") + 2;
  for (const character of '"\\') {
    const code = character.charCodeAt(0);
    let index = serialized.indexOf(character);
    while (index !== -1) {
      // Skip sparse escapes natively and count dense escapes in bounded runs.
      const end = Math.min(index + 128, serialized.length);
      for (; index < end; index++) {
        if (serialized.charCodeAt(index) === code) {
          bytes++;
        }
      }
      index = serialized.indexOf(character, index);
    }
  }
  const wellFormed = toUSVString(serialized);
  if (wellFormed !== serialized) {
    // Raw JSON may preserve lone surrogates. Replacement keeps UTF-16 positions intact.
    for (
      let index = wellFormed.indexOf("\ufffd");
      index !== -1;
      index = wellFormed.indexOf("\ufffd", index + 1)
    ) {
      if (serialized.charCodeAt(index) !== 0xfffd) {
        bytes += 3;
      }
    }
  }
  return bytes;
}

function normalizeProfileAllowlist(raw?: string[]): string[] {
  return Array.isArray(raw) ? normalizeStringEntries(raw) : [];
}

function resolveBrowserProxyConfig(cfg = loadBrowserConfigForRuntimeRefresh()) {
  const proxy = cfg.nodeHost?.browserProxy;
  if (proxy?.enabled === false) {
    throw new Error("UNAVAILABLE: node browser proxy disabled");
  }
  return { allowProfiles: normalizeProfileAllowlist(proxy?.allowProfiles) };
}

let browserControlReady: Promise<void> | null = null;
let admittedBrowserControlState: ReturnType<typeof getBrowserControlState> = null;

export function hasBrowserNodeHostWork(): boolean {
  return hasBrowserControlWork() || hasBrowserProxyUploadWork();
}

async function ensureBrowserControlService(): Promise<void> {
  const current = getBrowserControlState();
  // Admission survives config refresh only for this exact live runtime generation.
  if (current && current === admittedBrowserControlState) {
    return;
  }
  if (browserControlReady) {
    return browserControlReady;
  }
  const startup = (async () => {
    const cfg = loadBrowserConfigForRuntimeRefresh();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    if (!resolved.enabled) {
      throw new Error(await describeBrowserControlUnavailable(cfg));
    }
    const started = await startBrowserControlServiceFromConfig();
    if (!started) {
      throw new Error(await describeBrowserControlUnavailable(cfg));
    }
    admittedBrowserControlState = started;
  })();
  const sharedStartup = startup.finally(() => {
    // Share pending failures, but never keep settled startup as runtime authority.
    if (browserControlReady === sharedStartup) {
      browserControlReady = null;
    }
  });
  browserControlReady = sharedStartup;
  return sharedStartup;
}

function isProfileAllowed(params: { allowProfiles: string[]; profile?: string | null }) {
  const { allowProfiles, profile } = params;
  if (!allowProfiles.length) {
    return true;
  }
  if (!profile) {
    return false;
  }
  return allowProfiles.includes(profile.trim());
}

function collectBrowserProxyPaths(payload: unknown): string[] {
  const paths = new Set<string>();
  visitBrowserProxyFilePaths(payload, (filePath) => {
    paths.add(filePath.trim());
    assertBrowserProxyFileCountWithinLimit(paths.size);
  });
  return [...paths];
}

async function readBrowserProxyFiles(filePaths: string[]): Promise<BrowserProxyFile[]> {
  const files: BrowserProxyFile[] = [];
  let totalBytes = 0;
  for (const filePath of filePaths) {
    try {
      const stat = await fsPromises.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) {
        throw new Error("file not found");
      }
      assertBrowserProxyFileBytesWithinLimits(stat.size, totalBytes + stat.size);

      const buffer = await fsPromises.readFile(filePath);
      assertBrowserProxyFileBytesWithinLimits(buffer.byteLength, totalBytes + buffer.byteLength);
      totalBytes += buffer.byteLength;
      const mimeType = await detectMime({ buffer, filePath });
      files.push({ path: filePath, base64: buffer.toString("base64"), mimeType });
    } catch (err) {
      throw new Error(`browser proxy file read failed for ${filePath}: ${String(err)}`, {
        cause: err,
      });
    }
  }
  return files;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- CLI JSON params are typed by the invoked method.
function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  return JSON.parse(raw) as T;
}

function isBrowserProxyTimeoutError(err: unknown): boolean {
  return String(err).includes("browser proxy request timed out");
}

function combineBrowserProxySignals(
  timeoutSignal: AbortSignal | undefined,
  invocationSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (timeoutSignal && invocationSignal) {
    return AbortSignal.any([timeoutSignal, invocationSignal]);
  }
  return timeoutSignal ?? invocationSignal;
}

function isWsBackedBrowserProxyPath(path: string): boolean {
  return (
    path === "/act" ||
    path === "/download" ||
    path === "/navigate" ||
    path === "/pdf" ||
    path === "/screenshot" ||
    path === "/snapshot" ||
    path === "/wait/download"
  );
}

async function readBrowserProxyStatus(params: {
  dispatcher: ReturnType<typeof createBrowserRouteDispatcher>;
  profile?: string;
}): Promise<Record<string, unknown> | null> {
  const query = params.profile ? { profile: params.profile } : {};
  try {
    const response = await withTimeout(
      (signal) =>
        params.dispatcher.dispatch({
          method: "GET",
          path: "/",
          query,
          signal,
        }),
      BROWSER_PROXY_STATUS_TIMEOUT_MS,
      "browser proxy status",
    );
    if (response.status >= 400 || !response.body || typeof response.body !== "object") {
      return null;
    }
    const body = response.body as Record<string, unknown>;
    return {
      running: body.running,
      transport: body.transport,
      cdpHttp: body.cdpHttp,
      cdpReady: body.cdpReady,
      cdpUrl: body.cdpUrl,
    };
  } catch {
    return null;
  }
}

function formatBrowserProxyTimeoutMessage(params: {
  method: string;
  path: string;
  profile?: string;
  timeoutMs: number;
  wsBacked: boolean;
  status: Record<string, unknown> | null;
}): string {
  const parts = [
    `browser proxy timed out for ${params.method} ${params.path} after ${params.timeoutMs}ms`,
    params.wsBacked ? "ws-backed browser action" : "browser action",
  ];
  if (params.profile) {
    parts.push(`profile=${params.profile}`);
  }
  if (params.status) {
    const statusParts = [
      `running=${String(params.status.running)}`,
      `cdpHttp=${String(params.status.cdpHttp)}`,
      `cdpReady=${String(params.status.cdpReady)}`,
    ];
    if (typeof params.status.transport === "string" && params.status.transport.trim()) {
      statusParts.push(`transport=${params.status.transport}`);
    }
    if (typeof params.status.cdpUrl === "string" && params.status.cdpUrl.trim()) {
      statusParts.push(`cdpUrl=${redactCdpUrl(params.status.cdpUrl)}`);
    }
    parts.push(`status(${statusParts.join(", ")})`);
  }
  return parts.join("; ");
}

/** Executes a serialized browser.proxy command and returns a serialized result payload. */
export async function runBrowserProxyCommand(
  paramsJSON?: string | null,
  command = BROWSER_PROXY_COMMAND,
  invocationSignal?: AbortSignal,
): Promise<string> {
  invocationSignal?.throwIfAborted();
  void ensureBrowserProxyUploadCleanup();
  const params = decodeParams<BrowserProxyParams>(paramsJSON);
  if (command === BROWSER_PROXY_COMMAND && params.upload !== undefined) {
    throw new Error("INVALID_REQUEST: browser.proxy does not accept upload envelopes");
  }
  if (command === BROWSER_PROXY_UPLOAD_COMMAND && !params.upload) {
    throw new Error("INVALID_REQUEST: browser.proxy.upload.v1 requires an upload envelope");
  }
  if (command !== BROWSER_PROXY_COMMAND && command !== BROWSER_PROXY_UPLOAD_COMMAND) {
    throw new Error(`INVALID_REQUEST: unsupported browser proxy command: ${command}`);
  }
  const pathValue = typeof params.path === "string" ? params.path.trim() : "";
  if (!pathValue) {
    throw new Error("INVALID_REQUEST: path required");
  }
  resolveBrowserProxyConfig();
  const method = typeof params.method === "string" ? params.method.trim().toUpperCase() : "GET";
  const path = normalizeBrowserRequestPath(pathValue);
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    throw new Error("INVALID_REQUEST: method must be GET, POST, or DELETE");
  }
  if (path === BROWSER_PROXY_OWNED_TAB_CLOSE_PATH && method !== "POST") {
    throw new Error("INVALID_REQUEST: owned tab close requires POST");
  }

  await ensureBrowserControlService();
  invocationSignal?.throwIfAborted();
  const cfg = loadBrowserConfigForRuntimeRefresh();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  let body = params.body;
  const requestedProfile =
    resolveRequestedBrowserProfile({
      query: params.query,
      body,
      profile: params.profile,
    }) ?? "";
  const effectiveProfile = path === "/profiles" ? "" : requestedProfile || resolved.defaultProfile;
  const effectiveResolvedProfile = effectiveProfile
    ? resolveProfile(resolved, effectiveProfile)
    : null;
  const route: BrowserProxyRoute = effectiveResolvedProfile
    ? {
        status: "resolved",
        profile: effectiveProfile,
        driver: effectiveResolvedProfile.driver,
      }
    : { status: "unavailable" };
  const includeRoute = params.errorEnvelope === BROWSER_PROXY_ERROR_ENVELOPE;
  const allowedProfiles = resolveBrowserProxyConfig(cfg).allowProfiles;
  if (isPersistentBrowserProfileMutation(method, path)) {
    throw new Error("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
  }
  // System-profile listing and import read the local Keychain/Chrome; they are
  // host-local by contract and must never run on a browser node, which would
  // leak that node's local profile metadata.
  if (isBrowserHostLocalRoute(method, path)) {
    throw new Error("INVALID_REQUEST: browser.proxy cannot run host-local browser routes");
  }
  const assertCurrent = (profile?: ResolvedBrowserProfile) => {
    invocationSignal?.throwIfAborted();
    const current = resolveBrowserProxyConfig();
    const selected = profile?.name || effectiveProfile || requestedProfile;
    if (
      (path !== "/profiles" || selected) &&
      !isProfileAllowed({ allowProfiles: current.allowProfiles, profile: selected })
    ) {
      throw new Error("INVALID_REQUEST: browser profile not allowed");
    }
  };
  assertCurrent();

  const timeoutMs = resolveBrowserProxyTimeoutMs(params.timeoutMs);
  const deadlineAt = Date.now() + timeoutMs;
  const query: Record<string, unknown> = {};
  const rawQuery = params.query ?? {};
  for (const [key, value] of Object.entries(rawQuery)) {
    if (value === undefined || value === null) {
      continue;
    }
    query[key] = typeof value === "string" ? value : String(value);
  }
  // A default-profile change must not redirect work after its route was selected.
  if (effectiveProfile || requestedProfile) {
    query.profile = effectiveProfile || requestedProfile;
  }

  if (path === BROWSER_PROXY_OWNED_TAB_CLOSE_PATH) {
    const request = readOwnedTabCloseRequest(body);
    const liveResolved = getBrowserControlState()?.resolved ?? resolved;
    const profile = resolveProfile(liveResolved, effectiveProfile);
    assertCurrent(profile ?? undefined);
    const result =
      profile?.cdpUrl && effectiveProfile
        ? await closeTrackedCdpTarget({
            profileName: effectiveProfile,
            cdpUrl: profile.cdpUrl,
            nativeTargetId: request.ownership.nativeTargetId,
            expectedProfileFingerprint: request.ownership.profileFingerprint,
            expectedBrowserInstanceFingerprint: request.ownership.browserInstanceFingerprint,
            timeoutMs: liveResolved.remoteCdpTimeoutMs,
            ssrfPolicy: resolveCdpControlPolicy(profile, liveResolved.ssrfPolicy),
            signal: invocationSignal,
            shouldClose: () => {
              assertCurrent(profile);
              return true;
            },
          })
        : { status: "ownership-mismatch" as const };
    return JSON.stringify({
      result,
      ...(includeRoute ? { route } : {}),
    } satisfies BrowserProxyEnvelope);
  }
  const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  let stagedUpload;
  try {
    stagedUpload = await withTimeout(
      (timeoutSignal) =>
        stageBrowserProxyUploadRequest({
          method,
          path,
          body,
          upload: params.upload,
          signal: combineBrowserProxySignals(timeoutSignal, invocationSignal),
        }),
      timeoutMs,
      "browser proxy request",
    );
  } catch (err) {
    if (!isBrowserProxyTimeoutError(err)) {
      throw err;
    }
    throw new Error(
      formatBrowserProxyTimeoutMessage({
        method,
        path,
        profile: requestedProfile || resolved.defaultProfile || undefined,
        timeoutMs,
        wsBacked: isWsBackedBrowserProxyPath(path),
        status: null,
      }),
      { cause: err },
    );
  }
  body = stagedUpload.body;
  try {
    assertCurrent();
  } catch (error) {
    await discardStagedBrowserProxyUpload(stagedUpload);
    throw error;
  }
  const remainingTimeoutMs = deadlineAt - Date.now();
  if (remainingTimeoutMs <= 0) {
    await discardStagedBrowserProxyUpload(stagedUpload);
    throw new Error(
      formatBrowserProxyTimeoutMessage({
        method,
        path,
        profile: requestedProfile || resolved.defaultProfile || undefined,
        timeoutMs,
        wsBacked: isWsBackedBrowserProxyPath(path),
        status: null,
      }),
    );
  }
  let response;
  try {
    response = await withTimeout(
      (timeoutSignal) =>
        dispatcher.dispatch({
          method,
          path,
          query,
          body,
          signal: combineBrowserProxySignals(timeoutSignal, invocationSignal),
          assertCurrent: async (profile) => {
            assertCurrent(profile);
          },
        }),
      remainingTimeoutMs,
      "browser proxy request",
    );
  } catch (err) {
    if (!isBrowserProxyTimeoutError(err)) {
      throw err;
    }
    const profileForStatus = requestedProfile || resolved.defaultProfile;
    const status = await readBrowserProxyStatus({
      dispatcher,
      profile: path === "/profiles" ? undefined : profileForStatus,
    });
    throw new Error(
      formatBrowserProxyTimeoutMessage({
        method,
        path,
        profile: path === "/profiles" ? undefined : profileForStatus || undefined,
        timeoutMs,
        wsBacked: isWsBackedBrowserProxyPath(path),
        status,
      }),
      { cause: err },
    );
  }
  if (response.status >= 400) {
    await discardStagedBrowserProxyUpload(stagedUpload);
    if (params.errorEnvelope === BROWSER_PROXY_ERROR_ENVELOPE) {
      // New callers opt into the closed envelope; older Gateways retain the
      // shipped status-prefixed node error during rolling upgrades.
      return JSON.stringify(createBrowserProxyFailure(response.status, response.body, route));
    }
    const detail =
      response.body && typeof response.body === "object" && "error" in response.body
        ? String((response.body as { error?: unknown }).error).trim()
        : "";
    throw new Error(detail ? `${response.status}: ${detail}` : `HTTP ${response.status}`);
  }

  const result = response.body;
  if (allowedProfiles.length > 0 && path === "/profiles") {
    const obj =
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    const profiles = Array.isArray(obj.profiles) ? obj.profiles : [];
    obj.profiles = profiles.filter((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const name = (entry as Record<string, unknown>).name;
      return typeof name === "string" && allowedProfiles.includes(name);
    });
  }

  const paths = collectBrowserProxyPaths(result);
  const files = paths.length > 0 ? await readBrowserProxyFiles(paths) : undefined;

  const payload: BrowserProxyEnvelope = files
    ? { result, files, ...(includeRoute ? { route } : {}) }
    : { result, ...(includeRoute ? { route } : {}) };
  const serialized = JSON.stringify(payload);
  // Node results carry this JSON as a string inside a second JSON frame.
  if (countBrowserProxyEncodedPayloadBytes(serialized) > BROWSER_PROXY_MAX_ENCODED_PAYLOAD_BYTES) {
    throw new Error("browser proxy payload exceeds 24 MiB encoded limit");
  }
  return serialized;
}
