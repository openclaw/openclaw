import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
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

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type ComposerSnapshot = {
  phase: string;
  screenshot: string;
  innerHeight: number;
  visualViewportHeight: number;
  keyboardInset: string;
  input: Rect | null;
  textarea: Rect | null;
  toolbar: Rect | null;
  primaryTool: Rect | null;
  moreActions: Rect | null;
  actionSheet: Rect | null;
  send: Rect | null;
  activeElement: string | null;
  textareaValueLength: number;
};

type SmokeSummary = {
  ok: true;
  url: string;
  auth: ControlUiSmokeUrl["auth"];
  authUrlClean: boolean;
  artifactDir: string;
  profile: {
    persistent: boolean;
    dir?: string;
    clientDisplayName: string;
    autoApprovePairing: boolean;
    pairingApproved: boolean;
    pairingRequestId?: string;
  };
  sentMessage: boolean;
  phases: ComposerSnapshot[];
  consoleErrors: string[];
  responseErrors: string[];
  pageErrors: string[];
};

type SmokeClientMetadata = {
  displayName: string;
  deviceFamily: string;
  platform?: string;
};

type SmokeBrowserSession = {
  page: Page;
  close: () => Promise<void>;
  persistentProfile: boolean;
  profileDir?: string;
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

function redactSmokeSecrets(value: string): string {
  return redactControlUiSmokeSecrets(value);
}

function shouldIgnoreConsoleError(message: string): boolean {
  return /Failed to load resource: the server responded with a status of 401 \(Unauthorized\).*\/avatar\//i.test(
    message,
  );
}

async function resolveDashboardUrl(): Promise<ControlUiSmokeUrl> {
  return resolveControlUiSmokeUrl({
    explicitUrlEnvNames: ["OPENCLAW_CONTROL_UI_MOBILE_CHAT_URL", "OPENCLAW_CONTROL_UI_SMOKE_URL"],
  });
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function shouldSendSmokeMessage(): boolean {
  const raw = process.env.OPENCLAW_CONTROL_UI_MOBILE_CHAT_SEND?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveSendCompletionTimeoutMs(): number {
  const raw = process.env.OPENCLAW_CONTROL_UI_MOBILE_CHAT_SEND_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
}

function shouldRunSyntheticKeyboardPhase(): boolean {
  const raw = process.env.OPENCLAW_CONTROL_UI_MOBILE_CHAT_SYNTHETIC_KEYBOARD?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

function autoApprovePairingEnabled(): boolean {
  const raw = process.env.OPENCLAW_CONTROL_UI_SMOKE_AUTO_APPROVE_PAIRING?.trim().toLowerCase();
  return !raw || raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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

function resolveSmokeClientMetadata(): SmokeClientMetadata {
  const label = process.env.OPENCLAW_CONTROL_UI_SMOKE_DEVICE_NAME?.trim();
  return {
    displayName: label || "OpenClaw smoke iPhone profile",
    deviceFamily: "control-ui-smoke",
    platform: "iPhone",
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

function mobileSmokeContextOptions(): BrowserContextOptions {
  const device = devices["iPhone 15 Pro"] ?? devices["iPhone 15"] ?? devices["iPhone 14"];
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

async function launchMobileSmokeBrowserSession(options: {
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

async function openChat(page: Page, launchUrl: string): Promise<PairingOutcome> {
  const chatUrl = new URL(launchUrl);
  const routeBase = chatUrl.pathname.replace(/\/$/, "");
  if (!/\/chat$/i.test(routeBase)) {
    chatUrl.pathname = `${routeBase === "" ? "" : routeBase}/chat`;
  }
  await page.goto(chatUrl.toString(), { waitUntil: "domcontentloaded" });
  const pairing = await waitForConnectedOrApprovePairing(page);
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & { setTab?: (tab: string) => void; requestUpdate?: () => void })
      | null;
    app?.setTab?.("chat");
    app?.requestUpdate?.();
  });
  await page.waitForSelector(".content--chat .agent-chat__input textarea", { timeout: 45_000 });
  return pairing;
}

async function assertNoChatLoadError(page: Page, phase: string) {
  const diagnostics = await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          tab?: string;
          connected?: boolean;
          chatLoading?: boolean;
          lastError?: string | null;
          chatMessages?: unknown[];
        })
      | null;
    return {
      tab: app?.tab ?? null,
      connected: app?.connected ?? null,
      chatLoading: app?.chatLoading ?? null,
      lastError: app?.lastError ?? null,
      messageCount: Array.isArray(app?.chatMessages) ? app.chatMessages.length : null,
      bodyText: (document.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1200),
    };
  });
  const errorText = `${diagnostics.lastError ?? ""} ${diagnostics.bodyText}`;
  if (/error loading messages|failed to load messages|chat\.history/i.test(errorText)) {
    throw new Error(
      `Mobile chat shows a message loading error during ${phase}: ${JSON.stringify(
        diagnostics,
        null,
        2,
      )}`,
    );
  }
}

async function captureComposer(page: Page, artifactDir: string, phase: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await captureComposerOnce(page, artifactDir, phase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt > 0 ||
        !/Execution context was destroyed|most likely because of a navigation|Target closed/i.test(
          message,
        )
      ) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page
        .waitForSelector(".content--chat .agent-chat__input textarea", { timeout: 45_000 })
        .catch(() => undefined);
      await page.waitForTimeout(350);
    }
  }
  throw new Error(`Unable to capture mobile composer during ${phase}.`);
}

async function captureComposerOnce(page: Page, artifactDir: string, phase: string) {
  const screenshot = join(artifactDir, `${phase}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  return await page.evaluate(
    ({ phase, screenshot }) => {
      function rectFor(selector: string): Rect | null {
        const element = document.querySelector(selector);
        if (!element) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        };
      }
      const active = document.activeElement;
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".content--chat .agent-chat__input textarea",
      );
      return {
        phase,
        screenshot,
        innerHeight: window.innerHeight,
        visualViewportHeight: window.visualViewport?.height ?? window.innerHeight,
        keyboardInset: getComputedStyle(document.documentElement)
          .getPropertyValue("--mobile-keyboard-inset")
          .trim(),
        input: rectFor(".content--chat .agent-chat__input"),
        textarea: rectFor(".content--chat .agent-chat__input textarea"),
        toolbar: rectFor(".content--chat .agent-chat__toolbar"),
        primaryTool: rectFor(".content--chat .agent-chat__toolbar-left .agent-chat__input-btn"),
        moreActions: rectFor(".content--chat .agent-chat__mobile-actions-toggle"),
        actionSheet: rectFor(".content--chat .agent-chat__mobile-actions-sheet"),
        send: rectFor(".content--chat .agent-chat__toolbar-right .chat-send-btn"),
        activeElement:
          active instanceof HTMLElement
            ? active.tagName.toLowerCase() +
              (active.className ? `.${active.className.replace(/\s+/g, ".")}` : "")
            : null,
        textareaValueLength: textarea?.value.length ?? 0,
      } satisfies ComposerSnapshot;
    },
    { phase, screenshot },
  );
}

function assertComposerVisible(snapshot: ComposerSnapshot) {
  const { input, textarea, primaryTool, moreActions, send } = snapshot;
  if (!input || !textarea || !primaryTool || !moreActions || !send) {
    throw new Error(
      `Missing composer element during ${snapshot.phase}: ${JSON.stringify(snapshot)}`,
    );
  }
  const keyboardInset = Math.max(0, Number.parseFloat(snapshot.keyboardInset) || 0);
  const visibleBottom = Math.min(
    snapshot.visualViewportHeight,
    snapshot.innerHeight - keyboardInset,
  );
  const bottomGap = visibleBottom - input.bottom;
  if (input.top < 88) {
    throw new Error(
      `Composer jumped too high during ${snapshot.phase}: ${JSON.stringify(snapshot)}`,
    );
  }
  if (input.bottom > visibleBottom + 2) {
    throw new Error(
      `Composer extends below the visible viewport during ${snapshot.phase}: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
  if (bottomGap > 92) {
    throw new Error(
      `Composer is not bottom-aligned during ${snapshot.phase}; gap=${bottomGap}: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
  for (const [name, rect] of [
    ["textarea", textarea],
    ["primaryTool", primaryTool],
    ["moreActions", moreActions],
    ["send", send],
  ] as const) {
    if (rect.top < input.top - 2 || rect.bottom > input.bottom + 2) {
      throw new Error(
        `${name} is not contained in the composer during ${snapshot.phase}: ${JSON.stringify(
          snapshot,
        )}`,
      );
    }
  }
  for (const [name, rect] of [
    ["primaryTool", primaryTool],
    ["moreActions", moreActions],
    ["send", send],
  ] as const) {
    if (rect.width < 40 || rect.height < 40) {
      throw new Error(`${name} is too small during ${snapshot.phase}: ${JSON.stringify(snapshot)}`);
    }
  }
  const rowCenters = [primaryTool, moreActions, send].map((rect) => rect.top + rect.height / 2);
  if (Math.max(...rowCenters) - Math.min(...rowCenters) > 10) {
    throw new Error(
      `Composer actions are not aligned in one visible row during ${snapshot.phase}: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

function assertActionSheetVisible(snapshot: ComposerSnapshot) {
  const { actionSheet } = snapshot;
  if (!actionSheet) {
    throw new Error(
      `Mobile action sheet missing during ${snapshot.phase}: ${JSON.stringify(snapshot)}`,
    );
  }
  const keyboardInset = Math.max(0, Number.parseFloat(snapshot.keyboardInset) || 0);
  const visibleBottom = Math.min(
    snapshot.visualViewportHeight,
    snapshot.innerHeight - keyboardInset,
  );
  if (actionSheet.top < 24 || actionSheet.bottom > visibleBottom + 2) {
    throw new Error(
      `Mobile action sheet is outside the visible viewport during ${snapshot.phase}: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

async function assertComposerHiddenByNavDrawer(page: Page, artifactDir: string) {
  await page.locator(".topbar-nav-toggle").first().click();
  await page.waitForTimeout(200);
  const screenshot = join(artifactDir, "06-nav-drawer-open.png");
  await page.screenshot({ path: screenshot, fullPage: false });
  const drawerState = await page.evaluate((screenshotPath) => {
    const shell = document.querySelector(".shell");
    const nav = document.querySelector(".shell-nav");
    const input = document.querySelector(".content--chat .agent-chat__input");
    const inputStyle = input ? getComputedStyle(input as HTMLElement) : null;
    const navStyle = nav ? getComputedStyle(nav as HTMLElement) : null;
    const navRect = nav?.getBoundingClientRect();
    const inputRect = input?.getBoundingClientRect();
    return {
      shellDrawerOpen: shell?.classList.contains("shell--nav-drawer-open") ?? false,
      screenshot: screenshotPath,
      nav: navRect
        ? {
            left: navRect.left,
            right: navRect.right,
            top: navRect.top,
            bottom: navRect.bottom,
          }
        : null,
      navPointerEvents: navStyle?.pointerEvents ?? null,
      navZIndex: navStyle?.zIndex ?? null,
      input: inputRect
        ? {
            left: inputRect.left,
            right: inputRect.right,
            top: inputRect.top,
            bottom: inputRect.bottom,
          }
        : null,
      inputOpacity: inputStyle?.opacity ?? null,
      inputPointerEvents: inputStyle?.pointerEvents ?? null,
      inputVisibility: inputStyle?.visibility ?? null,
      inputZIndex: inputStyle?.zIndex ?? null,
    };
  }, screenshot);
  if (!drawerState.shellDrawerOpen) {
    throw new Error(`Mobile nav drawer did not open: ${JSON.stringify(drawerState)}`);
  }
  if (drawerState.navPointerEvents !== "auto") {
    throw new Error(`Mobile nav drawer is not interactive: ${JSON.stringify(drawerState)}`);
  }
  if (
    drawerState.inputVisibility !== "hidden" ||
    drawerState.inputOpacity !== "0" ||
    drawerState.inputPointerEvents !== "none"
  ) {
    throw new Error(
      `Chat composer remains visible over the mobile nav drawer: ${JSON.stringify(drawerState)}`,
    );
  }
  const navZIndex = Number.parseInt(drawerState.navZIndex ?? "", 10);
  const inputZIndex = Number.parseInt(drawerState.inputZIndex ?? "", 10);
  if (!Number.isFinite(navZIndex) || !Number.isFinite(inputZIndex) || inputZIndex >= navZIndex) {
    throw new Error(
      `Chat composer z-index can still cover the mobile nav drawer: ${JSON.stringify(drawerState)}`,
    );
  }
  return drawerState;
}

async function main() {
  const smokeUrl = await resolveDashboardUrl();
  const artifactDir =
    process.env.OPENCLAW_CONTROL_UI_MOBILE_CHAT_ARTIFACT_DIR?.trim() ||
    join(".artifacts", "control-ui-mobile-chat", timestampSlug());
  mkdirSync(artifactDir, { recursive: true });

  const executablePath = resolveBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      "No Playwright Chromium or local Chrome-compatible browser found. Install Playwright browsers or set OPENCLAW_CONTROL_UI_SMOKE_BROWSER.",
    );
  }
  const clientMetadata = resolveSmokeClientMetadata();
  const profileDir = resolveControlUiSmokeProfileDir({
    displayUrl: smokeUrl.displayUrl,
    mobile: true,
  });
  const browserSession = await launchMobileSmokeBrowserSession({
    executablePath,
    contextOptions: mobileSmokeContextOptions(),
    profileDir,
    clientMetadata,
  });
  const page = browserSession.page;
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  const consoleErrors: string[] = [];
  const responseErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      const locationText = location.url
        ? ` (${redactSmokeSecrets(location.url)}:${location.lineNumber})`
        : "";
      const text = `${redactSmokeSecrets(message.text())}${locationText}`;
      if (!shouldIgnoreConsoleError(text)) {
        consoleErrors.push(text);
      }
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      responseErrors.push(`${response.status()} ${redactSmokeSecrets(response.url())}`);
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(redactSmokeSecrets(error.message));
  });

  try {
    const pairing = await openChat(page, smokeUrl.launchUrl);
    await assertNoChatLoadError(page, "open");
    const snapshots: ComposerSnapshot[] = [];
    const authUrlClean = await page.evaluate(
      () => !/(?:[#?&])(?:token|password)=/i.test(window.location.href),
    );
    if (!authUrlClean) {
      throw new Error("Dashboard left auth material in the browser URL after bootstrap.");
    }

    snapshots.push(await captureComposer(page, artifactDir, "01-before-focus"));
    await assertNoChatLoadError(page, "before-focus");
    assertComposerVisible(snapshots.at(-1)!);

    const textarea = page.locator(".content--chat .agent-chat__input textarea");
    await textarea.focus();
    await page.waitForTimeout(700);
    snapshots.push(await captureComposer(page, artifactDir, "02-focused"));
    await assertNoChatLoadError(page, "focused");
    assertComposerVisible(snapshots.at(-1)!);

    const smokeMessage = `MOBILE_VISUAL_SMOKE_${Date.now()} - UI layout validation only.`;
    await textarea.fill(smokeMessage);
    await page.waitForTimeout(150);
    snapshots.push(await captureComposer(page, artifactDir, "03-typed"));
    await assertNoChatLoadError(page, "typed");
    assertComposerVisible(snapshots.at(-1)!);

    if (shouldRunSyntheticKeyboardPhase()) {
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--mobile-keyboard-inset", "320px");
        const app = document.querySelector("openclaw-app") as HTMLElement | null;
        app?.style.setProperty("--mobile-keyboard-inset", "320px");
      });
      await page.waitForTimeout(250);
      snapshots.push(await captureComposer(page, artifactDir, "04-synthetic-keyboard"));
      await assertNoChatLoadError(page, "synthetic-keyboard");
      assertComposerVisible(snapshots.at(-1)!);

      await page.locator(".content--chat .agent-chat__mobile-actions-toggle").first().click();
      await page.waitForTimeout(150);
      snapshots.push(await captureComposer(page, artifactDir, "05-action-sheet"));
      await assertNoChatLoadError(page, "action-sheet");
      assertComposerVisible(snapshots.at(-1)!);
      assertActionSheetVisible(snapshots.at(-1)!);
      await page.locator(".content--chat .agent-chat__mobile-actions-toggle").first().click();
      await page.waitForTimeout(100);
    }

    const sendMessage = shouldSendSmokeMessage();
    if (sendMessage) {
      await page
        .locator(".content--chat .agent-chat__toolbar-right .chat-send-btn")
        .first()
        .click();
      await page
        .waitForFunction(
          () => {
            const textarea = document.querySelector<HTMLTextAreaElement>(
              ".content--chat .agent-chat__input textarea",
            );
            return textarea?.value.trim() === "";
          },
          null,
          { timeout: 10_000 },
        )
        .catch(() => {
          throw new Error("Smoke message did not leave the composer within 10 seconds.");
        });
      await page.waitForFunction(
        () => {
          const app = document.querySelector("openclaw-app") as
            | (HTMLElement & { chatRunId?: string | null; chatSending?: boolean })
            | null;
          return app?.chatSending === false && !app.chatRunId;
        },
        null,
        { timeout: resolveSendCompletionTimeoutMs() },
      );
      await assertNoChatLoadError(page, "after-send-complete");
      const completion = await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as
          | (HTMLElement & {
              chatRunId?: string | null;
              chatSending?: boolean;
              lastError?: string | null;
              chatMessages?: unknown[];
            })
          | null;
        return {
          chatRunId: app?.chatRunId ?? null,
          chatSending: app?.chatSending ?? null,
          lastError: app?.lastError ?? null,
          messageCount: Array.isArray(app?.chatMessages) ? app.chatMessages.length : null,
          bodyText: (document.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(-1600),
        };
      });
      const completionText = `${completion.lastError ?? ""} ${completion.bodyText}`;
      if (/agent failed before reply|error:/i.test(completionText)) {
        throw new Error(
          `Smoke chat send completed with an error state: ${JSON.stringify(completion, null, 2)}`,
        );
      }
      await page.waitForTimeout(700);
      snapshots.push(await captureComposer(page, artifactDir, "06-after-send"));
      assertComposerVisible(snapshots.at(-1)!);
    }

    await assertComposerHiddenByNavDrawer(page, artifactDir);

    if (consoleErrors.length > 0 || responseErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(
        `Mobile chat smoke saw browser errors: ${JSON.stringify({
          consoleErrors,
          responseErrors,
          pageErrors,
        })}`,
      );
    }

    const summary: SmokeSummary = {
      ok: true,
      url: smokeUrl.displayUrl,
      auth: smokeUrl.auth,
      authUrlClean,
      artifactDir,
      profile: {
        persistent: browserSession.persistentProfile,
        ...(browserSession.profileDir ? { dir: browserSession.profileDir } : {}),
        clientDisplayName: clientMetadata.displayName,
        autoApprovePairing: autoApprovePairingEnabled(),
        pairingApproved: pairing.pairingApproved,
        ...(pairing.requestId ? { pairingRequestId: pairing.requestId } : {}),
      },
      sentMessage: sendMessage,
      phases: snapshots,
      consoleErrors,
      responseErrors,
      pageErrors,
    };
    writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`control-ui-mobile-chat-visual-smoke: ok ${JSON.stringify(summary, null, 2)}`);
  } finally {
    await browserSession.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
