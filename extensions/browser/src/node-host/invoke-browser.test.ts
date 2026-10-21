import fs from "node:fs/promises";
import nodePath from "node:path";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROXY_ERROR_ENVELOPE,
  BROWSER_PROXY_MAX_FILE_BYTES,
  BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
} from "../browser-proxy-envelope.js";
import type { BrowserServerState } from "../browser/server-context.js";
import { firstBrowserDispatchRequest, stagedReportUpload } from "./invoke-browser.test-support.js";

const BROWSER_PROXY_MAX_FILES = 256;
const BROWSER_PROXY_MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const okResponse = { status: 200, body: { ok: true } };
const okPayload = JSON.stringify({ result: { ok: true } });

function uploadParams(timeoutMs?: number) {
  return {
    body: {},
    upload: {
      envelope: "browser-upload-v1",
      files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
    },
    timeoutMs,
  };
}

function uploadRequest(timeoutMs?: number) {
  return invoke("/hooks/file-chooser", uploadParams(timeoutMs), "browser.proxy.upload.v1");
}

const control = vi.hoisted(() => ({
  hasBrowserControlWork: vi.fn(() => false),
  createBrowserControlContext: vi.fn(() => ({ control: true })),
  getBrowserControlState: vi.fn<() => BrowserServerState | null>(() => null),
  startBrowserControlServiceFromConfig: vi.fn<() => Promise<BrowserServerState | null>>(),
}));

const cdp = vi.hoisted(() => ({
  closeTrackedCdpTarget: vi.fn(async () => ({ status: "closed" as const })),
  redactCdpUrl: vi.fn<(url: string) => string>(),
}));

const routes = vi.hoisted(() => ({
  dispatch: vi.fn(),
  createBrowserRouteDispatcher: vi.fn(() => ({ dispatch: routes.dispatch })),
}));

const config = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    browser: {},
    nodeHost: { browserProxy: { enabled: true, allowProfiles: [] as string[] } },
  })),
}));

const browserConfig = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    defaultProfile: "openclaw",
    profiles: {
      openclaw: { name: "openclaw", driver: "openclaw" as const, cdpUrl: "http://127.0.0.1:9222" },
      user: { name: "user", driver: "existing-session" as const, cdpUrl: "http://127.0.0.1:9333" },
    },
    remoteCdpTimeoutMs: 20_000,
    ssrfPolicy: undefined,
  })),
  resolveProfile: vi.fn(
    (resolved: { profiles?: Record<string, unknown> }, name: string) =>
      resolved.profiles?.[name] ?? null,
  ),
}));

const uploads = vi.hoisted(() => ({
  hasBrowserProxyUploadWork: vi.fn(() => false),
  stageBrowserProxyUploadRequest: vi.fn(),
  discardStagedBrowserProxyUpload: vi.fn(async () => {}),
  ensureBrowserProxyUploadCleanup: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: config.loadConfig,
  getRuntimeConfigSourceSnapshot: () => null,
  loadConfig: config.loadConfig,
}));

vi.mock("openclaw/plugin-sdk/media-mime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-mime")>()),
  detectMime: vi.fn(async () => "image/png"),
}));

// mock-isolation: keep native tab closure and CDP I/O inside the owned fixture.
vi.mock("../browser/cdp.helpers.js", () => ({
  closeTrackedCdpTarget: cdp.closeTrackedCdpTarget,
  redactCdpUrl: cdp.redactCdpUrl,
}));

vi.mock("../browser/cdp-reachability-policy.js", () => ({
  resolveCdpControlPolicy: vi.fn(() => undefined),
}));

// mock-isolation: use fixture profiles without reading operator browser configuration.
vi.mock("../browser/config.js", () => ({
  resolveBrowserConfig: browserConfig.resolveBrowserConfig,
  resolveProfile: browserConfig.resolveProfile,
}));

// mock-isolation: stage synthetic uploads without touching the host upload store.
vi.mock("../browser-proxy-upload.js", () => uploads);

// mock-isolation: capture proxy dispatch without starting browser routes.
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: routes.createBrowserRouteDispatcher,
}));

// mock-isolation: exercise startup ownership without launching the browser service.
vi.mock("../control-service.js", () => ({
  createBrowserControlContext: control.createBrowserControlContext,
  getBrowserControlState: control.getBrowserControlState,
  startBrowserControlServiceFromConfig: control.startBrowserControlServiceFromConfig,
}));

// mock-isolation: keep pending browser work controlled by this startup fixture.
vi.mock("../browser-control-state.js", () => ({
  hasBrowserControlWork: control.hasBrowserControlWork,
}));

let runBrowserProxyCommand: typeof import("./invoke-browser.js").runBrowserProxyCommand;
let browserState: BrowserServerState;

function invoke(path: string, params: Record<string, unknown> = {}, command?: string) {
  return runBrowserProxyCommand(JSON.stringify({ method: "POST", path, ...params }), command);
}

function allowProfiles(...profiles: string[]) {
  config.loadConfig.mockReturnValue({
    browser: {},
    nodeHost: { browserProxy: { enabled: true, allowProfiles: profiles } },
  });
}

function timeoutStatus(body: Record<string, unknown>) {
  routes.dispatch
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce({ status: 200, body });
}

function dispatchResult(body: unknown, status = 200) {
  routes.dispatch.mockResolvedValueOnce({ status, body });
}

async function expectSnapshotTimeout(
  profile: string,
  status: Record<string, unknown>,
  message: RegExp,
) {
  vi.useFakeTimers();
  timeoutStatus(status);
  const result = expect(
    invoke("/snapshot", { method: "GET", profile, timeoutMs: 5 }),
  ).rejects.toThrow(message);
  await vi.advanceTimersByTimeAsync(10);
  await result;
}

describe("runBrowserProxyCommand", () => {
  beforeEach(async () => {
    const { resolveBrowserConfig } =
      await vi.importActual<typeof import("../browser/config.js")>("../browser/config.js");
    browserState = {
      server: null,
      port: 18_791,
      resolved: resolveBrowserConfig(undefined),
      profiles: new Map(),
    };
    vi.useRealTimers();
    vi.resetAllMocks();
    control.startBrowserControlServiceFromConfig.mockResolvedValue(browserState);
    allowProfiles();
    uploads.stageBrowserProxyUploadRequest.mockImplementation(
      async ({ body }: { body: unknown }) => ({ body }),
    );
    vi.resetModules();
    ({ runBrowserProxyCommand } = await import("./invoke-browser.js"));
  });

  it("retries a disabled browser startup", async () => {
    control.startBrowserControlServiceFromConfig.mockResolvedValueOnce(null);
    routes.dispatch.mockResolvedValue(okResponse);
    const request = JSON.stringify({ method: "GET", path: "/snapshot" });

    await expect(runBrowserProxyCommand(request)).rejects.toThrow("browser control disabled");
    await expect(runBrowserProxyCommand(request)).resolves.toBe(okPayload);

    expect(control.startBrowserControlServiceFromConfig).toHaveBeenCalledTimes(2);
    expect(routes.dispatch).toHaveBeenCalledOnce();
  });

  it("closes a rotated node handle through durable native ownership", async () => {
    const ownership = {
      status: "durable",
      nativeTargetId: "NATIVE-7",
      profileFingerprint: "sha256:profile",
      browserInstanceFingerprint: "sha256:browser",
    } as const;

    const payload = JSON.parse(
      await invoke(BROWSER_PROXY_OWNED_TAB_CLOSE_PATH, {
        profile: "user",
        body: { ownership },
        errorEnvelope: BROWSER_PROXY_ERROR_ENVELOPE,
      }),
    );

    expect(payload).toMatchObject({
      result: { status: "closed" },
      route: { status: "resolved", profile: "user", driver: "existing-session" },
    });
    expect(cdp.closeTrackedCdpTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "user",
        cdpUrl: "http://127.0.0.1:9333",
        nativeTargetId: "NATIVE-7",
        expectedProfileFingerprint: "sha256:profile",
        expectedBrowserInstanceFingerprint: "sha256:browser",
      }),
    );
    expect(routes.dispatch).not.toHaveBeenCalled();
    expect(uploads.stageBrowserProxyUploadRequest).not.toHaveBeenCalled();
  });

  it("stages upload envelopes before dispatch and retains successful copies", async () => {
    const upload = {
      envelope: "browser-upload-v1",
      files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
    };
    const staged = {
      body: { ref: "e12", paths: ["/tmp/openclaw/uploads/.proxy-upload-1/0/report.txt"] },
      directory: "/tmp/openclaw/uploads/.proxy-upload-1",
    };
    uploads.stageBrowserProxyUploadRequest.mockResolvedValueOnce(staged);
    routes.dispatch.mockResolvedValueOnce({ status: 200, body: { ok: true } });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/hooks/file-chooser",
          body: { ref: "e12" },
          upload,
        }),
        "browser.proxy.upload.v1",
      ),
    ).resolves.toBe(JSON.stringify({ result: { ok: true } }));

    expect(uploads.stageBrowserProxyUploadRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/hooks/file-chooser",
      body: { ref: "e12" },
      upload,
      signal: expect.any(AbortSignal),
    });
    expect(firstBrowserDispatchRequest(routes.dispatch.mock.calls).body).toEqual(staged.body);
    expect(uploads.discardStagedBrowserProxyUpload).not.toHaveBeenCalled();
  });

  it("discards staged copies when the route rejects the upload", async () => {
    const staged = stagedReportUpload;
    uploads.stageBrowserProxyUploadRequest.mockResolvedValueOnce(staged);
    dispatchResult({ error: "upload rejected" }, 400);

    await expect(uploadRequest()).rejects.toThrow("400: upload rejected");

    expect(uploads.discardStagedBrowserProxyUpload).toHaveBeenCalledWith(staged);
  });

  it("retains staged copies when dispatch fails after Browser ownership is uncertain", async () => {
    const staged = stagedReportUpload;
    uploads.stageBrowserProxyUploadRequest.mockResolvedValueOnce(staged);
    routes.dispatch.mockRejectedValueOnce(new Error("dispatch failed"));

    await expect(uploadRequest()).rejects.toThrow("dispatch failed");

    expect(uploads.discardStagedBrowserProxyUpload).not.toHaveBeenCalled();
  });

  it("retains staged copies when the timeout wins before dispatch settles", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const staged = stagedReportUpload;
    uploads.stageBrowserProxyUploadRequest.mockResolvedValueOnce(staged);
    timeoutStatus({ running: true, cdpReady: true, cdpHttp: true });

    await expect(uploadRequest(5))
      .rejects.toThrow("browser proxy timed out")
      .finally(() => now.mockRestore());

    expect(uploads.discardStagedBrowserProxyUpload).not.toHaveBeenCalled();
  });

  it("rejects upload envelopes sent through the legacy proxy command", async () => {
    await expect(invoke("/hooks/file-chooser", uploadParams())).rejects.toThrow(
      "browser.proxy does not accept upload envelopes",
    );
    expect(uploads.stageBrowserProxyUploadRequest).not.toHaveBeenCalled();
    expect(routes.dispatch).not.toHaveBeenCalled();
  });

  it("rejects a missing envelope sent through the upload proxy command", async () => {
    await expect(invoke("/snapshot", { method: "GET" }, "browser.proxy.upload.v1")).rejects.toThrow(
      "browser.proxy.upload.v1 requires an upload envelope",
    );
    expect(uploads.stageBrowserProxyUploadRequest).not.toHaveBeenCalled();
    expect(routes.dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch after upload staging exhausts the proxy deadline", async () => {
    const staged = stagedReportUpload;
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    uploads.stageBrowserProxyUploadRequest.mockImplementationOnce(async () => {
      nowMs += 10;
      return staged;
    });

    try {
      await expect(uploadRequest(5)).rejects.toThrow("browser proxy timed out");
    } finally {
      nowSpy.mockRestore();
    }

    expect(routes.dispatch).not.toHaveBeenCalled();
    expect(uploads.discardStagedBrowserProxyUpload).toHaveBeenCalledWith(staged);
  });

  it("aborts upload staging when it reaches the proxy deadline", async () => {
    uploads.stageBrowserProxyUploadRequest.mockImplementationOnce(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const reason = signal.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason)));
            },
            { once: true },
          );
        }),
    );

    await expect(uploadRequest(5)).rejects.toThrow("browser proxy timed out");

    expect(routes.dispatch).not.toHaveBeenCalled();
  });

  it("serializes plural action downloads without reading nested page paths", async () => {
    await withTempDir("openclaw-browser-proxy-action-", async (tempDir) => {
      const firstPath = nodePath.join(tempDir, "first.txt");
      const secondPath = nodePath.join(tempDir, "second.txt");
      const nestedPagePath = nodePath.join(tempDir, "page-controlled.txt");
      const result = {
        ok: true,
        downloads: [
          { path: firstPath, suggestedFilename: "first.txt" },
          null,
          { path: 42 },
          { path: secondPath, suggestedFilename: "second.txt" },
          { path: firstPath, suggestedFilename: "first-copy.txt" },
        ],
        result: { path: nestedPagePath, downloads: [{ path: nestedPagePath }] },
      };

      await Promise.all([
        fs.writeFile(firstPath, "first browser download", "utf8"),
        fs.writeFile(secondPath, "second browser download", "utf8"),
        fs.writeFile(nestedPagePath, "must stay on the node", "utf8"),
      ]);
      dispatchResult(result);

      expect(JSON.parse(await invoke("/act"))).toEqual({
        result,
        files: [
          {
            path: firstPath,
            base64: Buffer.from("first browser download").toString("base64"),
            mimeType: "image/png",
          },
          {
            path: secondPath,
            base64: Buffer.from("second browser download").toString("base64"),
            mimeType: "image/png",
          },
        ],
      });
    });
  });

  it("rejects an aggregate above the proxy transport budget", async () => {
    await withTempDir("openclaw-browser-proxy-limit-", async (tempDir) => {
      const firstPath = nodePath.join(tempDir, "first.bin");
      const secondPath = nodePath.join(tempDir, "second.bin");
      await Promise.all([fs.writeFile(firstPath, ""), fs.writeFile(secondPath, "")]);
      await Promise.all([
        fs.truncate(firstPath, BROWSER_PROXY_MAX_FILE_BYTES),
        fs.truncate(
          secondPath,
          BROWSER_PROXY_MAX_TOTAL_FILE_BYTES - BROWSER_PROXY_MAX_FILE_BYTES + 1,
        ),
      ]);
      dispatchResult({ downloads: [{ path: firstPath }, { path: secondPath }] });

      const error = await invoke("/act").catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `browser proxy file read failed for ${secondPath}: Error: browser proxy files exceed 16 MiB aggregate limit`,
      );
    });
  });

  it("rejects too many unique files before reading them", async () => {
    dispatchResult({
      downloads: Array.from({ length: BROWSER_PROXY_MAX_FILES + 1 }, (_, index) => ({
        path: `/missing/browser-download-${index}.bin`,
      })),
    });

    await expect(invoke("/act")).rejects.toThrow("browser proxy response exceeds 256 file limit");
  });

  it("rejects a result whose encoded node frame would exceed the transport limit", async () => {
    dispatchResult({ result: "\\".repeat(7 * 1024 * 1024) });

    await expect(invoke("/act")).rejects.toThrow(
      "browser proxy payload exceeds 24 MiB encoded limit",
    );
  });

  it("includes chrome-mcp transport in timeout diagnostics when no CDP URL exists", async () => {
    await expectSnapshotTimeout(
      "user",
      { running: true, transport: "chrome-mcp", cdpHttp: true, cdpReady: false, cdpUrl: null },
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=user; status\(running=true, cdpHttp=true, cdpReady=false, transport=chrome-mcp\)/,
    );
  });

  it("redacts sensitive cdpUrl details in timeout diagnostics", async () => {
    const cdpUrl =
      "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890";
    cdp.redactCdpUrl.mockReturnValue("https://example.com/chrome?token=supers…7890");
    await expectSnapshotTimeout(
      "remote",
      {
        running: true,
        cdpHttp: true,
        cdpReady: false,
        cdpUrl,
      },
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=remote; status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=https:\/\/example\.com\/chrome\?token=supers…7890\)/,
    );
    expect(cdp.redactCdpUrl).toHaveBeenCalledWith(cdpUrl);
  });

  it("preserves legacy node errors without envelope opt-in", async () => {
    dispatchResult({ error: "" }, 503);
    await expect(invoke("/act", { profile: "openclaw", timeoutMs: 50 })).rejects.toThrow(
      "HTTP 503",
    );
  });

  it("preserves only validated browser error metadata in the proxy envelope", async () => {
    const body = {
      error: "headed mode needs a display",
      reason: "no_display_for_headed_profile",
      details: {
        profile: "openclaw",
        requestedHeadless: false,
        headlessSource: "config",
        displayPresent: false,
      },
    };
    routes.dispatch.mockResolvedValue({
      status: 409,
      body: {
        ...body,
        details: { ...body.details, remediation: "untrusted" },
        untrusted: "drop me",
      },
    });

    const result = JSON.parse(
      await invoke("/start", {
        profile: "openclaw",
        errorEnvelope: "browser-v1",
      }),
    );

    expect(result).toEqual({
      error: { status: 409, body },
      route: { status: "resolved", profile: "openclaw", driver: "openclaw" },
    });
  });

  it("rejects unauthorized query.profile when allowProfiles is configured", async () => {
    allowProfiles("openclaw");

    await expect(
      invoke("/snapshot", { method: "GET", query: { profile: "user" }, timeoutMs: 50 }),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(routes.dispatch).not.toHaveBeenCalled();
  });

  it("rejects host-local system profile listing on a browser node", async () => {
    await expect(invoke("/system-profiles", { method: "GET", timeoutMs: 50 })).rejects.toThrow(
      "INVALID_REQUEST: browser.proxy cannot run host-local browser routes",
    );
    expect(routes.dispatch).not.toHaveBeenCalled();
  });

  it("canonicalizes an allowlisted body profile into the dispatched query", async () => {
    allowProfiles("openclaw");
    routes.dispatch.mockResolvedValue(okResponse);

    await invoke("/stop", { body: { profile: "openclaw" }, timeoutMs: 50 });

    const request = firstBrowserDispatchRequest(routes.dispatch.mock.calls);
    expect(request.path).toBe("/stop");
    expect(request.query).toEqual({ profile: "openclaw" });
  });

  it("rejects persistent profile creation when allowProfiles is empty", async () => {
    await expect(
      invoke("/profiles/create", {
        body: { name: "poc", cdpUrl: "http://127.0.0.1:9222" },
        timeoutMs: 50,
      }),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(routes.dispatch).not.toHaveBeenCalled();
  });
});
