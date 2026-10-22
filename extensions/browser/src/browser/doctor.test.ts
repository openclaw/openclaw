import { expect, it } from "vitest";
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

it.each([
  [{}, "cdp-websocket", { status: "info", summary: "Browser is launchable but not running" }, true],
  [{ transport: "chrome-mcp" }, "attach-target", { status: "fail" }, false],
] satisfies [Partial<BrowserStatus>, string, object, boolean][])(
  "reports readiness for %j",
  (status, id, expected, ok) => {
    const report = reportFor(status, { platform: "linux", env: { DISPLAY: ":99" }, uid: 1000 });
    expect(report.ok).toBe(ok);
    expect(check(report, id)).toMatchObject(expected);
    expect(check(report, "extension-version")).toBeUndefined();
  },
);

it.each([false, true])("keeps managed launch warnings non-fatal (headless=%s)", (headless) => {
  const report = reportFor(
    headless
      ? { headless: true, headlessSource: "default" }
      : { detectedBrowser: null, detectedExecutablePath: null, headlessSource: "config" },
    { platform: "linux", env: {}, uid: headless ? 1000 : 0 },
  );
  expect(report.ok).toBe(true);
  expect(report.checks.filter((entry) => entry.status === "warn").map((entry) => entry.id)).toEqual(
    headless ? [] : ["managed-executable", "display", "linux-sandbox"],
  );
  if (headless) {
    expect(check(report, "headless-mode")?.status).toBe("pass");
    expect(check(report, "display")).toBeUndefined();
  } else {
    expect(check(report, "display")?.summary).toBe(
      "No DISPLAY or WAYLAND_DISPLAY is set while headed mode is selected (config)",
    );
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
