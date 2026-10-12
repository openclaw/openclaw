// Browser tests cover browser cli manage plugin behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserStatus } from "../browser/client.js";
import {
  createBrowserManageProgram,
  getBrowserManageGatewayMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntime, getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

function mockBrowserResponses(
  responses: Record<string, Record<string, unknown>>,
  fallback?: Record<string, unknown>,
) {
  getBrowserManageGatewayMock().mockImplementation(async (_method, _opts, req) => {
    const response = responses[req.path ?? ""];
    if (response) {
      return response;
    }
    if (fallback) {
      return fallback;
    }
    throw new Error(`unexpected browser route: ${req.path}`);
  });
}

function mockStatus(overrides: Partial<BrowserStatus>) {
  const status: BrowserStatus = {
    enabled: true,
    profile: "chrome-live",
    driver: "existing-session",
    transport: "chrome-mcp",
    running: true,
    cdpReady: true,
    cdpHttp: true,
    pid: 4321,
    cdpPort: null,
    cdpUrl: null,
    chosenBrowser: null,
    userDataDir: null,
    color: "#00AA00",
    headless: false,
    noSandbox: false,
    executablePath: null,
    attachOnly: true,
    ...overrides,
  };
  mockBrowserResponses({ "/": status }, {});
}

function lastRuntimeLog(): string {
  const calls = getBrowserCliRuntime().log.mock.calls;
  const value = calls[calls.length - 1]?.[0];
  if (typeof value !== "string") {
    throw new Error("expected browser CLI runtime log");
  }
  return value;
}

function parseSingleRuntimeJson(): unknown {
  const logs = getBrowserCliRuntimeCapture().runtimeLogs;
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0] ?? "");
}

describe("browser manage output", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    getBrowserManageGatewayMock().mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    getBrowserCliRuntime().exit.mockClear();
    getBrowserCliRuntime().writeJson.mockClear();
  });

  afterEach(() => {
    process.exitCode = previousExitCode ?? 0;
  });

  it("shows chrome-mcp transport for existing-session status without fake CDP fields", async () => {
    mockStatus({
      headlessSource: "default",
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome-live", "status"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain("transport: chrome-mcp");
    expect(output).toContain("headless: false (default)");
    expect(output).not.toContain("cdpPort:");
    expect(output).not.toContain("cdpUrl:");
  });

  it("shows configured userDataDir for existing-session status", async () => {
    mockStatus({
      profile: "brave-live",
      userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
      color: "#FB542B",
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "brave-live", "status"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain(
      "userDataDir: /Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
    );
  });

  it("shows configured cdpUrl for existing-session status", async () => {
    mockStatus({
      cdpUrl:
        "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
      userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome-live", "status"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain("transport: chrome-mcp");
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("userDataDir:");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("shows chrome-mcp transport in browser profiles output", async () => {
    getBrowserManageGatewayMock().mockImplementation(async (_method, _opts, req) =>
      req.path === "/profiles"
        ? {
            profiles: [
              {
                name: "chrome-live",
                driver: "existing-session",
                transport: "chrome-mcp",
                running: true,
                tabCount: 2,
                isDefault: false,
                isRemote: false,
                cdpPort: null,
                cdpUrl: null,
                color: "#00AA00",
              },
            ],
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "profiles"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain("chrome-live: running (2 tabs) [existing-session]");
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("redacts remote cdpUrl details in browser profiles output", async () => {
    getBrowserManageGatewayMock().mockImplementation(async (_method, _opts, req) =>
      req.path === "/profiles"
        ? {
            profiles: [
              {
                name: "remote",
                driver: "openclaw",
                transport: "cdp",
                running: true,
                tabCount: 1,
                isDefault: false,
                isRemote: true,
                cdpPort: null,
                cdpUrl:
                  "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
                color: "#00AA00",
              },
            ],
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "profiles"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("shows chrome-mcp transport after creating an existing-session profile", async () => {
    getBrowserManageGatewayMock().mockImplementation(async (_method, _opts, req) =>
      req.path === "/profiles/create"
        ? {
            ok: true,
            profile: "chrome-live",
            transport: "chrome-mcp",
            cdpPort: null,
            cdpUrl: null,
            userDataDir: null,
            color: "#00AA00",
            isRemote: false,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(
      ["browser", "create-profile", "--name", "chrome-live", "--driver", "existing-session"],
      { from: "user" },
    );

    const output = lastRuntimeLog();
    expect(output).toContain('Created profile "chrome-live"');
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("shows cdpUrl after creating an existing-session endpoint profile", async () => {
    getBrowserManageGatewayMock().mockImplementation(async (_method, _opts, req) =>
      req.path === "/profiles/create"
        ? {
            ok: true,
            profile: "chrome-live",
            transport: "chrome-mcp",
            cdpPort: null,
            cdpUrl:
              "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
            userDataDir: null,
            color: "#00AA00",
            isRemote: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(
      [
        "browser",
        "create-profile",
        "--name",
        "chrome-live",
        "--driver",
        "existing-session",
        "--cdp-url",
        "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
      ],
      { from: "user" },
    );

    const output = lastRuntimeLog();
    expect(output).toContain('Created profile "chrome-live"');
    expect(output).toContain("transport: chrome-mcp");
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("redacts remote cdpUrl details after creating a remote profile", async () => {
    getBrowserManageGatewayMock().mockImplementation(async (_method, _opts, req) =>
      req.path === "/profiles/create"
        ? {
            ok: true,
            profile: "remote",
            transport: "cdp",
            cdpPort: null,
            cdpUrl:
              "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
            userDataDir: null,
            color: "#00AA00",
            isRemote: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(
      [
        "browser",
        "create-profile",
        "--name",
        "remote",
        "--cdp-url",
        "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
      ],
      { from: "user" },
    );

    const output = lastRuntimeLog();
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("redacts sensitive remote cdpUrl details in status output", async () => {
    mockStatus({
      profile: "remote",
      driver: "openclaw",
      transport: "cdp",
      pid: null,
      cdpPort: 9222,
      cdpUrl:
        "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "remote", "status"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("prints managed graphics facts in status output", async () => {
    mockStatus({
      profile: "openclaw",
      driver: "openclaw",
      transport: "cdp",
      cdpPort: 18800,
      cdpUrl: "http://127.0.0.1:18800",
      chosenBrowser: "chromium",
      headless: true,
      attachOnly: false,
      graphics: {
        status: "available",
        observedAt: 123,
        acceleration: "hardware",
        renderer: "ANGLE (Intel)",
        vendor: "Intel",
        version: "OpenGL ES 3.0",
        backend: "(gl=angle,angle=metal)",
        devices: [],
        featureStatus: {},
        disabledFeatures: [],
        driverBugWorkarounds: [],
        videoDecoding: [],
        videoEncoding: [],
      },
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "status"], { from: "user" });

    expect(lastRuntimeLog()).toContain(
      "graphics: hardware; renderer ANGLE (Intel); backend (gl=angle,angle=metal)",
    );
  });

  it("prints suggested tab references while keeping raw target ids visible", async () => {
    getBrowserManageGatewayMock().mockImplementation(async (_method, _opts, req) =>
      req.path === "/tabs"
        ? {
            running: true,
            tabs: [
              {
                targetId: "RAW_TARGET_1",
                suggestedTargetId: "docs",
                tabId: "t1",
                label: "docs",
                title: "Docs",
                url: "https://docs.example.com",
              },
            ],
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "tabs"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain("use: docs");
    expect(output).toContain("tab: t1");
    expect(output).toContain("label:docs");
    expect(output).toContain("id: RAW_TARGET_1");
  });

  it("rejects non-integer tab indexes without calling browser actions", async () => {
    const program = createBrowserManageProgram();

    await expect(
      program.parseAsync(["browser", "tab", "select", "1.9"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(getBrowserCliRuntimeCapture().runtimeErrors.at(-1)).toContain(
      "index must be a positive integer",
    );

    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    await expect(
      program.parseAsync(["browser", "tab", "close", "abc"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(getBrowserCliRuntimeCapture().runtimeErrors.at(-1)).toContain(
      "index must be a positive integer",
    );
    expect(getBrowserManageGatewayMock()).not.toHaveBeenCalledWith(
      "browser.request",
      expect.anything(),
      expect.objectContaining({ path: "/tabs/action" }),
      expect.anything(),
    );
  });

  it("accepts signed decimal tab indexes", async () => {
    const program = createBrowserManageProgram();

    await program.parseAsync(["browser", "tab", "select", "+2"], { from: "user" });

    expect(getBrowserManageGatewayMock()).toHaveBeenCalledWith(
      "browser.request",
      expect.anything(),
      expect.objectContaining({
        path: "/tabs/action",
        body: { action: "select", index: 1 },
      }),
      expect.anything(),
    );
  });

  it("rejects unsupported profile drivers before creating a profile", async () => {
    const program = createBrowserManageProgram();

    await expect(
      program.parseAsync(["browser", "create-profile", "--name", "test", "--driver", "chromium"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(getBrowserCliRuntimeCapture().runtimeErrors.at(-1)).toContain(
      "--driver must be openclaw or existing-session",
    );
    expect(getBrowserManageGatewayMock()).not.toHaveBeenCalled();
  });

  it("prints authenticated extension drift from the canonical browser doctor report", async () => {
    mockBrowserResponses({
      "/doctor": {
        ok: true,
        checks: [
          {
            id: "extension-version",
            label: "Chrome extension version",
            status: "warn",
            summary: "running 2.0.0; bundled 2.2.0 (mismatch)",
            fixHint: "Reload the OpenClaw extension.",
          },
        ],
        status: {
          enabled: true,
          profile: "chrome",
          driver: "extension",
          transport: "extension",
          running: true,
          cdpReady: true,
        },
      },
      "/profiles": { profiles: [{ name: "chrome", running: true }] },
      "/tabs": { running: true, tabs: [] },
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome", "doctor"], {
      from: "user",
    });

    expect(lastRuntimeLog()).toContain(
      "WARN extension-version: running 2.0.0; bundled 2.2.0 (mismatch); Reload the OpenClaw extension.",
    );
    expect(process.exitCode).toBe(0);
    expect(getBrowserManageGatewayMock().mock.calls[0]?.[2]).toMatchObject({
      path: "/doctor",
      query: { profile: "chrome" },
    });
  });

  it("keeps unavailable extension version evidence informational and nonfatal", async () => {
    mockBrowserResponses(
      {
        "/doctor": {
          checks: [
            {
              id: "extension-version",
              label: "Chrome extension version",
              status: "info",
              summary: "version data unavailable",
            },
          ],
          status: {
            enabled: true,
            profile: "chrome",
            transport: "extension",
            running: true,
          },
        },
        "/profiles": { profiles: [{ name: "chrome", running: true }] },
      },
      { running: true, tabs: [] },
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome", "doctor"], {
      from: "user",
    });

    expect(lastRuntimeLog()).toContain("INFO extension-version: version data unavailable");
    expect(lastRuntimeLog()).not.toContain("WARN extension-version");
    expect(process.exitCode).toBe(0);
  });

  it("preserves one nonfatal JSON report for confirmed extension version drift", async () => {
    mockBrowserResponses(
      {
        "/doctor": {
          checks: [
            {
              id: "extension-version",
              label: "Chrome extension version",
              status: "warn",
              summary: "running 2.0.0; bundled 2.2.0 (mismatch)",
              fixHint: "Reload the OpenClaw extension.",
            },
          ],
          status: {
            enabled: true,
            profile: "chrome",
            transport: "extension",
            running: true,
          },
        },
        "/profiles": { profiles: [{ name: "chrome", running: true }] },
      },
      { running: true, tabs: [] },
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--json", "doctor"], { from: "user" });

    expect(parseSingleRuntimeJson()).toMatchObject({
      ok: true,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "extension-version", ok: true, warning: true }),
      ]),
    });
    expect(getBrowserCliRuntimeCapture().runtimeErrors).toEqual([]);
    expect(getBrowserCliRuntime().writeJson).toHaveBeenCalledTimes(1);
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("runs exactly one deep snapshot after consuming the canonical doctor report", async () => {
    mockBrowserResponses({
      "/doctor": {
        checks: [],
        status: {
          enabled: true,
          profile: "chrome",
          transport: "extension",
          running: true,
        },
      },
      "/profiles": { profiles: [{ name: "chrome", running: true }] },
      "/tabs": { running: true, tabs: [] },
      "/snapshot": { ok: true, format: "aria", nodes: [{ role: "document" }] },
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome", "doctor", "--deep"], {
      from: "user",
    });

    expect(lastRuntimeLog()).toContain("OK live-snapshot: 1 nodes/lines");
    const snapshotCalls = getBrowserManageGatewayMock().mock.calls.filter(
      (call) => call[2].path === "/snapshot",
    );
    expect(snapshotCalls).toHaveLength(1);
  });

  it("prints a readable browser doctor report", async () => {
    mockBrowserResponses(
      {
        "/doctor": {
          checks: [],
          status: {
            enabled: true,
            profile: "openclaw",
            driver: "openclaw",
            transport: "cdp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: 4321,
            cdpPort: 18792,
            cdpUrl: "http://127.0.0.1:18792",
            chosenBrowser: "chrome",
            userDataDir: null,
            color: "#00AA00",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: false,
            graphics: {
              status: "available",
              observedAt: 123,
              acceleration: "software",
              renderer: "ANGLE (Google, SwiftShader Device)",
              vendor: "Google Inc.",
              version: "OpenGL ES 3.0",
              backend: "(gl=angle,angle=swiftshader)",
              devices: [],
              featureStatus: {},
              disabledFeatures: [],
              driverBugWorkarounds: [],
              videoDecoding: [],
              videoEncoding: [],
            },
          },
        },
        "/profiles": { profiles: [{ name: "openclaw", running: true }] },
        "/tabs": {
          running: true,
          tabs: [
            {
              targetId: "abc",
              tabId: "t1",
              suggestedTargetId: "t1",
              title: "Example",
              url: "https://example.com",
            },
          ],
        },
      },
      {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "doctor"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain("OK gateway: browser control endpoint reachable");
    expect(output).toContain("OK graphics: software");
    expect(output).toContain("OK tabs: 1 visible, use tab reference t1");
    expect(getBrowserCliRuntime().writeJson).not.toHaveBeenCalled();
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("prints one complete JSON browser doctor failure before setting exit status", async () => {
    mockBrowserResponses(
      {
        "/doctor": {
          checks: [],
          status: {
            enabled: false,
            profile: "openclaw",
            transport: "cdp",
            running: false,
          },
        },
        "/profiles": { profiles: [] },
      },
      {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--json", "doctor"], { from: "user" });

    expect(parseSingleRuntimeJson()).toEqual(
      expect.objectContaining({
        ok: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "gateway", ok: true }),
          expect.objectContaining({ name: "plugin", ok: false }),
        ]),
      }),
    );
    expect(getBrowserCliRuntimeCapture().runtimeErrors).toEqual([]);
    expect(getBrowserCliRuntime().writeJson).toHaveBeenCalledTimes(1);
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prints a readable browser doctor failure when gateway auth SecretRefs are unavailable", async () => {
    const error = Object.assign(new Error("gateway.auth.password unavailable"), {
      code: "GATEWAY_SECRET_REF_UNAVAILABLE",
      name: "GatewaySecretRefUnavailableError",
    });
    getBrowserManageGatewayMock().mockRejectedValueOnce(error);

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "doctor"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain(
      "FAIL gateway: Gateway auth SecretRef is unavailable in this command path",
    );
    expect(output).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(output).not.toContain("GatewaySecretRefUnavailableError");
    expect(getBrowserCliRuntime().writeJson).not.toHaveBeenCalled();
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    { deleted: false, json: false },
    { deleted: true, json: false },
    { deleted: false, json: true },
    { deleted: true, json: true },
  ])("reports profile deletion with deleted=$deleted and json=$json", async ({ deleted, json }) => {
    const result = { ok: true, profile: "proof-retained", deleted };
    getBrowserManageGatewayMock().mockResolvedValueOnce(result);

    const program = createBrowserManageProgram();
    await program.parseAsync(
      ["browser", ...(json ? ["--json"] : []), "delete-profile", "--name", result.profile],
      { from: "user" },
    );

    expect(getBrowserManageGatewayMock()).toHaveBeenCalledWith(
      "browser.request",
      expect.anything(),
      expect.objectContaining({ method: "DELETE", path: "/profiles/proof-retained" }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
    if (json) {
      expect(parseSingleRuntimeJson()).toEqual(result);
      expect(getBrowserCliRuntime().writeJson).toHaveBeenCalledTimes(1);
    } else {
      expect(lastRuntimeLog()).toBe(
        deleted
          ? '🦞 Deleted profile "proof-retained" (user data removed)'
          : '🦞 Deleted profile "proof-retained" (user data removal not confirmed)',
      );
      expect(getBrowserCliRuntime().writeJson).not.toHaveBeenCalled();
    }
    expect(getBrowserCliRuntimeCapture().runtimeErrors).toEqual([]);
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });
});
