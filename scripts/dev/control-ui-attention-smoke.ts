import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import {
  chromium,
  devices,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright";
import {
  extractControlUiPairingRequestId,
  redactControlUiSmokeSecrets,
  resolveControlUiSmokeProfileDir,
  resolveControlUiSmokeUrl,
  type ControlUiSmokeUrl,
} from "./control-ui-smoke-url.js";

type SmokeProfileSummary = {
  persistent: boolean;
  dir?: string;
  clientDisplayName: string;
  autoApprovePairing: boolean;
  pairingApproved: boolean;
  pairingRequestId?: string;
};

type SmokeSummary = {
  ok: boolean;
  url: string;
  auth: ControlUiSmokeUrl["auth"];
  authUrlClean: boolean;
  profile: SmokeProfileSummary;
  pwa: {
    manifest: boolean;
    serviceWorker: boolean;
    controlled: boolean;
  };
  verdict: string;
  summary: string;
  actionCards: number;
  ramFixture: string;
  learningVelocity: string;
  dataSources: string;
  customizationProtection: string;
  cronRecovery: string;
  brandLogo: string;
  kalshiSnapshot: string;
  consoleErrors: string[];
  pageErrors: string[];
};

type SmokeDiagnostics = {
  href?: string;
  tab?: string;
  agentsPanel?: string;
  connected?: boolean;
  kalshiDashboardLoading?: boolean;
  kalshiDashboardError?: string | null;
  kalshiDashboardLoaded?: boolean;
  rpcTimings?: unknown[];
  refreshEvents?: unknown[];
  bodyText?: string;
};

type PairingApprovalResult = {
  requestId: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
};

type PairingOutcome = {
  pairingApproved: boolean;
  requestId?: string;
};

type SmokeBrowserSession = {
  page: Page;
  close: () => Promise<void>;
  persistentProfile: boolean;
  profileDir?: string;
};

type SmokeClientMetadata = {
  displayName: string;
  deviceFamily: string;
  platform?: string;
};

function redactSmokeSecrets(value: string): string {
  return redactControlUiSmokeSecrets(value);
}

function envFlagEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(raw);
}

function autoApprovePairingEnabled(): boolean {
  return envFlagEnabled("OPENCLAW_CONTROL_UI_SMOKE_AUTO_APPROVE_PAIRING", true);
}

function approvePairingRequest(requestId: string): PairingApprovalResult {
  const result = spawnSync("pnpm", ["openclaw", "devices", "approve", requestId, "--json"], {
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 1024 * 1024 * 4,
  });
  return {
    requestId,
    ok: result.status === 0,
    stdout: redactSmokeSecrets(result.stdout ?? ""),
    stderr: redactSmokeSecrets(result.stderr ?? ""),
    status: result.status,
    error: result.error?.message,
  };
}

function localChromeCandidates(): string[] {
  if (platform() === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (platform() === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}

function resolveBrowserExecutable(): string | undefined {
  const explicit = process.env.OPENCLAW_CONTROL_UI_SMOKE_BROWSER?.trim();
  if (explicit) {
    return explicit;
  }
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) {
    return bundled;
  }
  return localChromeCandidates().find((candidate) => existsSync(candidate));
}

function useMobileSmokeProfile(): boolean {
  const raw = process.env.OPENCLAW_CONTROL_UI_SMOKE_MOBILE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on" || raw === "iphone";
}

function resolveSmokeClientMetadata(mobile: boolean): SmokeClientMetadata {
  const label = process.env.OPENCLAW_CONTROL_UI_SMOKE_DEVICE_NAME?.trim();
  return {
    displayName: label || `OpenClaw smoke ${mobile ? "iPhone" : "desktop"} profile`,
    deviceFamily: "control-ui-smoke",
    ...(mobile ? { platform: "iPhone" } : {}),
  };
}

async function installSmokeClientMetadata(context: BrowserContext, metadata: SmokeClientMetadata) {
  await context.addInitScript((value) => {
    const key = "openclaw.controlUi.clientMetadata";
    const payload = JSON.stringify(value);
    localStorage.setItem(key, payload);
    Object.defineProperty(globalThis, "__OPENCLAW_CONTROL_UI_CLIENT_METADATA__", {
      value,
      configurable: true,
    });
  }, metadata);
}

function mobileSmokeContextOptions() {
  const device =
    devices["iPhone 15 Pro"] ??
    devices["iPhone 15"] ??
    devices["iPhone 14 Pro"] ??
    devices["iPhone 14"];
  return {
    ...device,
    viewport: device?.viewport ?? { width: 393, height: 852 },
    deviceScaleFactor: device?.deviceScaleFactor ?? 3,
    hasTouch: true,
    isMobile: true,
    userAgent:
      device?.userAgent ??
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  };
}

async function launchSmokeBrowserSession(options: {
  executablePath: string;
  contextOptions: BrowserContextOptions;
  profileDir: string | null;
  clientMetadata: SmokeClientMetadata;
}): Promise<SmokeBrowserSession> {
  if (options.profileDir) {
    mkdirSync(options.profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(options.profileDir, {
      ...options.contextOptions,
      headless: true,
      executablePath: options.executablePath,
    });
    await installSmokeClientMetadata(context, options.clientMetadata);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("about:blank").catch(() => undefined);
    return {
      page,
      close: () => context.close(),
      persistentProfile: true,
      profileDir: options.profileDir,
    };
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: options.executablePath,
  });
  const context = await browser.newContext(options.contextOptions);
  await installSmokeClientMetadata(context, options.clientMetadata);
  const page = await context.newPage();
  return {
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
    persistentProfile: false,
  };
}

async function resolveDashboardUrl(): Promise<ControlUiSmokeUrl> {
  return resolveControlUiSmokeUrl({
    explicitUrlEnvNames: ["OPENCLAW_CONTROL_UI_SMOKE_URL"],
  });
}

async function openAgentsWorkspace(page: Page, launchUrl: string): Promise<PairingOutcome> {
  const agentsUrl = new URL(launchUrl);
  const routeBase = agentsUrl.pathname.replace(/\/$/, "");
  if (!/\/agents$/i.test(routeBase)) {
    agentsUrl.pathname = `${routeBase === "" ? "" : routeBase}/agents`;
  }
  await page.goto(agentsUrl.toString(), { waitUntil: "domcontentloaded" });
  const pairing = await waitForConnectedOrApprovePairing(page);
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          agentsPanel?: string;
          requestUpdate?: () => void;
          setTab?: (tab: string) => void;
        })
      | null;
    if (app) {
      app.agentsPanel = "room";
      app.setTab?.("agents");
      app.requestUpdate?.();
    }
  });
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { tab?: string; agentsPanel?: string })
        | null;
      return app?.tab === "agents" && app?.agentsPanel === "room";
    },
    null,
    { timeout: 45_000 },
  );
  try {
    await page
      .getByText("Live Agent Workspace", { exact: true })
      .first()
      .waitFor({ timeout: 45_000 });
  } catch (err) {
    const diagnostics = await page.evaluate(() => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            tab?: string;
            agentsPanel?: string;
            connected?: boolean;
            agentsLoading?: boolean;
            agentsError?: string | null;
            agentsList?: { agents?: unknown[] } | null;
          })
        | null;
      return {
        href: window.location.href.replace(/#token=.*/, "#token=<redacted>"),
        tab: app?.tab,
        agentsPanel: app?.agentsPanel,
        connected: app?.connected,
        agentsLoading: app?.agentsLoading,
        agentsError: app?.agentsError ?? null,
        agentCount: app?.agentsList?.agents?.length ?? null,
        resources: performance
          .getEntriesByType("resource")
          .map((entry) => ({
            name: entry.name.replace(/#token=.*/, "#token=<redacted>"),
            duration: Math.round(entry.duration),
          }))
          .filter((entry) => /agents|index|assets/i.test(entry.name))
          .slice(-20),
        bodyText: (document.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1200),
      };
    });
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\nDiagnostics: ${JSON.stringify(diagnostics, null, 2)}`, {
      cause: err,
    });
  }
  await page.getByText("What Needs My Attention?", { exact: true }).waitFor({ timeout: 45_000 });
  return pairing;
}

async function waitForConnectedOrApprovePairing(page: Page): Promise<PairingOutcome> {
  const waitForConnected = () =>
    page.waitForFunction(
      () => {
        const app = document.querySelector("openclaw-app") as
          | (HTMLElement & { connected?: boolean })
          | null;
        return app?.connected === true;
      },
      null,
      { timeout: 45_000 },
    );
  try {
    await waitForConnected();
    return { pairingApproved: false };
  } catch (error) {
    const bodyText = (
      (await page
        .locator("body")
        .textContent()
        .catch(() => "")) ?? ""
    ).replace(/\s+/g, " ");
    const requestId = extractControlUiPairingRequestId(bodyText);
    if (!requestId || !autoApprovePairingEnabled()) {
      throw error;
    }
    const approval = approvePairingRequest(requestId);
    if (!approval.ok) {
      throw new Error(
        `Dashboard requested device pairing, but auto-approval failed: ${JSON.stringify(
          approval,
          null,
          2,
        )}`,
        { cause: error },
      );
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForConnected();
    return { pairingApproved: true, requestId };
  }
}

async function collectSummary(
  page: Page,
  smokeUrl: ControlUiSmokeUrl,
  profile: SmokeProfileSummary,
  consoleErrors: string[],
  pageErrors: string[],
): Promise<SmokeSummary> {
  const bodyText = (await page.locator("body").textContent({ timeout: 5_000 })) ?? "";
  const fatalText = ["Control UI assets not found", "unauthorized:", "Gateway Token"];
  const fatal = fatalText.find((needle) => bodyText.includes(needle));
  if (fatal) {
    throw new Error(`Dashboard did not reach authenticated Live Agent Workspace; saw "${fatal}".`);
  }
  if ((await page.locator(".login-gate").count()) > 0) {
    throw new Error('Dashboard did not reach authenticated Live Agent Workspace; saw "Connect".');
  }
  const authUrlClean = await page.evaluate(
    () => !/(?:[#?&])(?:token|password)=/i.test(window.location.href),
  );
  if (!authUrlClean) {
    throw new Error("Dashboard left auth material in the browser URL after bootstrap.");
  }
  const pwa = await collectPwaState(page);

  const attention = page.locator(".agent-attention-center");
  await attention.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".agent-attention-center")?.textContent ?? "";
      return !/checking live gateway status/i.test(text);
    },
    null,
    { timeout: 45_000 },
  );
  const box = await attention.boundingBox();
  if (!box || box.width < 320 || box.height < 120) {
    throw new Error("What Needs My Attention command center rendered too small to be useful.");
  }

  const verdict = (
    (await attention.locator(".agent-attention-center__lead strong").textContent()) ?? ""
  )
    .trim()
    .replace(/\s+/g, " ");
  const summary = (
    (await attention.locator(".agent-attention-center__lead em").textContent()) ?? ""
  )
    .trim()
    .replace(/\s+/g, " ");
  const actionCards = await page.locator(".agent-attention-action").count();
  const dataSourcesPanel = page.locator(".agent-signal-strip").first();
  await dataSourcesPanel.waitFor({ state: "visible", timeout: 10_000 });
  const dataSources = ((await dataSourcesPanel.textContent({ timeout: 10_000 })) ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!/Dashboard Data Sources/i.test(dataSources) || !/Gateway/i.test(dataSources)) {
    throw new Error("Dashboard Data Sources panel was not visible or did not include Gateway.");
  }
  const customizationProtectionPanel = page.locator(".agent-customization-protection").first();
  await customizationProtectionPanel.waitFor({ state: "visible", timeout: 10_000 });
  const customizationProtection = (
    (await customizationProtectionPanel.textContent({ timeout: 10_000 })) ?? ""
  )
    .trim()
    .replace(/\s+/g, " ");
  if (
    !/Customization Protection/i.test(customizationProtection) ||
    !/Protected/i.test(customizationProtection) ||
    !/Update guard Active/i.test(customizationProtection)
  ) {
    throw new Error(
      `Customization Protection card did not show protected/update-guard-active state: ${customizationProtection}`,
    );
  }
  const ramFixture = (
    await page
      .getByText(/RAM possible \/ available/i)
      .first()
      .textContent()
  )
    .trim()
    .replace(/\s+/g, " ");
  const learningVelocityPanel = page.locator(".agent-learning-velocity").first();
  await learningVelocityPanel.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".agent-learning-velocity")?.textContent ?? "";
      return !/waiting for kalshi snapshot|no snapshot loaded yet/i.test(text);
    },
    null,
    { timeout: 45_000 },
  );
  const learningVelocity = ((await learningVelocityPanel.textContent({ timeout: 10_000 })) ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!/learning velocity/i.test(learningVelocity)) {
    throw new Error("Learning Velocity panel was not visible.");
  }
  const liveWorkspaceVisible = await page
    .getByText("Live Agent Workspace", { exact: true })
    .first()
    .isVisible();
  if (!liveWorkspaceVisible) {
    throw new Error("Live Agent Workspace header was not visible.");
  }
  const brandLogo = page.locator(".sidebar-brand__logo svg").first();
  await brandLogo.waitFor({ state: "visible", timeout: 10_000 });
  const brandLogoBox = await brandLogo.boundingBox();
  if (!brandLogoBox || brandLogoBox.width < 16 || brandLogoBox.height < 16) {
    throw new Error("OpenClaw sidebar brand logo rendered too small or was not visible.");
  }
  const kalshiSnapshot = await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          kalshiDashboard?: unknown;
          kalshiDashboardLoading?: boolean;
          kalshiDashboardError?: string | null;
        })
      | null;
    if (!app) {
      return "app not found";
    }
    if (app.kalshiDashboard) {
      return "loaded";
    }
    if (app.kalshiDashboardLoading) {
      return "loading";
    }
    return app.kalshiDashboardError ? `error: ${app.kalshiDashboardError}` : "not requested";
  });
  if (kalshiSnapshot !== "loaded") {
    throw new Error(`Kalshi workspace snapshot did not load: ${kalshiSnapshot}.`);
  }
  const cronRecovery = await collectCronRecovery(page);

  return {
    ok: consoleErrors.length === 0 && pageErrors.length === 0,
    url: smokeUrl.displayUrl,
    auth: smokeUrl.auth,
    authUrlClean,
    profile,
    pwa,
    verdict,
    summary,
    actionCards,
    ramFixture,
    learningVelocity,
    dataSources,
    customizationProtection,
    cronRecovery,
    brandLogo: "visible inline svg",
    kalshiSnapshot,
    consoleErrors,
    pageErrors,
  };
}

async function collectPwaState(page: Page): Promise<SmokeSummary["pwa"]> {
  await page
    .waitForFunction(
      async () => {
        if (!("serviceWorker" in navigator)) {
          return false;
        }
        return Boolean(await navigator.serviceWorker.getRegistration());
      },
      null,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  const state = await page.evaluate(async () => {
    const manifest = Boolean(document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href);
    const registration =
      "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    return {
      manifest,
      serviceWorker: Boolean(registration),
      controlled: Boolean(navigator.serviceWorker?.controller),
    };
  });
  if (!state.manifest || !state.serviceWorker) {
    throw new Error(`PWA shell did not register manifest/service worker: ${JSON.stringify(state)}`);
  }
  return state;
}

async function collectCronRecovery(page: Page): Promise<string> {
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          requestUpdate?: () => void;
          setTab?: (tab: string) => void;
        })
      | null;
    app?.setTab?.("cron");
    app?.requestUpdate?.();
  });
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as (HTMLElement & { tab?: string }) | null;
      return app?.tab === "cron";
    },
    null,
    { timeout: 45_000 },
  );
  await page.getByText("Automation Recovery", { exact: true }).waitFor({ timeout: 45_000 });
  const panel = page.locator(".cron-recovery-panel").first();
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  const box = await panel.boundingBox();
  if (!box || box.width < 320 || box.height < 110) {
    throw new Error("Automation Recovery panel rendered too small to be useful.");
  }
  const text = ((await panel.textContent({ timeout: 10_000 })) ?? "").trim().replace(/\s+/g, " ");
  if (!/Automation Recovery/i.test(text)) {
    throw new Error("Automation Recovery panel was not visible.");
  }
  if (!/failed/i.test(text) || !/running/i.test(text) || !/skipped/i.test(text)) {
    throw new Error(`Automation Recovery panel did not include cron status counts: ${text}`);
  }
  return text.slice(0, 240);
}

async function collectFailureDiagnostics(page: Page): Promise<SmokeDiagnostics> {
  return await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          tab?: string;
          agentsPanel?: string;
          connected?: boolean;
          kalshiDashboard?: unknown;
          kalshiDashboardLoading?: boolean;
          kalshiDashboardError?: string | null;
          eventLogBuffer?: Array<{ event?: string; timestamp?: number; payload?: unknown }>;
        })
      | null;
    const eventLog = app?.eventLogBuffer ?? [];
    return {
      href: window.location.href.replace(/#token=.*/, "#token=<redacted>"),
      tab: app?.tab,
      agentsPanel: app?.agentsPanel,
      connected: app?.connected,
      kalshiDashboardLoading: app?.kalshiDashboardLoading,
      kalshiDashboardError: app?.kalshiDashboardError ?? null,
      kalshiDashboardLoaded: Boolean(app?.kalshiDashboard),
      rpcTimings: eventLog
        .filter((entry) => entry.event === "control-ui.rpc")
        .slice(-40)
        .map((entry) => entry.payload),
      refreshEvents: eventLog
        .filter(
          (entry) =>
            entry.event === "control-ui.refresh" ||
            entry.event === "control-ui.render" ||
            entry.event === "control-ui.long-task",
        )
        .slice(-20)
        .map((entry) => ({ event: entry.event, payload: entry.payload })),
      bodyText: (document.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1200),
    };
  });
}

async function run(): Promise<SmokeSummary> {
  const executablePath = resolveBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      "No Playwright Chromium or local Chrome-compatible browser found. Install Playwright browsers or set OPENCLAW_CONTROL_UI_SMOKE_BROWSER.",
    );
  }
  const smokeUrl = await resolveDashboardUrl();
  const mobileProfile = useMobileSmokeProfile();
  const contextOptions: BrowserContextOptions = mobileProfile
    ? mobileSmokeContextOptions()
    : { viewport: { width: 1440, height: 1000 } };
  const profileDir = resolveControlUiSmokeProfileDir({
    displayUrl: smokeUrl.displayUrl,
    mobile: mobileProfile,
  });
  const browserSession = await launchSmokeBrowserSession({
    executablePath,
    contextOptions,
    profileDir,
    clientMetadata: resolveSmokeClientMetadata(mobileProfile),
  });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  try {
    const page = browserSession.page;
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(redactSmokeSecrets(message.text()));
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(redactSmokeSecrets(error.message));
    });
    page.on("requestfailed", (request) => {
      requestFailures.push(
        redactSmokeSecrets(`${request.url()} ${request.failure()?.errorText ?? "failed"}`),
      );
    });
    try {
      const pairing = await openAgentsWorkspace(page, smokeUrl.launchUrl);
      return await collectSummary(
        page,
        smokeUrl,
        {
          persistent: browserSession.persistentProfile,
          dir: browserSession.profileDir,
          clientDisplayName: resolveSmokeClientMetadata(mobileProfile).displayName,
          autoApprovePairing: autoApprovePairingEnabled(),
          pairingApproved: pairing.pairingApproved,
          pairingRequestId: pairing.requestId,
        },
        consoleErrors,
        pageErrors,
      );
    } catch (error) {
      const message = redactSmokeSecrets(error instanceof Error ? error.message : String(error));
      const diagnostics = await collectFailureDiagnostics(page).catch((diagnosticError) => ({
        bodyText: `failed to collect diagnostics: ${
          diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
        }`,
      }));
      throw new Error(
        `${message}\nDiagnostics: ${JSON.stringify(
          diagnostics,
          null,
          2,
        )}\nConsole errors: ${JSON.stringify(consoleErrors)}\nPage errors: ${JSON.stringify(
          pageErrors,
        )}\nRequest failures: ${JSON.stringify(requestFailures)}`,
        { cause: error },
      );
    }
  } finally {
    await browserSession.close();
  }
}

run()
  .then((summary) => {
    if (!summary.ok) {
      console.error("control-ui-attention-smoke: failed", JSON.stringify(summary, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log("control-ui-attention-smoke: ok", JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    const message = redactSmokeSecrets(error instanceof Error ? error.message : String(error));
    console.error("control-ui-attention-smoke: failed", message);
    process.exitCode = 1;
  });
