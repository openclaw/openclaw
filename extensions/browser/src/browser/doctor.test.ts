import { describe, expect, it } from "vitest";
import { buildBrowserDoctorReport } from "./doctor.js";

describe("buildBrowserDoctorReport", () => {
  it("reports managed browsers that are not running as launchable info instead of failure", () => {
    const report = buildBrowserDoctorReport({
      platform: "linux",
      env: { DISPLAY: ":99" },
      uid: 1000,
      status: {
        enabled: true,
        profile: "openclaw",
        driver: "openclaw",
        transport: "cdp",
        running: false,
        cdpReady: false,
        cdpHttp: false,
        pid: null,
        cdpPort: 18800,
        cdpUrl: "http://127.0.0.1:18800",
        chosenBrowser: null,
        detectedBrowser: "chromium",
        detectedExecutablePath: "/usr/bin/chromium",
        detectError: null,
        userDataDir: "/tmp/openclaw",
        color: "#FF4500",
        headless: false,
        noSandbox: false,
        executablePath: null,
        attachOnly: false,
      },
    });

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "cdp-websocket")).toMatchObject({
      status: "info",
    });
  });

  it("fails when Chrome MCP attach is not ready", () => {
    const report = buildBrowserDoctorReport({
      status: {
        enabled: true,
        profile: "user",
        driver: "existing-session",
        transport: "chrome-mcp",
        running: false,
        cdpReady: false,
        cdpHttp: false,
        pid: null,
        cdpPort: null,
        cdpUrl: null,
        chosenBrowser: null,
        detectedBrowser: null,
        detectedExecutablePath: null,
        detectError: null,
        userDataDir: null,
        color: "#00AA00",
        headless: false,
        noSandbox: false,
        executablePath: null,
        attachOnly: true,
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "attach-target")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when Linux managed browser launch lacks a display", () => {
    const report = buildBrowserDoctorReport({
      platform: "linux",
      env: {},
      uid: 1000,
      status: {
        enabled: true,
        profile: "openclaw",
        driver: "openclaw",
        transport: "cdp",
        running: false,
        cdpReady: false,
        cdpHttp: false,
        pid: null,
        cdpPort: 18800,
        cdpUrl: "http://127.0.0.1:18800",
        chosenBrowser: null,
        detectedBrowser: "chromium",
        detectedExecutablePath: "/usr/bin/chromium",
        detectError: null,
        userDataDir: "/tmp/openclaw",
        color: "#FF4500",
        headless: false,
        noSandbox: false,
        executablePath: null,
        attachOnly: false,
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "display")).toMatchObject({
      status: "fail",
    });
  });
});
