import { describe, expect, it } from "vitest";
import chromeExtensionManifest from "../../chrome-extension/manifest.json" with { type: "json" };
import type { BrowserStatus } from "./client.types.js";
import { buildBrowserDoctorReport } from "./doctor.js";

const outdatedExtensionVersion = chromeExtensionManifest.version === "2.0.0" ? "1.0.0" : "2.0.0";
const equivalentExtensionVersion =
  chromeExtensionManifest.version.split(".").length < 4
    ? `${chromeExtensionManifest.version}.0`
    : chromeExtensionManifest.version.replace(/\.0$/, "");

function reportFor(
  overrides: Partial<BrowserStatus>,
  options: Omit<Parameters<typeof buildBrowserDoctorReport>[0], "status"> = {},
) {
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
  return buildBrowserDoctorReport({ status, ...options });
}

function check(report: ReturnType<typeof buildBrowserDoctorReport>, id: string) {
  return report.checks.find((entry) => entry.id === id);
}

function runningGraphics(graphics: BrowserStatus["graphics"]) {
  return reportFor({
    running: true,
    cdpReady: true,
    cdpHttp: true,
    headless: true,
    graphics,
  });
}

describe("buildBrowserDoctorReport", () => {
  it("reports stopped managed browsers as launchable diagnostics", () => {
    const report = reportFor(
      {},
      {
        platform: "linux",
        env: { DISPLAY: ":99" },
        uid: 1000,
      },
    );

    expect(report.ok).toBe(true);
    const websocketCheck = report.checks.find((entry) => entry.id === "cdp-websocket");
    expect(websocketCheck?.status).toBe("info");
    expect(websocketCheck?.summary).toBe("Browser is launchable but not running");
    expect(report.checks.find((entry) => entry.id === "extension-version")).toBeUndefined();
  });

  it("fails when Chrome MCP attach is not ready", () => {
    const report = reportFor({ transport: "chrome-mcp" });

    expect(report.ok).toBe(false);
    expect(check(report, "attach-target")?.status).toBe("fail");
    expect(check(report, "extension-version")).toBeUndefined();
  });

  it("keeps managed launch warnings non-fatal", () => {
    const report = reportFor(
      {
        detectedBrowser: null,
        detectedExecutablePath: null,
        headlessSource: "config",
      },
      { platform: "linux", env: {}, uid: 0 },
    );

    expect(report.ok).toBe(true);
    expect(
      report.checks.filter((entry) => entry.status === "warn").map((entry) => entry.id),
    ).toEqual(["managed-executable", "display", "linux-sandbox"]);
    expect(check(report, "display")?.summary).toBe(
      "No DISPLAY or WAYLAND_DISPLAY is set while headed mode is selected (config)",
    );
  });

  it("reports default headless mode without a display warning", () => {
    const report = reportFor(
      { headless: true, headlessSource: "default" },
      { platform: "linux", env: {}, uid: 1000 },
    );

    expect(check(report, "headless-mode")?.status).toBe("pass");
    expect(check(report, "display")).toBeUndefined();
  });

  it("reports cached software graphics facts without failing doctor", () => {
    const report = runningGraphics({
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
    });

    expect(report.ok).toBe(true);
    const graphicsCheck = check(report, "graphics");
    expect(graphicsCheck).toMatchObject({ status: "info" });
    expect(graphicsCheck?.summary).toContain("software");
    expect(graphicsCheck?.summary).toContain("SwiftShader");
  });

  it("warns when a running managed browser cannot provide graphics facts", () => {
    const report = runningGraphics({
      status: "unavailable",
      observedAt: 123,
      reason: "SystemInfo domain unavailable",
    });

    expect(report.ok).toBe(true);
    expect(check(report, "graphics")).toMatchObject({
      status: "warn",
      summary: "unavailable: SystemInfo domain unavailable",
    });
  });

  it.each([
    ["outdated", outdatedExtensionVersion, "warn"],
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
    const report = reportFor({ transport: "extension", running: true }, { extensionVersion });

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
});
