import { expect, it, vi } from "vitest";
import chromeExtensionManifest from "../../chrome-extension/manifest.json" with { type: "json" };
import type { BrowserStatus } from "./client.types.js";
import { buildBrowserDoctorReport } from "./doctor.js";

const equivalentExtensionVersion =
  chromeExtensionManifest.version.split(".").length < 4
    ? `${chromeExtensionManifest.version}.0`
    : chromeExtensionManifest.version.replace(/\.0$/, "");

function reportFor(overrides: Partial<BrowserStatus>, extensionVersion?: string) {
  const status: BrowserStatus = {
    enabled: true,
    profile: "openclaw",
    transport: "cdp",
    running: false,
    pid: null,
    cdpPort: 18800,
    chosenBrowser: null,
    detectedBrowser: "chromium",
    detectedExecutablePath: "/usr/bin/chromium",
    userDataDir: "/tmp/openclaw",
    color: "#FF4500",
    headless: false,
    attachOnly: false,
    ...overrides,
  };
  return buildBrowserDoctorReport({ status, extensionVersion });
}

function check(report: ReturnType<typeof buildBrowserDoctorReport>, id: string) {
  return report.checks.find((entry) => entry.id === id);
}

it("fails readiness when the Chrome MCP target is unavailable", () => {
  const report = reportFor({ transport: "chrome-mcp" });
  expect(report.ok).toBe(false);
  expect(check(report, "attach-target")?.status).toBe("fail");
  expect(check(report, "extension-version")).toBeUndefined();
});

it.each([false, true])("keeps managed launch warnings non-fatal (headless=%s)", (headless) => {
  vi.stubGlobal("process", {
    ...process,
    platform: "linux",
    getuid: () => (headless ? 1000 : 0),
  });
  vi.stubEnv("DISPLAY", "");
  vi.stubEnv("WAYLAND_DISPLAY", "");
  const report = reportFor(
    headless
      ? { headless: true, headlessSource: "default" }
      : { detectedBrowser: null, detectedExecutablePath: null, headlessSource: "config" },
  );
  expect(report.ok).toBe(true);
  expect(check(report, "extension-version")).toBeUndefined();
  expect(report.checks.filter((entry) => entry.status === "warn").map((entry) => entry.id)).toEqual(
    headless ? [] : ["managed-executable", "display", "linux-sandbox"],
  );
  if (headless) {
    expect(check(report, "headless-mode")?.status).toBe("pass");
    expect(check(report, "display")).toBeUndefined();
  }
});

it.each([
  [
    {
      status: "available",
      observedAt: 123,
      acceleration: "software",
      renderer: "ANGLE (Google, SwiftShader Device)",
      vendor: "Google Inc.",
      version: "OpenGL ES 3.0",
      backend: "(gl=angle,angle=swiftshader)",
      devices: [],
      featureStatus: { webgl: "enabled_readback" },
      disabledFeatures: [],
      driverBugWorkarounds: [],
      videoDecoding: [],
      videoEncoding: [],
    },
    {
      status: "info",
      summary: expect.stringMatching(/^(?=[\s\S]*software)(?=[\s\S]*SwiftShader)/),
    },
  ],
  [
    { status: "unavailable", observedAt: 123, reason: "SystemInfo domain unavailable" },
    { status: "warn", summary: "unavailable: SystemInfo domain unavailable" },
  ],
] satisfies [BrowserStatus["graphics"], object][])(
  "reports cached graphics %j",
  (graphics, expected) => {
    const report = reportFor({
      running: true,
      cdpReady: true,
      cdpHttp: true,
      headless: true,
      graphics,
    });
    expect(report.ok).toBe(true);
    expect(check(report, "graphics")).toMatchObject(expected);
  },
);

it.each([
  ["current", chromeExtensionManifest.version, "pass"],
  ["equivalent missing version component", equivalentExtensionVersion, "pass"],
  ["maximum valid version", "65535.65535.65535.65535", "warn"],
  ["unavailable", undefined, "info"],
  ["terminal-control input", "2.0.0\u001b[31m", "info"],
  ["oversized version component", "65536.0", "info"],
  ["nonzero leading zero", "02.0.0", "info"],
  ["all-zero version", "0.0.0.0", "info"],
  ["too many version components", "2.0.0.0.0", "info"],
] as const)("classifies %s extension version evidence", (_label, extensionVersion, severity) => {
  const report = reportFor({ transport: "extension", running: true }, extensionVersion);

  const versionCheck = check(report, "extension-version");
  expect(versionCheck?.status).toBe(severity);
  if (severity === "warn") {
    expect(versionCheck?.summary).toContain(
      `running ${extensionVersion}; bundled ${chromeExtensionManifest.version}`,
    );
    expect(versionCheck?.fixHint).toMatch(/reload/i);
  } else {
    expect(versionCheck?.fixHint).toBeUndefined();
    expect(versionCheck?.summary).not.toContain("\u001b");
  }
  expect(report.ok).toBe(true);
});
