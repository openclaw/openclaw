import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { HealthFinding } from "openclaw/plugin-sdk/health";
import {
  asNullableRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { CONFIG_DIR } from "openclaw/plugin-sdk/text-utility-runtime";
import { parseBrowserMajorVersion, readBrowserVersion } from "./browser/chrome.executable-probe.js";
import {
  resolveBrowserExecutableForPlatform,
  resolveGoogleChromeExecutableForPlatform,
} from "./browser/chrome.executables.js";
import {
  getManagedBrowserMissingDisplayError,
  isLocalManagedProfile,
  resolveBrowserConfig,
  resolveProfile,
  type ResolvedBrowserConfig,
} from "./browser/config.js";
import { getBrowserProfileCapabilities } from "./browser/profile-capabilities.js";

const CHROME_MCP_MIN_MAJOR = 144;
const REMOTE_DEBUGGING_PAGES = [
  "chrome://inspect/#remote-debugging",
  "brave://inspect/#remote-debugging",
  "edge://inspect/#remote-debugging",
].join(", ");

function collectBrowserDoctorProfiles(cfg: OpenClawConfig, resolved: ResolvedBrowserConfig) {
  const browser = asNullableRecord(cfg.browser);
  const names = new Set(Object.keys(asNullableRecord(browser?.profiles) ?? {}));
  const defaultProfile = normalizeOptionalString(browser?.defaultProfile);
  if (defaultProfile) {
    names.add(defaultProfile);
  }
  const profiles = [...names]
    .flatMap((name) => {
      const profile = resolveProfile(resolved, name);
      return profile ? [profile] : [];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
  return {
    managed: profiles.filter(isLocalManagedProfile),
    chromeMcp: profiles.filter(
      (profile) => getBrowserProfileCapabilities(profile).usesChromeMcp && !profile.cdpUrl,
    ),
  };
}

export async function collectBrowserReadinessFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const report = (
    message: string,
    category: NonNullable<HealthFinding["category"]>,
    fixHint: string,
    docsUrl = "https://docs.openclaw.ai/tools/browser/troubleshooting",
  ) => {
    findings.push({
      checkId: "core/doctor/browser",
      severity: "warning",
      category,
      message,
      fixHint,
      docsUrl,
    });
  };
  const platform = process.platform;
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const { managed: managedProfiles, chromeMcp: profiles } = collectBrowserDoctorProfiles(
    cfg,
    resolved,
  );
  const managedProfileLabel = managedProfiles.map((profile) => profile.name).join(", ");
  if (resolved.enabled && resolved.extensionRelay.allowLegacyAuth) {
    report(
      "Legacy Browser Relay Authentication is enabled (browser.extensionRelay.allowLegacyAuth=true).",
      "recommended",
      "Update paired extensions and external CDP clients to Browser Relay Authentication v2, then set browser.extensionRelay.allowLegacyAuth=false.",
      "https://docs.openclaw.ai/tools/browser/setup",
    );
  }
  // General Doctor also runs unattended inside the Gateway. Profile discovery can
  // block on OS permission prompts, so leave it to explicit browser commands.
  if (fs.existsSync(path.join(CONFIG_DIR, "browser", "chrome-extension"))) {
    report(
      "Chrome extension native bootstrap was not inspected; registration status is unavailable in Doctor.",
      "recommended",
      `If extension attach does not work, run ${formatCliCommand("openclaw browser extension status --json")}; this may request browser profile access. Run ${formatCliCommand("openclaw browser extension install")} if repair is needed. No action needed if attach works.`,
      "https://docs.openclaw.ai/tools/browser/setup",
    );
  }
  const managedExecutables = new Map<
    string | undefined,
    ReturnType<typeof resolveBrowserExecutableForPlatform>
  >();
  const executableErrors = new Map<string | undefined, string>();
  const missingExecutableProfiles = managedProfiles.filter((profile) => {
    const executablePath = profile.executablePath;
    if (!managedExecutables.has(executablePath)) {
      try {
        managedExecutables.set(
          executablePath,
          resolveBrowserExecutableForPlatform({ ...resolved, executablePath }, platform),
        );
      } catch (error) {
        managedExecutables.set(executablePath, null);
        executableErrors.set(
          executablePath,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return !managedExecutables.get(executablePath);
  });
  const missingDisplay = managedProfiles
    .map((profile) =>
      getManagedBrowserMissingDisplayError(resolved, profile, { platform, env: process.env }),
    )
    .filter((error) => error !== null);
  const shouldWarnRootNoSandbox =
    platform === "linux" &&
    managedProfiles.length > 0 &&
    !resolved.noSandbox &&
    process.getuid?.() === 0;

  if (missingExecutableProfiles.length > 0) {
    const executableRepairs = missingExecutableProfiles.map((profile) => {
      const configuredProfile = resolved.profiles[profile.name];
      const configKey = normalizeOptionalString(configuredProfile?.executablePath)
        ? `browser.profiles.${profile.name}.executablePath`
        : "browser.executablePath";
      return profile.executablePath
        ? `Correct ${configKey} to an existing browser executable, or remove it to use browser auto-detection.`
        : "Install Chrome, Chromium, Brave, or Edge, or set browser.executablePath to an existing browser executable.";
    });
    report(
      [
        `OpenClaw-managed browser profile(s) are configured: ${missingExecutableProfiles.map((profile) => profile.name).join(", ")}.`,
        missingExecutableProfiles.some((profile) => profile.executablePath)
          ? "A configured browser executable could not be used for OpenClaw-managed launch."
          : "No Chromium-based browser executable was found on this host for OpenClaw-managed launch.",
        ...executableErrors.values(),
      ].join("\n"),
      "fix-now",
      [...new Set(executableRepairs)].join("\n"),
    );
  }

  if (missingDisplay.length > 0 || shouldWarnRootNoSandbox) {
    const lines = [`OpenClaw-managed browser profile(s) are configured: ${managedProfileLabel}.`];
    if (missingDisplay.length > 0) {
      lines.push(
        ...(missingDisplay.every((error) => error.headlessSource === "config")
          ? [
              "No DISPLAY or WAYLAND_DISPLAY is set, and browser.headless is false. Managed browser launch needs a desktop session, Xvfb, or browser.headless: true.",
            ]
          : missingDisplay.map((error) => `${error.message}`)),
      );
    }
    if (shouldWarnRootNoSandbox) {
      lines.push(
        "The Gateway is running as root and browser.noSandbox is false. Chromium commonly requires browser.noSandbox: true in container/root runtimes.",
      );
    }
    report(
      lines.join("\n"),
      "fix-now",
      "Run the Gateway as a non-root user where possible. Provide a desktop session or set browser.headless=true for managed launch; in a trusted root container, explicitly configure browser.noSandbox=true if required.",
      "https://docs.openclaw.ai/tools/browser-linux-troubleshooting",
    );
  }

  if (profiles.length === 0) {
    return findings;
  }

  const explicitProfiles = profiles.filter((profile) => profile.userDataDir);
  const autoConnectProfiles = profiles.filter((profile) => !profile.userDataDir);
  const profileLabel = profiles.map((profile) => profile.name).join(", ");
  const autoConnect = autoConnectProfiles.length > 0;
  const chrome = autoConnect ? resolveGoogleChromeExecutableForPlatform(platform) : null;
  let category: NonNullable<HealthFinding["category"]> = "recommended";
  const lines = [`Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`];

  if (!autoConnect) {
    lines.push(
      "These profiles use an explicit Chromium user data directory instead of Chrome's default auto-connect path.",
      `Verify the matching Chromium-based browser is version ${CHROME_MCP_MIN_MAJOR}+ on the same host as the Gateway or node.`,
    );
  } else if (!chrome) {
    category = "fix-now";
    const autoProfileLabel = autoConnectProfiles.map((profile) => profile.name).join(", ");
    lines.push(
      `Google Chrome was not found on this host for auto-connect profile(s): ${autoProfileLabel}. OpenClaw does not bundle Chrome.`,
      `Install Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on the same host as the Gateway or node, or set browser.profiles.<name>.userDataDir for a different Chromium-based browser.`,
    );
  } else {
    const versionRaw = readBrowserVersion(chrome.path);
    const major = parseBrowserMajorVersion(versionRaw);
    lines.push(`Chrome path: ${chrome.path}`);
    if (!versionRaw || major === null) {
      category = "fix-now";
      lines.push(
        `Could not determine the installed Chrome version. Chrome MCP requires Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on this host.`,
      );
    } else if (major < CHROME_MCP_MIN_MAJOR) {
      category = "fix-now";
      lines.push(
        `Detected Chrome ${versionRaw}, which is too old for Chrome MCP existing-session attach. Upgrade to Chrome ${CHROME_MCP_MIN_MAJOR}+.`,
      );
    } else {
      lines.push(`Detected Chrome ${versionRaw}.`);
    }
  }

  lines.push(
    `Enable remote debugging in ${autoConnect ? "the browser inspect page" : "that browser's inspect page"} (${REMOTE_DEBUGGING_PAGES}).`,
    "Keep the browser running and accept the attach consent prompt the first time OpenClaw connects.",
  );
  if (autoConnect && !chrome) {
    lines.push(
      "Docker, headless, and sandbox browser flows stay on raw CDP; this check only applies to host-local Chrome MCP attach.",
    );
  }
  if (autoConnect && explicitProfiles.length > 0) {
    lines.push(
      `Profiles with explicit userDataDir ${chrome ? "still need manual validation of the matching Chromium-based browser" : "skip Chrome auto-detection"}: ${explicitProfiles
        .map((profile) => profile.name)
        .join(", ")}.`,
    );
  }

  report(
    lines.join("\n"),
    category,
    `Use Chromium ${CHROME_MCP_MIN_MAJOR}+ on the Gateway or node host, enable remote debugging (${REMOTE_DEBUGGING_PAGES}), and accept the first attach consent.${category === "recommended" ? " No action needed if existing-session attach already works." : ""}`,
    "https://docs.openclaw.ai/tools/browser/existing-session",
  );
  return findings;
}
