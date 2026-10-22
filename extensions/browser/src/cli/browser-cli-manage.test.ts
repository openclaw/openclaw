import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserStatus, ProfileStatus } from "../browser/client.js";
import {
  createBrowserManageProgram,
  getBrowserManageGatewayMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntime, getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

const runtime = getBrowserCliRuntime();
const capture = getBrowserCliRuntimeCapture();
const gateway = getBrowserManageGatewayMock();

function mockBrowserResponses(responses: Record<string, Record<string, unknown>>) {
  gateway.mockImplementation(async (_method, _opts, req) => responses[req.path ?? ""] ?? {});
}

function makeStatus(overrides: Partial<BrowserStatus> = {}) {
  return {
    enabled: true,
    profile: "chrome-live",
    driver: "existing-session" as const,
    transport: "chrome-mcp" as const,
    running: true,
    headless: false,
    ...overrides,
  };
}

function mockResponse(path: string, response: Record<string, unknown>) {
  mockBrowserResponses({ [path]: response });
}

function makeProfile(overrides: Partial<ProfileStatus> = {}) {
  return {
    name: "chrome-live",
    tabCount: 2,
    ...makeStatus(),
    ...overrides,
  };
}

function mockDoctor(
  report: Record<string, unknown> & { status: Partial<BrowserStatus> },
  tabs: Record<string, unknown>[] = [],
  profiles = [{ name: report.status.profile, running: true }],
) {
  mockBrowserResponses({
    "/doctor": report,
    "/profiles": { profiles },
    "/tabs": { running: true, tabs },
  });
}

async function run(args: string[]) {
  await createBrowserManageProgram().parseAsync(["browser", ...args], { from: "user" });
}

async function statusOutput(overrides: Partial<BrowserStatus>) {
  mockResponse("/", makeStatus(overrides));
  await run(["--browser-profile", overrides.profile ?? "chrome-live", "status"]);
  return lastRuntimeLog();
}

const secretUrl =
  "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890";
function expectRedactedUrl(output: string) {
  expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
  for (const secret of [
    "alice",
    "supersecretpasswordvalue1234",
    "supersecrettokenvalue1234567890",
  ]) {
    expect(output).not.toContain(secret);
  }
}

function graphics(
  overrides: Partial<Extract<NonNullable<BrowserStatus["graphics"]>, { status: "available" }>>,
) {
  return {
    status: "available" as const,
    observedAt: 123,
    acceleration: "hardware" as const,
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
    ...overrides,
  };
}

function lastRuntimeLog(): string {
  const calls = runtime.log.mock.calls;
  const value = calls[calls.length - 1]?.[0];
  if (typeof value !== "string") {
    throw new Error("expected browser CLI runtime log");
  }
  return value;
}

function parseSingleRuntimeJson(): unknown {
  const logs = capture.runtimeLogs;
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0] ?? "");
}

function expectHumanOutput(exitCode: number) {
  expect(runtime.writeJson).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(exitCode);
}

describe("browser manage output", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    gateway.mockClear();
    capture.resetRuntimeCapture();
    runtime.exit.mockClear();
    runtime.writeJson.mockClear();
  });

  afterEach(() => {
    process.exitCode = previousExitCode ?? 0;
  });

  const userDataDir = "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser";
  it("shows chrome-mcp status without fake CDP fields", async () => {
    const output = await statusOutput({ headlessSource: "default" });
    expect(output).toContain("transport: chrome-mcp");
    expect(output).toContain("headless: false (default)");
    expect(output).not.toContain("cdpPort:");
    expect(output).not.toContain("cdpUrl:");
  });
  it("shows the configured userDataDir", async () => {
    expect(await statusOutput({ profile: "brave-live", userDataDir, color: "#FB542B" })).toContain(
      `userDataDir: ${userDataDir}`,
    );
  });
  it("redacts cdpUrl and prefers it over userDataDir", async () => {
    const output = await statusOutput({ cdpUrl: secretUrl, userDataDir });
    expect(output).toContain("transport: chrome-mcp");
    expectRedactedUrl(output);
    expect(output).not.toContain("userDataDir:");
  });
  it("prints managed graphics facts in status output", async () => {
    const output = await statusOutput({
      profile: "openclaw",
      driver: "openclaw",
      transport: "cdp",
      cdpPort: 18800,
      cdpUrl: "http://127.0.0.1:18800",
      chosenBrowser: "chromium",
      headless: true,
      attachOnly: false,
      graphics: graphics({}),
    });
    expect(output).toContain(
      "graphics: hardware; renderer ANGLE (Intel); backend (gl=angle,angle=metal)",
    );
  });

  it("shows chrome-mcp transport in browser profiles output", async () => {
    mockResponse("/profiles", { profiles: [makeProfile()] });
    await run(["profiles"]);

    const output = lastRuntimeLog();
    expect(output).toContain("chrome-live: running (2 tabs) [existing-session]");
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("redacts remote cdpUrl details in browser profiles output", async () => {
    mockResponse("/profiles", {
      profiles: [
        makeProfile({
          name: "remote",
          driver: "openclaw",
          transport: "cdp",
          tabCount: 1,
          isRemote: true,
          cdpUrl: secretUrl,
        }),
      ],
    });
    await run(["profiles"]);
    expectRedactedUrl(lastRuntimeLog());
  });

  it.each([
    { profile: "chrome-live", transport: "chrome-mcp", driver: ["--driver", "existing-session"] },
    { profile: "remote", transport: "cdp", driver: [] },
  ])(
    "redacts cdpUrl after creating a $transport profile",
    async ({ profile, transport, driver }) => {
      mockResponse("/profiles/create", {
        profile,
        transport,
        cdpUrl: secretUrl,
        isRemote: true,
      });
      await run(["create-profile", "--name", profile, ...driver, "--cdp-url", secretUrl]);

      const output = lastRuntimeLog();
      expect(output).toContain(`Created profile "${profile}"`);
      if (transport === "chrome-mcp") {
        expect(output).toContain("transport: chrome-mcp");
      }
      expectRedactedUrl(output);
    },
  );

  it("prints suggested tab references while keeping raw target ids visible", async () => {
    mockResponse("/tabs", {
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
    });
    await run(["tabs"]);

    const output = lastRuntimeLog();
    expect(output).toContain("use: docs");
    expect(output).toContain("tab: t1");
    expect(output).toContain("label:docs");
    expect(output).toContain("id: RAW_TARGET_1");
  });

  it.each([
    ["select", "1.9"],
    ["close", "abc"],
  ])("rejects tab %s %s before actions", async (action, index) => {
    await expect(run(["tab", action, index])).rejects.toThrow("__exit__:1");
    expect(capture.runtimeErrors.at(-1)).toContain("index must be a positive integer");
    expect(gateway).not.toHaveBeenCalledWith(
      "browser.request",
      expect.anything(),
      expect.objectContaining({ path: "/tabs/action" }),
      expect.anything(),
    );
  });

  it("rejects unsupported profile drivers before creating a profile", async () => {
    await expect(run(["create-profile", "--name", "test", "--driver", "chromium"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(capture.runtimeErrors.at(-1)).toContain("--driver must be openclaw or existing-session");
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "warn",
      summary: "running 2.0.0; bundled 2.2.0 (mismatch)",
      fixHint: "Reload the OpenClaw extension.",
      line: "WARN extension-version: running 2.0.0; bundled 2.2.0 (mismatch); Reload the OpenClaw extension.",
    },
    {
      status: "info",
      summary: "version data unavailable",
      fixHint: undefined,
      line: "INFO extension-version: version data unavailable",
    },
  ])(
    "prints nonfatal $status extension version evidence",
    async ({ status, summary, fixHint, line }) => {
      mockDoctor({
        ok: true,
        checks: [
          { id: "extension-version", label: "Chrome extension version", status, summary, fixHint },
        ],
        status: makeStatus({
          profile: "chrome",
          driver: "extension",
          transport: "extension",
          cdpReady: true,
        }),
      });
      await run(["--browser-profile", "chrome", "doctor"]);
      expect(lastRuntimeLog()).toContain(line);
      if (status === "info") {
        expect(lastRuntimeLog()).not.toContain("WARN extension-version");
      }
      expect(process.exitCode).toBe(0);
      expect(gateway.mock.calls[0]?.[2]).toMatchObject({
        path: "/doctor",
        query: { profile: "chrome" },
      });
    },
  );

  it("prints a readable browser doctor report", async () => {
    mockDoctor(
      {
        checks: [],
        status: makeStatus({
          profile: "openclaw",
          driver: "openclaw",
          transport: "cdp",
          graphics: graphics({
            acceleration: "software",
            renderer: "ANGLE (Google, SwiftShader Device)",
            backend: "(gl=angle,angle=swiftshader)",
          }),
        }),
      },
      [{ suggestedTargetId: "t1" }],
    );

    await run(["doctor"]);

    const output = lastRuntimeLog();
    expect(output).toContain("OK gateway: browser control endpoint reachable");
    expect(output).toContain("OK graphics: software");
    expect(output).toContain("OK tabs: 1 visible, use tab reference t1");
    expectHumanOutput(0);
  });

  it("prints one complete JSON browser doctor failure before setting exit status", async () => {
    mockDoctor(
      {
        checks: [],
        status: {
          enabled: false,
          profile: "openclaw",
          transport: "cdp",
          running: false,
        },
      },
      [],
      [],
    );

    await run(["--json", "doctor"]);

    expect(parseSingleRuntimeJson()).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "gateway", ok: true }),
        expect.objectContaining({ name: "plugin", ok: false }),
      ]),
    });
    expect(capture.runtimeErrors).toEqual([]);
    expect(runtime.writeJson).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prints a readable browser doctor failure when gateway auth SecretRefs are unavailable", async () => {
    const error = Object.assign(new Error("gateway.auth.password unavailable"), {
      code: "GATEWAY_SECRET_REF_UNAVAILABLE",
      name: "GatewaySecretRefUnavailableError",
    });
    gateway.mockRejectedValueOnce(error);

    await run(["doctor"]);

    const output = lastRuntimeLog();
    expect(output).toContain(
      "FAIL gateway: Gateway auth SecretRef is unavailable in this command path",
    );
    expect(output).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(output).not.toContain("GatewaySecretRefUnavailableError");
    expectHumanOutput(1);
  });

  it.each([false, true])("reports profile deletion with deleted=%s", async (deleted) => {
    const result = { ok: true, profile: "proof-retained", deleted };
    gateway.mockResolvedValueOnce(result);

    await run(["delete-profile", "--name", result.profile]);

    expect(gateway).toHaveBeenCalledWith(
      "browser.request",
      expect.anything(),
      expect.objectContaining({ method: "DELETE", path: "/profiles/proof-retained" }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
    expect(lastRuntimeLog()).toBe(
      deleted
        ? '🦞 Deleted profile "proof-retained" (user data removed)'
        : '🦞 Deleted profile "proof-retained" (user data removal not confirmed)',
    );
    expect(capture.runtimeErrors).toEqual([]);
    expectHumanOutput(0);
  });
});
