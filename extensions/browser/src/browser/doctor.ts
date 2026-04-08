import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { BrowserStatus } from "./client.js";

export type BrowserDoctorCheckStatus = "pass" | "warn" | "fail" | "info";

export type BrowserDoctorCheck = {
  id: string;
  label: string;
  status: BrowserDoctorCheckStatus;
  summary: string;
  fixHint?: string;
};

export type BrowserDoctorReport = {
  ok: boolean;
  profile: string;
  transport: "cdp" | "chrome-mcp";
  checks: BrowserDoctorCheck[];
  status: BrowserStatus;
};

function usesChromeMcp(status: BrowserStatus): boolean {
  return status.transport === "chrome-mcp" || status.driver === "existing-session";
}

export function buildBrowserDoctorReport(params: {
  status: BrowserStatus;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  uid?: number | null;
}): BrowserDoctorReport {
  const status = params.status;
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  const uid = params.uid ?? process.getuid?.() ?? null;
  const checks: BrowserDoctorCheck[] = [
    {
      id: "control-server",
      label: "Browser control server",
      status: "pass",
      summary: "Browser control server responded.",
    },
  ];

  if (!status.enabled) {
    checks.push({
      id: "browser-enabled",
      label: "Browser feature",
      status: "fail",
      summary: "Browser tooling is disabled in config.",
      fixHint: "Enable `browser.enabled: true` and restart the Gateway.",
    });
  } else {
    checks.push({
      id: "browser-enabled",
      label: "Browser feature",
      status: "pass",
      summary: "Browser tooling is enabled.",
    });
  }

  if (usesChromeMcp(status)) {
    if (status.running) {
      checks.push({
        id: "attach-target",
        label: "Chrome MCP attach target",
        status: "pass",
        summary: "Attach target is reachable.",
      });
    } else {
      checks.push({
        id: "attach-target",
        label: "Chrome MCP attach target",
        status: "fail",
        summary: "Existing-session browser attach is not ready.",
        fixHint:
          "Keep the browser open, enable remote debugging in the browser inspect page, accept the attach prompt, and retry.",
      });
    }
  } else {
    if (status.detectError) {
      checks.push({
        id: "browser-executable",
        label: "Browser executable",
        status: "fail",
        summary: `Browser executable detection failed: ${status.detectError}`,
        fixHint: "Fix browser.executablePath or install a supported Chromium-based browser.",
      });
    } else if (status.detectedExecutablePath || status.executablePath) {
      checks.push({
        id: "browser-executable",
        label: "Browser executable",
        status: "pass",
        summary: `Detected browser executable at ${status.detectedExecutablePath ?? status.executablePath}.`,
      });
    } else {
      checks.push({
        id: "browser-executable",
        label: "Browser executable",
        status: "fail",
        summary: "No Chromium-based browser executable was detected for managed browser launch.",
        fixHint: "Install Chrome, Chromium, Brave, or Edge, or set browser.executablePath.",
      });
    }

    if (platform === "linux" && !status.headless) {
      const display = normalizeOptionalString(env.DISPLAY);
      const wayland = normalizeOptionalString(env.WAYLAND_DISPLAY);
      if (display || wayland) {
        checks.push({
          id: "display",
          label: "Display session",
          status: "pass",
          summary: `Display session detected via ${display ? "DISPLAY" : "WAYLAND_DISPLAY"}.`,
        });
      } else {
        checks.push({
          id: "display",
          label: "Display session",
          status: "fail",
          summary: "No DISPLAY or WAYLAND_DISPLAY is set while browser.headless is false.",
          fixHint: "Run with a desktop session, start Xvfb, or set browser.headless: true.",
        });
      }
    }

    if (platform === "linux" && uid === 0) {
      checks.push({
        id: "sandbox",
        label: "Chromium sandbox",
        status: status.noSandbox ? "pass" : "warn",
        summary: status.noSandbox
          ? "browser.noSandbox is enabled for a root/container runtime."
          : "Gateway is running as root and browser.noSandbox is false.",
        fixHint: status.noSandbox
          ? undefined
          : "If managed browser launch fails in this runtime, set browser.noSandbox: true.",
      });
    }

    if (status.running) {
      checks.push({
        id: "cdp-websocket",
        label: "CDP websocket",
        status: "pass",
        summary: "Browser CDP websocket is reachable.",
      });
    } else if (status.cdpHttp) {
      checks.push({
        id: "cdp-websocket",
        label: "CDP websocket",
        status: "fail",
        summary: "CDP HTTP responded, but the browser websocket is unhealthy.",
        fixHint:
          "A stale browser process, port conflict, or broken browser session may be blocking control. Check `openclaw browser status` and retry after cleanup.",
      });
    } else {
      checks.push({
        id: "cdp-websocket",
        label: "CDP websocket",
        status: "info",
        summary:
          "Managed browser is not running. OpenClaw can start it on demand if launch prerequisites are satisfied.",
      });
    }
  }

  return {
    ok: !checks.some((check) => check.status === "fail"),
    profile: status.profile ?? "openclaw",
    transport: usesChromeMcp(status) ? "chrome-mcp" : "cdp",
    checks,
    status,
  };
}
