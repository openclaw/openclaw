import fs from "node:fs";
import path from "node:path";
import { formatCliCommand, note } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

export async function noteChromeMcpBrowserReadiness(
  cfg: OpenClawConfig,
  deps?: {
    platform?: NodeJS.Platform;
    noteFn?: typeof note;
    env?: NodeJS.ProcessEnv;
    getUid?: () => number;
    resolveManagedExecutable?: typeof resolveBrowserExecutableForPlatform;
    resolveChromeExecutable?: (platform: NodeJS.Platform) => { path: string } | null;
    readVersion?: (executablePath: string) => string | null;
    configDir?: string;
  },
) {
  const noteFn = deps?.noteFn ?? note;
  const platform = deps?.platform ?? process.platform;
  const env = deps?.env ?? process.env;
  const getUid = deps?.getUid ?? (() => process.getuid?.() ?? -1);
  const resolveManagedExecutable =
    deps?.resolveManagedExecutable ?? resolveBrowserExecutableForPlatform;
  const resolveChromeExecutable =
    deps?.resolveChromeExecutable ?? resolveGoogleChromeExecutableForPlatform;
  const readVersion = deps?.readVersion ?? readBrowserVersion;
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const { managed: managedProfiles, chromeMcp: profiles } = collectBrowserDoctorProfiles(
    cfg,
    resolved,
  );
  const managedProfileLabel = managedProfiles.map((profile) => profile.name).join(", ");
  if (resolved.enabled && resolved.extensionRelay.allowLegacyAuth) {
    noteFn(
      [
        "- Legacy Browser Relay Authentication is enabled (browser.extensionRelay.allowLegacyAuth=true).",
        "- Update paired Chrome extensions and external CDP clients to Browser Relay Authentication v2, then set browser.extensionRelay.allowLegacyAuth=false.",
        "- V2 clients never downgrade to legacy authentication.",
      ].join("\n"),
      "Browser relay authentication",
    );
  }
  const extensionStateDir = deps?.configDir ?? CONFIG_DIR;
  const extensionCopyPath = path.join(extensionStateDir, "browser", "chrome-extension");
  // General Doctor also runs unattended inside the Gateway. Profile discovery can
  // block on OS permission prompts, so leave it to explicit browser commands.
  if (fs.existsSync(extensionCopyPath)) {
    noteFn(
      [
        "- Chrome extension native bootstrap was not inspected; registration status is unavailable in Doctor.",
        `- Run ${formatCliCommand("openclaw browser extension status --json")} to inspect it explicitly; this may request browser profile access.`,
        `- Run ${formatCliCommand("openclaw browser extension install")} if setup or repair is needed.`,
      ].join("\n"),
      "Browser extension bootstrap",
    );
  }
  if (platform === "darwin") {
    const importEnabled = cfg.browser?.allowSystemProfileImport !== false;
    noteFn(
      [
        `- System browser profile cookie import is ${importEnabled ? "enabled" : "disabled"} (browser.allowSystemProfileImport).`,
        "- System browser profile discovery skipped by Doctor; importable cookie database count is unavailable.",
        "- Doctor does not access the macOS Keychain; importing asks for consent separately.",
      ].join("\n"),
      "Browser",
    );
  }
  const managedExecutables = new Map<
    string | undefined,
    ReturnType<typeof resolveManagedExecutable>
  >();
  const missingExecutableProfiles = managedProfiles.filter((profile) => {
    const executablePath = profile.executablePath;
    if (!managedExecutables.has(executablePath)) {
      managedExecutables.set(
        executablePath,
        resolveManagedExecutable({ ...resolved, executablePath }, platform),
      );
    }
    return !managedExecutables.get(executablePath);
  });
  const missingDisplay = managedProfiles
    .map((profile) => getManagedBrowserMissingDisplayError(resolved, profile, { platform, env }))
    .filter((error) => error !== null);
  const shouldWarnRootNoSandbox =
    platform === "linux" && managedProfiles.length > 0 && !resolved.noSandbox && getUid() === 0;

  if (missingExecutableProfiles.length > 0) {
    noteFn(
      [
        `- OpenClaw-managed browser profile(s) are configured: ${missingExecutableProfiles.map((profile) => profile.name).join(", ")}.`,
        "- No Chromium-based browser executable was found on this host for OpenClaw-managed launch.",
        "- Install Chrome, Chromium, Brave, Edge, or set browser.executablePath explicitly.",
      ].join("\n"),
      "Browser",
    );
  }

  if (missingDisplay.length > 0 || shouldWarnRootNoSandbox) {
    const lines = [`- OpenClaw-managed browser profile(s) are configured: ${managedProfileLabel}.`];
    if (missingDisplay.length > 0) {
      lines.push(
        ...(missingDisplay.every((error) => error.headlessSource === "config")
          ? [
              "- No DISPLAY or WAYLAND_DISPLAY is set, and browser.headless is false. Managed browser launch needs a desktop session, Xvfb, or browser.headless: true.",
            ]
          : missingDisplay.map((error) => `- ${error.message}`)),
      );
    }
    if (shouldWarnRootNoSandbox) {
      lines.push(
        "- The Gateway is running as root and browser.noSandbox is false. Chromium commonly requires browser.noSandbox: true in container/root runtimes.",
      );
    }
    noteFn(lines.join("\n"), "Browser");
  }

  if (profiles.length === 0) {
    return;
  }

  const explicitProfiles = profiles.filter((profile) => profile.userDataDir);
  const autoConnectProfiles = profiles.filter((profile) => !profile.userDataDir);
  const profileLabel = profiles.map((profile) => profile.name).join(", ");

  if (autoConnectProfiles.length === 0) {
    noteFn(
      [
        `- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
        "- These profiles use an explicit Chromium user data directory instead of Chrome's default auto-connect path.",
        `- Verify the matching Chromium-based browser is version ${CHROME_MCP_MIN_MAJOR}+ on the same host as the Gateway or node.`,
        `- Enable remote debugging in that browser's inspect page (${REMOTE_DEBUGGING_PAGES}).`,
        "- Keep the browser running and accept the attach consent prompt the first time OpenClaw connects.",
      ].join("\n"),
      "Browser",
    );
    return;
  }

  const chrome = resolveChromeExecutable(platform);
  const autoProfileLabel = autoConnectProfiles.map((profile) => profile.name).join(", ");

  if (!chrome) {
    const lines = [
      `- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
      `- Google Chrome was not found on this host for auto-connect profile(s): ${autoProfileLabel}. OpenClaw does not bundle Chrome.`,
      `- Install Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on the same host as the Gateway or node, or set browser.profiles.<name>.userDataDir for a different Chromium-based browser.`,
      `- Enable remote debugging in the browser inspect page (${REMOTE_DEBUGGING_PAGES}).`,
      "- Keep the browser running and accept the attach consent prompt the first time OpenClaw connects.",
      "- Docker, headless, and sandbox browser flows stay on raw CDP; this check only applies to host-local Chrome MCP attach.",
    ];
    if (explicitProfiles.length > 0) {
      lines.push(
        `- Profiles with explicit userDataDir skip Chrome auto-detection: ${explicitProfiles
          .map((profile) => profile.name)
          .join(", ")}.`,
      );
    }
    noteFn(lines.join("\n"), "Browser");
    return;
  }

  const versionRaw = readVersion(chrome.path);
  const major = parseBrowserMajorVersion(versionRaw);
  const lines = [
    `- Chrome MCP existing-session is configured for profile(s): ${profileLabel}.`,
    `- Chrome path: ${chrome.path}`,
  ];

  if (!versionRaw || major === null) {
    lines.push(
      `- Could not determine the installed Chrome version. Chrome MCP requires Google Chrome ${CHROME_MCP_MIN_MAJOR}+ on this host.`,
    );
  } else if (major < CHROME_MCP_MIN_MAJOR) {
    lines.push(
      `- Detected Chrome ${versionRaw}, which is too old for Chrome MCP existing-session attach. Upgrade to Chrome ${CHROME_MCP_MIN_MAJOR}+.`,
    );
  } else {
    lines.push(`- Detected Chrome ${versionRaw}.`);
  }

  lines.push(`- Enable remote debugging in the browser inspect page (${REMOTE_DEBUGGING_PAGES}).`);
  lines.push(
    "- Keep the browser running and accept the attach consent prompt the first time OpenClaw connects.",
  );
  if (explicitProfiles.length > 0) {
    lines.push(
      `- Profiles with explicit userDataDir still need manual validation of the matching Chromium-based browser: ${explicitProfiles
        .map((profile) => profile.name)
        .join(", ")}.`,
    );
  }

  noteFn(lines.join("\n"), "Browser");
}

/** Leave discovery-dependent native-host repair to explicit extension setup. */
export async function maybeRepairOwnedChromeExtensionNativeHosts(): Promise<{
  status: "skipped";
  reason: string;
  changes: string[];
  warnings: string[];
}> {
  return {
    status: "skipped",
    reason: "Doctor does not inspect personal browser profiles",
    changes: [],
    warnings: [
      `Chrome extension native-host repair skipped: Doctor does not inspect personal browser profiles. Run ${formatCliCommand("openclaw browser extension install")} to repair explicitly.`,
    ],
  };
}
