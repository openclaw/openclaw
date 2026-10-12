import type { Command } from "commander";
import { redactCdpUrl } from "openclaw/plugin-sdk/browser-cdp";
import { inheritOptionFromParent } from "openclaw/plugin-sdk/cli-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { danger, defaultRuntime, info } from "openclaw/plugin-sdk/runtime-env";
import { shortenHomePath } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatBrowserGraphicsSummary } from "../browser/chrome.graphics.js";
import type {
  BrowserCreateProfileResult,
  BrowserDeleteProfileResult,
  BrowserImportProfileResult,
  BrowserResetProfileResult,
  BrowserStatus,
  BrowserTab,
  ProfileStatus,
  SystemProfileInfo,
} from "../browser/client.js";
import type { BrowserDoctorReport } from "../browser/doctor.js";
import type { NativeBrowserPolicyReport } from "../browser/native-policy.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  callBrowserRequest,
  parseBrowserPositiveIntegerOption,
  printBrowserList,
  printBrowserJsonResult as printJsonResult,
  resolveBrowserProfileQuery as resolveProfileQuery,
  runBrowserCliCommand as runBrowserCommand,
  runBrowserCliRequest,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";

const BROWSER_MANAGE_REQUEST_TIMEOUT_MS = 45_000;

function resolveBrowserManagementTimeout(
  command: Command,
  fallbackMs = BROWSER_MANAGE_REQUEST_TIMEOUT_MS,
): number {
  // Management budgets replace Commander's default, never an operator's authored timeout.
  const timeout = inheritOptionFromParent<string>(command, "timeout", "cli");
  return timeout === undefined
    ? fallbackMs
    : parseBrowserPositiveIntegerOption(timeout, "--timeout");
}

type BrowserDoctorCheck = {
  name: string;
  ok: boolean;
  detail?: string;
  warning?: boolean;
  info?: boolean;
};

function sanitizeTableCell(value: string): string {
  // Strip C0/C1 control characters (Unicode Cc) so profile names cannot inject
  // terminal escapes into the printed table.
  return value.replace(/\p{Cc}/gu, " ");
}

async function fetchBrowserManagement<T>(
  command: Command,
  parent: BrowserParentOpts,
  path: string,
  query?: Parameters<typeof callBrowserRequest>[1]["query"],
): Promise<T> {
  return await callBrowserRequest<T>(
    parent,
    { method: "GET", path, query },
    { timeoutMs: resolveBrowserManagementTimeout(command) },
  );
}

async function runBrowserToggle(
  command: Command,
  parent: BrowserParentOpts,
  params: {
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
  },
) {
  const profile = parent.browserProfile;
  await callBrowserRequest(parent, {
    method: "POST",
    path: params.path,
    query: resolveProfileQuery(profile, params.query),
  });
  const status = await fetchBrowserManagement<BrowserStatus>(
    command,
    parent,
    "/",
    resolveProfileQuery(profile),
  );
  if (printJsonResult(parent, status)) {
    return;
  }
  const name = status.profile ?? "openclaw";
  const headlessLabel = params.path === "/start" && status.headless ? " (headless)" : "";
  defaultRuntime.log(info(`🦞 browser [${name}] running: ${status.running}${headlessLabel}`));
}

function parseTabIndex(value: string): number {
  return parseStrictPositiveInteger(value) ?? Number.NaN;
}

function logBrowserTabs(tabs: BrowserTab[]) {
  printBrowserList(tabs, "No tabs (browser closed or no targets).", (t, i) => {
    const labelHandle = t.label ? `label:${t.label}` : undefined;
    const suggested = t.suggestedTargetId ? `use: ${t.suggestedTargetId}` : undefined;
    const handles = [suggested, t.tabId ? `tab: ${t.tabId}` : undefined, labelHandle]
      .filter(Boolean)
      .join(" ");
    return `${i + 1}. ${t.title || "(untitled)"}${handles ? ` [${handles}]` : ""}\n   ${t.url}\n   id: ${t.targetId}`;
  });
}

function formatDoctorLine(check: BrowserDoctorCheck): string {
  const prefix = check.warning ? "WARN" : check.info ? "INFO" : check.ok ? "OK" : "FAIL";
  return `${prefix} ${check.name}${check.detail ? `: ${check.detail}` : ""}`;
}

function formatBrowserDoctorGatewayError(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "GatewaySecretRefUnavailableError" ||
      (error as Error & { code?: unknown }).code === "GATEWAY_SECRET_REF_UNAVAILABLE")
  ) {
    return "Gateway auth SecretRef is unavailable in this command path; browser doctor cannot reach the admin-scoped browser.request endpoint. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD, then retry.";
  }
  return String(error);
}

async function runBrowserDoctor(
  command: Command,
  parent: BrowserParentOpts,
  profile?: string,
  deep?: boolean,
) {
  const checks: BrowserDoctorCheck[] = [];
  const probe = async (name: string, read: () => Promise<Omit<BrowserDoctorCheck, "name">>) => {
    try {
      checks.push({ name, ...(await read()) });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error) });
    }
  };
  let report: BrowserDoctorReport;

  try {
    report = await fetchBrowserManagement<BrowserDoctorReport>(
      command,
      parent,
      "/doctor",
      resolveProfileQuery(profile),
    );
    checks.push({
      name: "gateway",
      ok: true,
      detail: "browser control endpoint reachable",
    });
  } catch (err) {
    checks.push({
      name: "gateway",
      ok: false,
      detail: formatBrowserDoctorGatewayError(err),
    });
    return { ok: false, checks };
  }

  const status = report.status;
  checks.push({
    name: "plugin",
    ok: status.enabled,
    detail: status.enabled ? "enabled" : "disabled in config",
  });
  checks.push({
    name: "profile",
    ok: true,
    detail: `${status.profile ?? "openclaw"} (${usesChromeMcpTransport(status) ? "chrome-mcp" : (status.transport ?? "cdp")})`,
  });
  checks.push({
    name: "browser",
    ok: status.running,
    detail: status.running
      ? `running${status.cdpReady === false ? ", CDP not ready" : ""}`
      : "not running; run `openclaw browser start`",
  });
  const extensionVersionCheck = report.checks.find((check) => check.id === "extension-version");
  if (extensionVersionCheck) {
    checks.push({
      name: extensionVersionCheck.id,
      ok: extensionVersionCheck.status !== "fail",
      warning: extensionVersionCheck.status === "warn",
      info: extensionVersionCheck.status === "info",
      detail: `${extensionVersionCheck.summary}${extensionVersionCheck.fixHint ? `; ${extensionVersionCheck.fixHint}` : ""}`,
    });
  }
  if (status.graphics) {
    checks.push({
      name: "graphics",
      ok: true,
      warning: status.graphics.status === "unavailable",
      detail: formatBrowserGraphicsSummary(status.graphics),
    });
  }

  await probe("profiles", async () => {
    const profiles = await fetchBrowserManagement<{ profiles: ProfileStatus[] }>(
      command,
      parent,
      "/profiles",
    );
    return {
      ok: true,
      detail: `${profiles.profiles?.length ?? 0} configured`,
    };
  });

  if (status.running) {
    await probe("tabs", async () => {
      const result = await fetchBrowserManagement<{ running: boolean; tabs: BrowserTab[] }>(
        command,
        parent,
        "/tabs",
        resolveProfileQuery(profile),
      );
      const tabs = result.tabs ?? [];
      return {
        ok: true,
        detail: `${tabs.length} visible${tabs.length > 0 && tabs[0]?.suggestedTargetId ? `, use tab reference ${tabs[0].suggestedTargetId}` : ""}`,
      };
    });
  }

  if (deep && status.running) {
    await probe("native-policy", async () => {
      const policy = await fetchBrowserManagement<NativeBrowserPolicyReport>(
        command,
        parent,
        "/policy",
        resolveProfileQuery(profile),
      );
      return {
        ok: policy.state !== "failed",
        info: policy.state === "unsupported" || policy.state === "unverified",
        detail:
          "policies" in policy
            ? `${policy.browser}: ${Object.keys(policy.policies).length} loaded entries; run openclaw browser policy --json for native diagnostics`
            : policy.detail,
      };
    });
    await probe("live-snapshot", async () => {
      // Keep the diagnostic snapshot bounded independently of management request budgets.
      const result = await callBrowserRequest<
        | { ok: true; format: "aria"; nodes?: unknown[] }
        | { ok: true; format: "ai"; snapshot?: string }
      >(
        parent,
        {
          method: "GET",
          path: "/snapshot",
          query: resolveProfileQuery(profile, { format: "aria", limit: 25 }),
        },
        { timeoutMs: 10_000 },
      );
      const count =
        result.format === "aria"
          ? Array.isArray(result.nodes)
            ? result.nodes.length
            : 0
          : typeof result.snapshot === "string"
            ? result.snapshot.split("\n").length
            : 0;
      return {
        ok: count > 0,
        detail: count > 0 ? `${count} nodes/lines` : "snapshot returned no content",
      };
    });
  }

  return { ok: checks.every((check) => check.ok), checks, status };
}

function usesChromeMcpTransport(params: Pick<BrowserStatus, "transport" | "driver">): boolean {
  return params.transport === "chrome-mcp" || params.driver === "existing-session";
}

function formatBrowserConnectionSummary(
  params: Partial<
    Pick<BrowserStatus, "transport" | "driver" | "cdpPort" | "cdpUrl" | "userDataDir">
  > & { isRemote?: boolean },
): string {
  if (usesChromeMcpTransport(params)) {
    if (params.cdpUrl) {
      return `transport: chrome-mcp, cdpUrl: ${redactCdpUrl(params.cdpUrl)}`;
    }
    const userDataDir = params.userDataDir ? shortenHomePath(params.userDataDir) : null;
    return userDataDir
      ? `transport: chrome-mcp, userDataDir: ${userDataDir}`
      : "transport: chrome-mcp";
  }
  if (params.transport === "extension" || params.driver === "extension") {
    return `transport: extension, relayPort: ${params.cdpPort ?? "(unset)"}`;
  }
  if (params.isRemote) {
    return `cdpUrl: ${params.cdpUrl ? redactCdpUrl(params.cdpUrl) : "(unset)"}`;
  }
  return `port: ${params.cdpPort ?? "(unset)"}`;
}

export function registerBrowserManageCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const runManagementRequest = <T = unknown>(
    command: Command,
    params: Omit<Parameters<typeof runBrowserCliRequest<T>>[0], "parent" | "timeoutMs">,
  ) =>
    runBrowserCliRequest<T>({
      parent: parentOpts(command),
      ...params,
      timeoutMs: resolveBrowserManagementTimeout(command),
    });

  browser
    .command("status")
    .description("Show browser status")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCommand(async () => {
        const status = await fetchBrowserManagement<BrowserStatus>(
          cmd,
          parent,
          "/",
          resolveProfileQuery(parent?.browserProfile),
        );
        if (printJsonResult(parent, status)) {
          return;
        }
        const detectedPath = status.detectedExecutablePath ?? status.executablePath;
        const detectedDisplay = detectedPath ? shortenHomePath(detectedPath) : "auto";
        defaultRuntime.log(
          [
            `profile: ${status.profile ?? "openclaw"}`,
            `enabled: ${status.enabled}`,
            `running: ${status.running}`,
            `transport: ${
              usesChromeMcpTransport(status) ? "chrome-mcp" : (status.transport ?? "cdp")
            }`,
            ...(!usesChromeMcpTransport(status)
              ? [
                  `cdpPort: ${status.cdpPort ?? "(unset)"}`,
                  `cdpUrl: ${redactCdpUrl(status.cdpUrl ?? `http://127.0.0.1:${status.cdpPort}`)}`,
                ]
              : status.cdpUrl
                ? [`cdpUrl: ${redactCdpUrl(status.cdpUrl)}`]
                : status.userDataDir
                  ? [`userDataDir: ${shortenHomePath(status.userDataDir)}`]
                  : []),
            `browser: ${status.chosenBrowser ?? "unknown"}`,
            `detectedBrowser: ${status.detectedBrowser ?? "unknown"}`,
            `detectedPath: ${detectedDisplay}`,
            `headless: ${status.headless}${
              status.headlessSource ? ` (${status.headlessSource})` : ""
            }`,
            `profileColor: ${status.color}`,
            ...(status.nativePolicy
              ? [`nativePolicy: ${status.nativePolicy.state}; ${status.nativePolicy.detail}`]
              : []),
            ...(status.graphics
              ? [`graphics: ${formatBrowserGraphicsSummary(status.graphics)}`]
              : []),
            ...(status.detectError ? [`detectError: ${status.detectError}`] : []),
          ].join("\n"),
        );
      });
    });

  browser
    .command("doctor")
    .description("Check browser plugin readiness")
    .option("--deep", "Inspect native enterprise policy and run a live snapshot check")
    .action(async (opts: { deep?: boolean }, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await runBrowserDoctor(cmd, parent, profile, opts.deep === true);
        if (!printJsonResult(parent, result)) {
          defaultRuntime.log(result.checks.map(formatDoctorLine).join("\n"));
        }
        if (!result.ok) {
          process.exitCode = 1;
        }
      });
    });

  for (const [action, description] of [
    ["start", "Start the browser (no-op if already running)"],
    ["stop", "Stop the browser (best-effort)"],
  ] as const) {
    const command = browser.command(action).description(description);
    if (action === "start") {
      command.option("--headless", "Launch a local managed browser headless for this start");
    }
    command.action(async (opts: { headless?: boolean }, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCommand(async () => {
        await runBrowserToggle(cmd, parent, {
          path: `/${action}`,
          query: action === "start" && opts.headless ? { headless: true } : undefined,
        });
      });
    });
  }

  browser
    .command("reset-profile")
    .description("Reset browser profile (moves it to Trash)")
    .action(async (_opts, cmd) => {
      await runBrowserCliRequest<BrowserResetProfileResult>({
        parent: parentOpts(cmd),
        path: "/reset-profile",
        print: (result) => {
          if (!result.moved) {
            defaultRuntime.log(info(`🦞 browser profile already missing.`));
            return;
          }
          const dest = result.to ?? result.from;
          defaultRuntime.log(info(`🦞 browser profile moved to Trash (${dest})`));
        },
      });
    });

  browser
    .command("tabs")
    .description("List open tabs")
    .action(async (_opts, cmd) => {
      await runManagementRequest<{ tabs: BrowserTab[] }>(cmd, {
        method: "GET",
        path: "/tabs",
        json: (result) => ({ tabs: result.tabs ?? [] }),
        print: (result) => logBrowserTabs(result.tabs ?? []),
      });
    });

  const tab = browser
    .command("tab")
    .description("Tab shortcuts (index-based)")
    .action(async (_opts, cmd) => {
      await runManagementRequest<{ tabs: BrowserTab[] }>(cmd, {
        path: "/tabs/action",
        body: { action: "list" },
        json: (result) => ({ tabs: result.tabs ?? [] }),
        print: (result) => logBrowserTabs(result.tabs ?? []),
      });
    });

  tab
    .command("new")
    .description("Open a new tab (about:blank)")
    .option("--label <label>", "Assign a friendly tab label")
    .action(async (opts: { label?: string }, cmd) => {
      await runManagementRequest<{ tab?: BrowserTab }>(cmd, {
        path: "/tabs/action",
        body: { action: "new", label: opts.label },
        successMessage: ({ tab: opened }) =>
          opened?.tabId
            ? `opened new tab ${opened.tabId}${opened.label ? ` (${opened.label})` : ""}`
            : "opened new tab",
      });
    });

  tab
    .command("label")
    .description("Assign a friendly label to a tab")
    .argument("<targetId>", BROWSER_TAB_REFERENCE_HELP)
    .argument("<label>", "Friendly label")
    .action(async (targetId: string, label: string, _opts, cmd) => {
      await runManagementRequest<{ tab?: BrowserTab }>(cmd, {
        path: "/tabs/action",
        body: { action: "label", targetId, label },
        successMessage: ({ tab: tabValue }) =>
          `labeled tab ${tabValue?.tabId ?? targetId} as ${tabValue?.label ?? label}`,
      });
    });

  for (const [action, description, argument] of [
    ["select", "Focus tab by index (1-based)", "<index>"],
    ["close", "Close tab by index (1-based); default: first tab", "[index]"],
  ] as const) {
    tab
      .command(action)
      .description(description)
      .argument(argument, "Tab index (1-based)", parseTabIndex)
      .action(async (index: number | undefined, _opts, cmd) => {
        const parent = parentOpts(cmd);
        if (index !== undefined && (!Number.isSafeInteger(index) || index < 1)) {
          defaultRuntime.error(danger("index must be a positive integer"));
          defaultRuntime.exit(1);
          return;
        }
        await runBrowserCliRequest({
          parent,
          path: "/tabs/action",
          body: { action, index: index === undefined ? undefined : index - 1 },
          timeoutMs: resolveBrowserManagementTimeout(cmd),
          successMessage: action === "select" ? `selected tab ${index}` : "closed tab",
        });
      });
  }

  browser
    .command("open")
    .description("Open a URL in a new tab")
    .argument("<url>", "URL to open")
    .option("--label <label>", "Assign a friendly tab label")
    .action(async (url: string, opts: { label?: string }, cmd) => {
      await runManagementRequest<BrowserTab>(cmd, {
        path: "/tabs/open",
        body: { url, ...(opts.label ? { label: opts.label } : {}) },
        successMessage: (tabLocal) =>
          `opened: ${tabLocal.url}\n${tabLocal.tabId ? `tab: ${tabLocal.tabId}\n` : ""}${tabLocal.label ? `label: ${tabLocal.label}\n` : ""}id: ${tabLocal.targetId}`,
      });
    });

  browser
    .command("focus")
    .description("Focus a tab by tab reference")
    .argument("<targetId>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (targetId: string, _opts, cmd) => {
      await runManagementRequest(cmd, {
        path: "/tabs/focus",
        body: { targetId },
        json: () => ({ ok: true }),
        successMessage: `focused tab ${targetId}`,
      });
    });

  browser
    .command("close")
    .description("Close a tab (tab reference optional)")
    .argument("[targetId]", `${BROWSER_TAB_REFERENCE_HELP} (optional)`)
    .action(async (targetId: string | undefined, _opts, cmd) => {
      const target = targetId?.trim();
      await runManagementRequest(cmd, {
        method: target ? "DELETE" : "POST",
        path: target ? `/tabs/${encodeURIComponent(target)}` : "/act",
        body: target ? undefined : { kind: "close" },
        json: () => ({ ok: true }),
        successMessage: "closed tab",
      });
    });

  browser
    .command("profiles")
    .description("List all browser profiles")
    .action(async (_opts, cmd) => {
      await runManagementRequest<{ profiles: ProfileStatus[] }>(cmd, {
        profile: null,
        method: "GET",
        path: "/profiles",
        json: (result) => ({ profiles: result.profiles ?? [] }),
        print: (result) =>
          printBrowserList(result.profiles ?? [], "No profiles configured.", (p) => {
            const status = p.running ? "running" : "stopped";
            const tabs = p.running ? ` (${p.tabCount} tabs)` : "";
            const def = p.isDefault ? " [default]" : "";
            const loc = formatBrowserConnectionSummary(p);
            const remote = p.isRemote ? " [remote]" : "";
            const driver = p.driver !== "openclaw" ? ` [${p.driver}]` : "";
            return `${p.name}: ${status}${tabs}${def}${remote}${driver}\n  ${loc}, color: ${p.color}`;
          }),
      });
    });

  browser
    .command("system-profiles")
    .description("List Chrome-family profiles available for cookie import")
    .option("--browser <browser>", "System browser (chrome|brave|edge|chromium); omit to list all")
    .action(async (opts: { browser?: string }, cmd) => {
      await runManagementRequest<{ systemProfiles: SystemProfileInfo[] }>(cmd, {
        profile: null,
        method: "GET",
        path: "/system-profiles",
        query: opts.browser ? { browser: opts.browser } : undefined,
        json: (result) => ({ systemProfiles: result.systemProfiles ?? [] }),
        print: (result) =>
          printBrowserList(
            result.systemProfiles ?? [],
            "No system browser profiles found.",
            (profile) =>
              [profile.browser, profile.id, profile.name, profile.hasCookies ? "yes" : "no"]
                .map(sanitizeTableCell)
                .join("\t"),
            "browser\tid\tname\thasCookies",
          ),
      });
    });

  browser
    .command("import-profile")
    .description("Import cookies from a macOS Chrome-family profile")
    .option("--browser <browser>", "System browser (chrome|brave|edge|chromium)", "chrome")
    .option("--system <profile>", "System profile directory", "Default")
    .option("--into <profile>", "Managed target profile", "imported")
    .option("--domains <domains>", "Comma-separated domain filter")
    .action(
      async (opts: { browser: string; system: string; into: string; domains?: string }, cmd) => {
        const domains = opts.domains
          ?.split(",")
          .map((domain) => domain.trim())
          .filter(Boolean);
        await runBrowserCliRequest<BrowserImportProfileResult>({
          parent: parentOpts(cmd),
          profile: null,
          path: "/profiles/import",
          body: {
            browser: opts.browser,
            systemProfile: opts.system,
            into: opts.into,
            domains,
          },
          timeoutMs: resolveBrowserManagementTimeout(cmd, 120_000),
          successMessage: (result) =>
            info(
              `Imported cookies into "${result.into}": ${result.cookies.imported}/${result.cookies.total} imported, ${result.cookies.failed} failed, ${result.cookies.skipped} skipped; ${result.domains.length} domains`,
            ),
        });
      },
    );

  browser
    .command("create-profile")
    .description("Create a new browser profile")
    .requiredOption("--name <name>", "Profile name (lowercase, numbers, hyphens)")
    .option("--color <hex>", "Profile color (hex format, e.g. #0066CC)")
    .option("--cdp-url <url>", "DevTools endpoint URL (http/https/ws/wss)")
    .option("--user-data-dir <path>", "User data dir for existing-session Chromium attach")
    .option("--driver <driver>", "Profile driver (openclaw|existing-session). Default: openclaw")
    .action(
      async (
        opts: {
          name: string;
          color?: string;
          cdpUrl?: string;
          userDataDir?: string;
          driver?: string;
        },
        cmd,
      ) => {
        const parent = parentOpts(cmd);
        await runBrowserCommand(async () => {
          if (
            opts.driver !== undefined &&
            opts.driver !== "openclaw" &&
            opts.driver !== "existing-session"
          ) {
            throw new Error("--driver must be openclaw or existing-session");
          }
          const result = await callBrowserRequest<BrowserCreateProfileResult>(parent, {
            method: "POST",
            path: "/profiles/create",
            body: {
              name: opts.name,
              color: opts.color,
              cdpUrl: opts.cdpUrl,
              userDataDir: opts.userDataDir,
              driver: opts.driver === "existing-session" ? "existing-session" : undefined,
            },
          });
          if (printJsonResult(parent, result)) {
            return;
          }
          const loc = `  ${formatBrowserConnectionSummary(result)}`;
          defaultRuntime.log(
            info(
              `🦞 Created profile "${result.profile}"\n${loc}\n  color: ${result.color}${
                result.userDataDir ? `\n  userDataDir: ${shortenHomePath(result.userDataDir)}` : ""
              }${opts.driver === "existing-session" ? "\n  driver: existing-session" : ""}`,
            ),
          );
        });
      },
    );

  browser
    .command("delete-profile")
    .description("Delete a browser profile")
    .requiredOption("--name <name>", "Profile name to delete")
    .action(async (opts: { name: string }, cmd) => {
      await runBrowserCliRequest<BrowserDeleteProfileResult>({
        parent: parentOpts(cmd),
        profile: null,
        method: "DELETE",
        path: `/profiles/${encodeURIComponent(opts.name)}`,
        successMessage: (result) =>
          info(
            result.deleted
              ? `🦞 Deleted profile "${result.profile}" (user data removed)`
              : `🦞 Deleted profile "${result.profile}" (user data removal not confirmed)`,
          ),
      });
    });
}
