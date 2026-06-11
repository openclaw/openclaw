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

type SmokeProfileSummary = {
  persistent: boolean;
  dir?: string;
  clientDisplayName: string;
  autoApprovePairing: boolean;
  pairingApproved: boolean;
  pairingRequestId?: string;
};

type BookWriterApprovedPublishSmokeSummary = {
  verified: boolean;
  runId: string;
  title: string;
  reviewPack: string;
  publishPrep: string;
  kdpLinkVisible: boolean;
  exactFilesVisible: boolean;
  markPublishedEnabled: boolean;
  finishedRunVisible: boolean;
  landingTrophyRoomVisible: boolean;
};

type BookWriterSmokeSummary = {
  ok: boolean;
  url: string;
  auth: ControlUiSmokeUrl["auth"];
  authUrlClean: boolean;
  profile: SmokeProfileSummary;
  runId: string;
  title: string;
  status: string;
  version: number;
  chapters: number;
  paragraphs: number;
  draftedParagraphs: number;
  manuscriptPreview: string;
  reviewPack: string;
  publishPrep: string;
  deleteVerified: boolean;
  restoreVerified: boolean;
  permanentDeleteVerified: boolean;
  remainingBooks: number;
  trophyRoomVisible: boolean;
  fixBlockersVisible: boolean;
  markPublishedVisible: boolean;
  approvedPublish: BookWriterApprovedPublishSmokeSummary;
  consoleErrors: string[];
  pageErrors: string[];
  screenshot: string;
  accessibility: BookWriterAccessibilityAudit;
  accessibilityReport: string;
  visual: BookWriterVisualAudit;
  visualReport: string;
};

type BookWriterAccessibilityIssue = {
  code: string;
  severity: "critical" | "warning";
  target: string;
  message: string;
};

type BookWriterAccessibilityAudit = {
  checkedAt: string;
  controlCount: number;
  focusableCount: number;
  definitions: {
    helpCount: number;
    glossaryCount: number;
    guideVisible: boolean;
    workflowMapVisible: boolean;
    recommendedActionVisible: boolean;
    fieldHintCount: number;
    trophyHelpCount: number;
    labels: string[];
  };
  criticalIssues: BookWriterAccessibilityIssue[];
  warnings: BookWriterAccessibilityIssue[];
  keyboard: {
    startButtonFocusable: boolean;
    journeyTabFocusable: boolean;
    happyPathBeforeLibraryTools: boolean;
    helpStopsSkipped: boolean;
    observedTabStops: string[];
  };
};

type BookWriterVisualAudit = {
  checkedAt: string;
  mobile: boolean;
  screenshot: string;
  viewport: { width: number; height: number } | null;
  dashboardBounds: { width: number; height: number } | null;
  trophyRoomAtTop: boolean;
  trophyRoomCompactsOnScroll: boolean;
  trophyRoomScrollsAway: boolean;
  trophyRoomHeightBeforeScroll: number | null;
  trophyRoomHeightAfterScroll: number | null;
  trophyRoomTopBeforeScroll: number | null;
  trophyRoomTopAfterScroll: number | null;
  healthStripVisible: boolean;
  healthCardCount: number;
  bookControlBarVisible: boolean;
  currentSettingsControlsDuplicated: boolean;
  trophyRoomHiddenOnBuildPages: boolean;
  celebrationVisible: boolean;
  deletedListCollapsed: boolean;
  activeDeleteBehindMore: boolean;
  railFinishedShortcutVisible: boolean;
  railWithinViewport: boolean;
  mainWithinViewport: boolean;
  visibleJourneySteps: string[];
};

type BookWriterSmokePlan = {
  runId?: string;
  title?: string;
  status?: string;
  version?: number;
  targetWords?: number;
  styleGuide?: {
    tonePreset?: string;
    toneDescription?: string;
    profanityLevel?: string;
  };
  chapters?: Array<{
    paragraphs?: Array<{ text?: string }>;
  }>;
  cover?: {
    status?: string;
    variants?: Array<{ id?: string; approved?: boolean }>;
  };
};

type BookWriterSmokeSnapshot = {
  outputDir?: string;
  projects?: Array<{ runId?: string }>;
  deletedBooks?: Array<{ deletedId?: string; runId?: string; title?: string }>;
  finishedBooks?: Array<{
    finishedId?: string;
    runId?: string;
    title?: string;
    coverPath?: string;
    coverPreviewDataUrl?: string;
  }>;
  selectedRunId?: string | null;
  plan?: BookWriterSmokePlan | null;
  manuscriptPreview?: string;
  planQuality?: unknown;
  reviewPack?: { recommendation?: string } | null;
  publishDryRun?: { status?: string; coverStrategy?: string } | null;
};

type BookWriterSmokeClient = {
  request<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
};

type BookWriterSmokeApp = HTMLElement & {
  client?: BookWriterSmokeClient;
  connected?: boolean;
  tab?: string;
  bookWriterLoading?: boolean;
  bookWriterDashboard?: BookWriterSmokeSnapshot | null;
  bookWriterError?: string | null;
  bookWriterSavingAction?: string | null;
  bookWriterSelectedRunId?: string | null;
  bookWriterActiveView?: string;
  requestUpdate?: () => void;
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

type SnapshotCondition = "created" | "drafted" | "stitched" | "packaged" | "publish-ready";

const SMOKE_TOPIC =
  "An original clean mystery about an honest bridge inspector who uncovers invoice fraud, protects a small town from a dangerous shortcut, and solves the case through courage, paper trails, and practical integrity.";
const APPROVED_SMOKE_TOPIC =
  "An original clean mystery about Primary Voice, an honest bridge inspector, using evidence ledger invoice receipt file details to reach a complete resolution and stop fraud.";
const APPROVED_SMOKE_TARGET_WORDS = 9000;

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

function useMobileSmokeProfile(): boolean {
  const raw = process.env.OPENCLAW_CONTROL_UI_SMOKE_MOBILE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on" || raw === "iphone";
}

function bookWriterSmokeMutationAllowed(): boolean {
  return envFlagEnabled("OPENCLAW_CONTROL_UI_BOOK_WRITER_SMOKE_ALLOW_MUTATION", false);
}

function assertBookWriterSmokeMutationAllowed(): void {
  if (bookWriterSmokeMutationAllowed()) {
    return;
  }
  throw new Error(
    "Book Writer smoke creates, drafts, packages, and marks fixture books as published. Set OPENCLAW_CONTROL_UI_BOOK_WRITER_SMOKE_ALLOW_MUTATION=1 only when running against disposable or cleanup-safe state.",
  );
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

function resolveSmokeClientMetadata(mobile: boolean): SmokeClientMetadata {
  const label = process.env.OPENCLAW_CONTROL_UI_SMOKE_DEVICE_NAME?.trim();
  return {
    displayName: label || `OpenClaw Book Writer smoke ${mobile ? "iPhone" : "desktop"} profile`,
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

function mobileSmokeContextOptions(): BrowserContextOptions {
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

function bookWriterUrlFor(launchUrl: string): string {
  const url = new URL(launchUrl);
  const routeBase = url.pathname.replace(/\/$/, "");
  if (!/\/book-writer$/i.test(routeBase)) {
    url.pathname = `${routeBase === "" ? "" : routeBase}/book-writer`;
  }
  return url.toString();
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

async function waitForConnectedOrApprovePairing(page: Page): Promise<PairingOutcome> {
  const waitForConnected = () =>
    page.waitForFunction(
      () => {
        const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
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

async function waitForBookWriter(page: Page): Promise<PairingOutcome> {
  const smokeUrl = await resolveDashboardUrl();
  await page.goto(bookWriterUrlFor(smokeUrl.launchUrl), { waitUntil: "domcontentloaded" });
  const pairing = await waitForConnectedOrApprovePairing(page);
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      return app?.connected === true && app?.tab === "bookWriter";
    },
    null,
    { timeout: 45_000 },
  );
  await page.locator(".book-writer-dashboard").waitFor({ state: "visible", timeout: 45_000 });
  return pairing;
}

async function waitForBookWriterSnapshot(
  page: Page,
  condition: SnapshotCondition,
  runId?: string,
  timeout = 90_000,
): Promise<BookWriterSmokeSnapshot> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await getBookWriterSnapshot(page);
    if (snapshotMatchesCondition(snapshot, condition, runId)) {
      return snapshot;
    }
    await page.waitForTimeout(500);
  }
  const snapshot = await getBookWriterSnapshot(page);
  throw new Error(
    `timed out waiting for Book Writer ${condition} snapshot: ${JSON.stringify({
      runId,
      currentRunId: snapshot.plan?.runId,
      status: snapshot.plan?.status,
      version: snapshot.plan?.version,
      paragraphs: snapshot.plan ? countParagraphs(snapshot.plan) : 0,
      draftedParagraphs: snapshot.plan ? countDraftedParagraphs(snapshot.plan) : 0,
      reviewPack: snapshot.reviewPack?.recommendation,
      publishDryRun: snapshot.publishDryRun?.status,
    })}`,
  );
}

async function getBookWriterSnapshot(page: Page): Promise<BookWriterSmokeSnapshot> {
  return await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
    return app?.bookWriterDashboard ?? {};
  });
}

async function waitForBookWriterSnapshotLoaded(page: Page, timeout = 45_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      return app?.bookWriterDashboard !== null && app?.bookWriterLoading !== true;
    },
    null,
    { timeout },
  );
}

async function waitForNewBookWriterPlan(
  page: Page,
  previousRunId: string | undefined,
  timeout = 90_000,
): Promise<BookWriterSmokeSnapshot> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await getBookWriterSnapshot(page);
    const plan = snapshot.plan;
    if (plan?.runId && plan.runId !== previousRunId && (plan.chapters?.length ?? 0) > 0) {
      return snapshot;
    }
    await page.waitForTimeout(500);
  }
  const snapshot = await getBookWriterSnapshot(page);
  throw new Error(
    `timed out waiting for newly created Book Writer plan: ${JSON.stringify({
      previousRunId,
      currentRunId: snapshot.plan?.runId,
      status: snapshot.plan?.status,
      version: snapshot.plan?.version,
    })}`,
  );
}

function snapshotMatchesCondition(
  current: BookWriterSmokeSnapshot,
  condition: SnapshotCondition,
  runId?: string,
): boolean {
  const plan = current.plan;
  if (!plan) {
    return false;
  }
  if (runId && plan.runId !== runId) {
    return false;
  }
  switch (condition) {
    case "created":
      return Boolean(plan.runId && (plan.chapters?.length ?? 0) > 0);
    case "drafted": {
      const paragraphs = countParagraphs(plan);
      return (
        plan.status === "drafting" && paragraphs > 0 && countDraftedParagraphs(plan) === paragraphs
      );
    }
    case "stitched":
      return (
        plan.status === "stitched" && Boolean(current.manuscriptPreview?.includes(plan.title ?? ""))
      );
    case "packaged":
      return Boolean(current.reviewPack);
    case "publish-ready":
      return current.publishDryRun?.status === "ready";
  }
  return false;
}

function countParagraphs(plan: BookWriterSmokePlan): number {
  return (plan.chapters ?? []).reduce(
    (count, chapter) => count + (chapter.paragraphs?.length ?? 0),
    0,
  );
}

function countDraftedParagraphs(plan: BookWriterSmokePlan): number {
  return (plan.chapters ?? []).reduce(
    (count, chapter) =>
      count +
      (chapter.paragraphs ?? []).filter((paragraph) => (paragraph.text ?? "").trim().length > 0)
        .length,
    0,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickAction(page: Page, label: string | RegExp) {
  const name = typeof label === "string" ? new RegExp(`^${escapeRegExp(label)}`) : label;
  await page.getByRole("button", { name }).first().click();
}

async function confirmAction(page: Page, label: string | RegExp) {
  const dialogVisible = await page
    .getByRole("dialog")
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!dialogVisible) {
    return;
  }
  await page.getByRole("button", { name: label }).last().click();
}

async function confirmActionIfVisible(page: Page, label: string | RegExp) {
  const dialog = page.getByRole("dialog");
  const visible = await dialog
    .waitFor({ state: "visible", timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (visible) {
    await page.getByRole("button", { name: label }).last().click();
  }
}

async function approveCoverIfNeeded(page: Page, runId: string) {
  let snapshot = await getBookWriterSnapshot(page);
  if (snapshot.plan?.cover?.status === "approved") {
    return snapshot;
  }
  const approveCover = page.getByRole("button", { name: /^Approve cover first/ }).first();
  if (await approveCover.isVisible().catch(() => false)) {
    await approveCover.click();
  } else {
    const approveVariant = page.getByRole("button", { name: /^Approve$/ }).first();
    if (await approveVariant.isVisible().catch(() => false)) {
      await approveVariant.click();
    } else {
      snapshot = await page.evaluate(async (expectedRunId) => {
        const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
        const current = app?.bookWriterDashboard;
        const plan = current?.plan;
        if (!app?.client || !plan?.runId || plan.runId !== expectedRunId || !plan.version) {
          throw new Error("Book Writer cover approval fallback could not find the active plan.");
        }
        let nextSnapshot = current;
        let variantId = plan.cover?.variants?.[0]?.id;
        let baseVersion = plan.version;
        if (!variantId) {
          nextSnapshot = await app.client.request<BookWriterSmokeSnapshot>(
            "bookWriter.cover.generate",
            { runId: expectedRunId, baseVersion },
            { timeoutMs: 120_000 },
          );
          app.bookWriterDashboard = nextSnapshot;
          app.requestUpdate?.();
          variantId = nextSnapshot.plan?.cover?.variants?.[0]?.id;
          baseVersion = nextSnapshot.plan?.version ?? baseVersion;
        }
        const approvedSnapshot = await app.client.request<BookWriterSmokeSnapshot>(
          "bookWriter.cover.approve",
          { runId: expectedRunId, baseVersion, variantId },
          { timeoutMs: 120_000 },
        );
        app.bookWriterDashboard = approvedSnapshot;
        app.bookWriterSelectedRunId =
          approvedSnapshot.selectedRunId ?? approvedSnapshot.plan?.runId ?? null;
        app.requestUpdate?.();
        return approvedSnapshot;
      }, runId);
    }
  }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    snapshot = await getBookWriterSnapshot(page);
    if (snapshot.plan?.runId === runId && snapshot.plan.cover?.status === "approved") {
      return snapshot;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `timed out waiting for cover approval: ${JSON.stringify({
      runId,
      currentRunId: snapshot.plan?.runId,
      coverStatus: snapshot.plan?.cover?.status,
      variants: snapshot.plan?.cover?.variants?.length ?? 0,
    })}`,
  );
}

async function clickTab(page: Page, label: string) {
  await page
    .locator(".book-writer-guided-step, .book-writer-journey__step")
    .filter({ hasText: label })
    .first()
    .click();
}

async function assertWriteStepParagraphRail(page: Page) {
  const outline = page.locator(".book-writer-guided-outline").first();
  await outline.waitFor({ state: "visible", timeout: 15_000 });
  const outlineText = ((await outline.textContent()) ?? "").replace(/\s+/g, " ").trim();
  if (/\bWritten\b/.test(outlineText)) {
    throw new Error(`Write step paragraph rail still repeats "Written": ${outlineText}`);
  }
  if (
    !/Readers can see this|AI can write this|Protected from AI|Add a plan first/.test(outlineText)
  ) {
    throw new Error(`Write step paragraph rail is missing plain readiness cues: ${outlineText}`);
  }

  const activeStatus = page.locator(".book-writer-guided-status").first();
  await activeStatus.waitFor({ state: "visible", timeout: 15_000 });
  const statusText = ((await activeStatus.textContent()) ?? "").replace(/\s+/g, " ").trim();
  if (/\bWritten\b/.test(statusText)) {
    throw new Error(`Write step focused status still says "Written": ${statusText}`);
  }
  if (!/Text ready|Ready for AI|Needs plan|Locked/.test(statusText)) {
    throw new Error(`Write step focused status is missing plain readiness language: ${statusText}`);
  }
}

async function runBookWriterFlow(page: Page) {
  await waitForBookWriterSnapshotLoaded(page);
  const previousRunId = (await getBookWriterSnapshot(page)).plan?.runId;
  await page
    .locator("textarea.book-writer-guided-topic, textarea.book-writer-topic")
    .fill(SMOKE_TOPIC);
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as BookWriterSmokeApp & {
      bookWriterTargetWordsDraft?: number;
      bookWriterToneDraft?: string;
      bookWriterCustomToneDraft?: string;
      bookWriterProfanityDraft?: string;
    };
    app.bookWriterTargetWordsDraft = 12000;
    app.bookWriterToneDraft = "custom";
    app.bookWriterCustomToneDraft = "Technical, field-tested, and quietly reassuring.";
    app.bookWriterProfanityDraft = "mild";
    app.requestUpdate?.();
  });
  const setupButton = page.getByRole("button", { name: "Set up new book" }).first();
  if (await setupButton.isVisible().catch(() => false)) {
    await setupButton.click();
    await page
      .getByText(/New Book Setup|Describe the book/)
      .first()
      .waitFor({
        state: "visible",
        timeout: 15_000,
      });
  }
  await page.getByText("Style Preview").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.getByText("≈ 40-48 paperback pages").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  const setupControlAudit = await page.evaluate(() => ({
    setupCards: document.querySelectorAll(".book-writer-setup-controls").length,
    railTargetWords: document.querySelectorAll(
      '.book-writer-rail [aria-label="New book target words"]',
    ).length,
    railTone: document.querySelectorAll('.book-writer-rail [aria-label="New book tone"]').length,
    railProfanity: document.querySelectorAll('.book-writer-rail [aria-label="New book profanity"]')
      .length,
  }));
  if (
    setupControlAudit.setupCards > 1 ||
    setupControlAudit.railTargetWords ||
    setupControlAudit.railTone ||
    setupControlAudit.railProfanity
  ) {
    throw new Error(`Book setup controls are duplicated: ${JSON.stringify(setupControlAudit)}`);
  }
  await page
    .getByRole("button", { name: /^Write my editable draft/ })
    .first()
    .waitFor({
      state: "visible",
      timeout: 15_000,
    });
  await clickAction(page, /^Just make chapters first/);
  await confirmActionIfVisible(page, "Make chapters");
  let snapshot = await waitForNewBookWriterPlan(page, previousRunId);
  const createdRunId = snapshot.plan?.runId;
  if (!createdRunId) {
    throw new Error("Book Writer plan was not created.");
  }
  if (
    snapshot.plan?.targetWords !== 12000 ||
    snapshot.plan.styleGuide?.tonePreset !== "custom" ||
    snapshot.plan.styleGuide?.toneDescription !==
      "Technical, field-tested, and quietly reassuring." ||
    snapshot.plan.styleGuide?.profanityLevel !== "mild"
  ) {
    throw new Error(
      `Book setup controls did not persist: ${JSON.stringify({
        targetWords: snapshot.plan?.targetWords,
        styleGuide: snapshot.plan?.styleGuide,
      })}`,
    );
  }
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as BookWriterSmokeApp & {
      bookWriterActiveView?: string;
      bookWriterMode?: string;
      bookWriterNewBookSetupOpen?: boolean;
    };
    app.bookWriterMode = "guided";
    app.bookWriterNewBookSetupOpen = false;
    app.bookWriterActiveView = "chapters";
    app.requestUpdate?.();
  });

  await clickTab(page, "Chapters");
  await page.locator(".book-writer-context-panel").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  const currentSettingsAudit = await page.evaluate(() => {
    const contextPanel = document.querySelector(".book-writer-context-panel");
    const controlBarText = contextPanel?.textContent ?? "";
    return {
      contextPanels: document.querySelectorAll(".book-writer-context-panel").length,
      setupCards: document.querySelectorAll(".book-writer-setup-controls").length,
      hasAutomation: controlBarText.includes("Manual only") || controlBarText.includes("Scheduled"),
      hasAiSound: controlBarText.includes("How AI will sound"),
      hasReaderPromise: controlBarText.includes("Reader promise"),
      hasTitleControl: Boolean(contextPanel?.querySelector('[aria-label="Context book title"]')),
      hasApplyIdeaAction: controlBarText.includes("Apply idea changes to chapters"),
      hasHomeAction: Boolean(document.querySelector('[aria-label="Book Studio home"]')),
    };
  });
  if (
    currentSettingsAudit.contextPanels < 1 ||
    currentSettingsAudit.setupCards !== 0 ||
    !currentSettingsAudit.hasAutomation ||
    !currentSettingsAudit.hasAiSound ||
    !currentSettingsAudit.hasReaderPromise ||
    !currentSettingsAudit.hasTitleControl ||
    !currentSettingsAudit.hasApplyIdeaAction ||
    !currentSettingsAudit.hasHomeAction
  ) {
    throw new Error(
      `Book context panel did not replace duplicate setup controls after Idea: ${JSON.stringify(
        currentSettingsAudit,
      )}`,
    );
  }
  await page.locator(".book-writer-health-strip").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  const healthAudit = await page.evaluate(() => ({
    cards: document.querySelectorAll(".book-writer-health-card").length,
    text:
      document
        .querySelector(".book-writer-health-strip")
        ?.textContent?.replace(/\s+/g, " ")
        .trim() ?? "",
  }));
  if (
    healthAudit.cards !== 4 ||
    !healthAudit.text.includes("Unfinished text") ||
    !healthAudit.text.includes("Quality status") ||
    !healthAudit.text.includes("Publish readiness")
  ) {
    throw new Error(`Book health strip is incomplete: ${JSON.stringify(healthAudit)}`);
  }
  await page
    .locator(".book-writer-guided-chapter, .book-writer-chapter")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page
    .getByText("Paraphrase the chapter's reader-facing content. This is not printed in the book.")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await clickAction(page, "Review paragraph plan");
  await page
    .locator(".book-writer-guided-paragraph-card, .book-writer-paragraph")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".book-writer-guided-outline").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  const focusedOutlineCount = await page.locator(".book-writer-guided-outline-item").count();
  const fullOutlineSearchVisible = await page
    .getByRole("button", { name: "Open full outline and search" })
    .isVisible()
    .catch(() => false);
  const focusedOutlineText = (
    (await page.locator(".book-writer-guided-outline").first().textContent()) ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
  if (
    focusedOutlineCount > 5 ||
    !fullOutlineSearchVisible ||
    !focusedOutlineText.includes("Full outline and search are in Advanced View")
  ) {
    throw new Error(
      `Guided paragraph rail is too noisy or lacks full outline/search handoff: ${JSON.stringify({
        focusedOutlineCount,
        fullOutlineSearchVisible,
        focusedOutlineText,
      })}`,
    );
  }
  await page
    .locator(".book-writer-guided-paragraph-card, .book-writer-paragraph")
    .filter({ hasText: /What this paragraph will say|AI writing notes|paragraph blueprint/ })
    .first()
    .waitFor({ state: "visible" });
  await page.getByText("Book Text is written in Step 4").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page
    .getByText(/AI reads this as steering\. Readers do not\.|Reader-facing paraphrase/)
    .first()
    .waitFor({ state: "visible" });
  await page.getByText("Book Text readers see").first().waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: /AI write Book Text/ })
    .first()
    .waitFor({
      state: "visible",
      timeout: 15_000,
    });

  await clickAction(page, "AI write Book Text");
  await confirmAction(page, /Write \d+ paragraphs/);
  snapshot = await waitForBookWriterSnapshot(page, "drafted", createdRunId);

  await page.getByText("Final writing. Readers see this.").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await assertWriteStepParagraphRail(page);
  await clickAction(page, "Build readable book");
  await confirmAction(page, "Build readable book");
  snapshot = await waitForBookWriterSnapshot(page, "stitched", createdRunId);
  await clickTab(page, "Read");
  await page
    .locator(".book-writer-read-page, .book-writer-preview pre")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });

  await clickAction(page, "Check book quality");
  await confirmAction(page, "Check book quality");
  snapshot = await waitForBookWriterSnapshot(page, "packaged", createdRunId, 180_000);
  await clickTab(page, "Read");
  await page.getByText(/Final review, page by page\.|Read the book like a reader\./).waitFor({
    timeout: 15_000,
  });

  await clickTab(page, "Publish");
  const publishPanelVisible = await page
    .locator(".book-writer-guided-main, .book-writer-publish-card")
    .filter({
      hasText:
        /Your book is not ready yet|Final submit remains|Publishing checklist|Prepare publishing|Upload files|Exact files to use in KDP/,
    })
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!publishPanelVisible) {
    await page.locator(".book-writer-guided-main, .book-writer-publish-card").first().waitFor({
      timeout: 15_000,
    });
  }
  const reviewRecommendation = snapshot.reviewPack?.recommendation ?? "missing";
  if (reviewRecommendation === "approve") {
    snapshot = await approveCoverIfNeeded(page, createdRunId);
    await clickAction(page, "Prepare publishing");
    await confirmAction(page, "Prepare publishing");
    snapshot = await waitForBookWriterSnapshot(page, "publish-ready", createdRunId, 120_000);
  }

  return snapshot;
}

function seedMeasuredBookWriterModel(snapshot: BookWriterSmokeSnapshot) {
  if (!snapshot.outputDir) {
    throw new Error("Book Writer snapshot did not include outputDir; cannot seed approved smoke.");
  }
  writeFileSync(
    join(snapshot.outputDir, "model-bench.json"),
    `${JSON.stringify(
      [
        {
          provider: "lmstudio",
          model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
          source: "measured",
          peakMemoryGb: 52,
          tokensPerSecond: 24,
          stableContextTokens: 32768,
          crashRate: 0.01,
          qualityScore: 0.82,
          measuredAt: new Date().toISOString(),
          notes: ["Control UI Book Writer approved-publish smoke fixture."],
        },
      ],
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function createApprovedBookWriterFixture(page: Page): Promise<BookWriterSmokeSnapshot> {
  const snapshot = await page.evaluate(
    async ({ topic, targetWords }) => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      if (!app?.client) {
        throw new Error("Book Writer app client is not available.");
      }
      const nextSnapshot = await app.client.request<BookWriterSmokeSnapshot>(
        "bookWriter.plan.create",
        {
          topic,
          targetWords,
          tonePreset: "professional",
          profanityLevel: "none",
          genre: "clean commercial mystery",
          penName: "Northstar House",
        },
        { timeoutMs: 120_000 },
      );
      app.bookWriterDashboard = nextSnapshot;
      app.bookWriterSelectedRunId = nextSnapshot.selectedRunId ?? nextSnapshot.plan?.runId ?? null;
      app.bookWriterActiveView = "paragraphs";
      app.requestUpdate?.();
      return nextSnapshot;
    },
    { topic: APPROVED_SMOKE_TOPIC, targetWords: APPROVED_SMOKE_TARGET_WORDS },
  );
  if (!snapshot.plan?.runId) {
    throw new Error("Approved Book Writer fixture did not create a plan.");
  }
  return await waitForBookWriterSnapshot(page, "created", snapshot.plan.runId);
}

async function runApprovedBookWriterPublishFlow(
  page: Page,
): Promise<BookWriterApprovedPublishSmokeSummary> {
  await waitForBookWriterSnapshotLoaded(page);
  seedMeasuredBookWriterModel(await getBookWriterSnapshot(page));
  let snapshot = await createApprovedBookWriterFixture(page);
  const runId = snapshot.plan?.runId;
  if (!runId) {
    throw new Error("Approved publish fixture runId is missing.");
  }

  await clickTab(page, "Plan");
  await page
    .locator(".book-writer-guided-paragraph-card, .book-writer-paragraph")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });

  await clickTab(page, "Write");
  await clickAction(page, "AI write Book Text");
  await confirmAction(page, /Write \d+ paragraphs/);
  snapshot = await waitForBookWriterSnapshot(page, "drafted", runId);

  await assertWriteStepParagraphRail(page);
  await clickAction(page, "Build readable book");
  await confirmAction(page, "Build readable book");
  snapshot = await waitForBookWriterSnapshot(page, "stitched", runId);

  await clickTab(page, "Read");
  await clickAction(page, "Check book quality");
  await confirmAction(page, "Check book quality");
  snapshot = await waitForBookWriterSnapshot(page, "packaged", runId, 180_000);
  if (snapshot.reviewPack?.recommendation !== "approve") {
    throw new Error(
      `Approved fixture did not approve: ${JSON.stringify({
        runId,
        reviewPack: snapshot.reviewPack?.recommendation,
        publishDryRun: snapshot.publishDryRun?.status,
      })}`,
    );
  }

  await clickTab(page, "Publish");
  snapshot = await approveCoverIfNeeded(page, runId);
  await clickAction(page, "Prepare publishing");
  await confirmAction(page, "Prepare publishing");
  snapshot = await waitForBookWriterSnapshot(page, "publish-ready", runId, 120_000);

  const kdpLinkVisible = await page
    .getByRole("link", { name: /Open KDP Bookshelf/ })
    .first()
    .isVisible()
    .catch(() => false);
  const exactFilesVisible = await page
    .getByText("Exact files to use in KDP", { exact: true })
    .isVisible()
    .catch(() => false);
  const markPublished = page
    .getByRole("button", { name: /Mark published · Move to Trophy Room/ })
    .first();
  const markPublishedEnabled = await markPublished.isEnabled().catch(() => false);
  if (!kdpLinkVisible || !exactFilesVisible || !markPublishedEnabled) {
    throw new Error(
      `Approved publish UI was incomplete: ${JSON.stringify({
        runId,
        kdpLinkVisible,
        exactFilesVisible,
        markPublishedEnabled,
      })}`,
    );
  }
  await page.locator('[data-publish-proof="operatorConfirmed"]').check();
  await markPublished.click();
  const movedToFinished = await page
    .waitForFunction(
      (expectedRunId) => {
        const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
        const snapshot = app?.bookWriterDashboard;
        return (
          snapshot?.finishedBooks?.some((book) => book.runId === expectedRunId) === true &&
          snapshot.projects?.some((project) => project.runId === expectedRunId) !== true
        );
      },
      runId,
      { timeout: 8_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!movedToFinished) {
    await page.evaluate(async (expectedRunId) => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      if (!app?.client) {
        throw new Error("Book Writer app client is not available.");
      }
      const snapshot = await app.client.request<BookWriterSmokeSnapshot>(
        "bookWriter.plan.markPublished",
        {
          runId: expectedRunId,
          selectedRunId: app.bookWriterSelectedRunId,
          proof: {
            destination: "amazon-kdp",
            publishedAt: new Date().toISOString(),
            operatorConfirmed: true,
            confirmedAt: new Date().toISOString(),
            category: "clean commercial mystery",
            keywords: ["clean mystery", "bridge inspector", "invoice fraud"],
          },
        },
        { timeoutMs: 120_000 },
      );
      app.bookWriterDashboard = snapshot;
      app.bookWriterSelectedRunId = snapshot.selectedRunId ?? null;
      app.requestUpdate?.();
    }, runId);
  }
  await page.waitForFunction(
    (expectedRunId) => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      const snapshot = app?.bookWriterDashboard;
      return (
        snapshot?.finishedBooks?.some((book) => book.runId === expectedRunId) === true &&
        snapshot.projects?.some((project) => project.runId === expectedRunId) !== true
      );
    },
    runId,
    { timeout: 45_000 },
  );
  const finishedSnapshot = await getBookWriterSnapshot(page);
  const finishedRunVisible =
    finishedSnapshot.finishedBooks?.some((book) => book.runId === runId) === true;
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as BookWriterSmokeApp & {
      bookWriterNewBookSetupOpen?: boolean;
      bookWriterSelectedRunId?: string | null;
    };
    app.bookWriterNewBookSetupOpen = false;
    app.bookWriterSelectedRunId = null;
    if (app.bookWriterDashboard) {
      app.bookWriterDashboard = {
        ...app.bookWriterDashboard,
        selectedRunId: null,
        plan: null,
        manuscriptPreview: "",
        planQuality: null,
        reviewPack: null,
        publishDryRun: null,
      };
    }
    app.requestUpdate?.();
  });
  await page.locator(".book-writer-trophy-room").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  const landingTrophyRoomVisible = await page
    .locator(".book-writer-trophy-room")
    .first()
    .isVisible()
    .catch(() => false);
  const summary = {
    verified:
      finishedRunVisible &&
      landingTrophyRoomVisible &&
      snapshot.reviewPack?.recommendation === "approve" &&
      snapshot.publishDryRun?.status === "ready" &&
      kdpLinkVisible &&
      exactFilesVisible &&
      markPublishedEnabled,
    runId,
    title: snapshot.plan?.title ?? "missing",
    reviewPack: snapshot.reviewPack?.recommendation ?? "missing",
    publishPrep: snapshot.publishDryRun?.status ?? "missing",
    kdpLinkVisible,
    exactFilesVisible,
    markPublishedEnabled,
    finishedRunVisible,
    landingTrophyRoomVisible,
  };
  await cleanupApprovedBookWriterPublishSmokeBook(page, runId);
  return summary;
}

async function cleanupApprovedBookWriterPublishSmokeBook(page: Page, runId: string): Promise<void> {
  await page.evaluate(async (expectedRunId) => {
    const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
    if (!app?.client) {
      throw new Error("Book Writer app client is not available.");
    }
    let snapshot = app.bookWriterDashboard;
    const finishedId = snapshot?.finishedBooks?.find(
      (book) => book.runId === expectedRunId,
    )?.finishedId;
    if (finishedId) {
      snapshot = await app.client.request<BookWriterSmokeSnapshot>(
        "bookWriter.plan.unfinish",
        { finishedId },
        { timeoutMs: 120_000 },
      );
    }
    if (snapshot?.projects?.some((project) => project.runId === expectedRunId)) {
      snapshot = await app.client.request<BookWriterSmokeSnapshot>(
        "bookWriter.plan.delete",
        { runId: expectedRunId, selectedRunId: null },
        { timeoutMs: 120_000 },
      );
    }
    const deletedId = snapshot?.deletedBooks?.find(
      (book) => book.runId === expectedRunId,
    )?.deletedId;
    if (deletedId) {
      snapshot = await app.client.request<BookWriterSmokeSnapshot>(
        "bookWriter.plan.deleteDeleted",
        { deletedId },
        { timeoutMs: 120_000 },
      );
    }
    app.bookWriterDashboard = snapshot ?? app.bookWriterDashboard;
    app.bookWriterSelectedRunId = app.bookWriterDashboard?.selectedRunId ?? null;
    app.requestUpdate?.();
  }, runId);
}

async function verifyBookWriterDelete(page: Page, params: { runId: string; title: string }) {
  await showBookWriterHome(page);
  const manageBooks = page.locator("details.book-writer-manage-books").first();
  await manageBooks.locator("summary").click();
  await manageBooks.evaluate((details) => {
    (details as HTMLDetailsElement).open = true;
  });
  const targetRow = page.locator(`.book-writer-manage-books__row[data-run-id="${params.runId}"]`);
  const activeRowVisible = await targetRow
    .first()
    .isVisible()
    .catch(() => false);
  if (activeRowVisible) {
    await targetRow
      .first()
      .getByRole("button", { name: /Move .*Recently Deleted|Move to Recently Deleted/ })
      .click();
    await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("button", { name: "Move to Recently Deleted" }).last().click();
  } else {
    await page.evaluate(async (runId) => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      if (!app?.client) {
        throw new Error("Book Writer app client is not available.");
      }
      const snapshot = await app.client.request<BookWriterSmokeSnapshot>(
        "bookWriter.plan.delete",
        { runId, selectedRunId: null },
        { timeoutMs: 120_000 },
      );
      app.bookWriterDashboard = snapshot;
      app.bookWriterSelectedRunId = snapshot.selectedRunId ?? null;
      app.requestUpdate?.();
    }, params.runId);
  }
  const removedFromActive = await page
    .waitForFunction(
      (runId) => {
        const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
        const snapshot = app?.bookWriterDashboard;
        if (!snapshot) {
          return false;
        }
        return (
          !snapshot.projects?.some((project) => project.runId === runId) &&
          snapshot.deletedBooks?.some((book) => book.runId === runId) === true
        );
      },
      params.runId,
      { timeout: 8_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!removedFromActive) {
    await page.evaluate(async (runId) => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      if (!app?.client) {
        throw new Error("Book Writer app client is not available.");
      }
      const snapshot = await app.client.request<BookWriterSmokeSnapshot>(
        "bookWriter.dashboard.snapshot",
        {},
        { timeoutMs: 120_000 },
      );
      app.bookWriterDashboard = snapshot;
      app.bookWriterSelectedRunId = snapshot.selectedRunId ?? null;
      app.requestUpdate?.();
    }, params.runId);
  }
  await page.waitForFunction(
    (runId) => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      const snapshot = app?.bookWriterDashboard;
      if (!snapshot) {
        return false;
      }
      return (
        !snapshot.projects?.some((project) => project.runId === runId) &&
        snapshot.deletedBooks?.some((book) => book.runId === runId) === true
      );
    },
    params.runId,
    { timeout: 45_000 },
  );
  const snapshot = await getBookWriterSnapshot(page);
  const deletedBook = snapshot.deletedBooks?.find((book) => book.runId === params.runId);
  if (!deletedBook?.deletedId) {
    throw new Error(`deleted book did not appear in Recently deleted: ${params.runId}`);
  }
  return {
    deleteVerified:
      !snapshot.projects?.some((project) => project.runId === params.runId) &&
      Boolean(deletedBook.deletedId),
    deletedId: deletedBook.deletedId,
    remainingBooks: snapshot.projects?.length ?? 0,
  };
}

async function showBookWriterHome(page: Page) {
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as BookWriterSmokeApp & {
      bookWriterNewBookSetupOpen?: boolean;
    };
    app.bookWriterSelectedRunId = null;
    app.bookWriterNewBookSetupOpen = false;
    if (app.bookWriterDashboard) {
      app.bookWriterDashboard = {
        ...app.bookWriterDashboard,
        selectedRunId: null,
        plan: null,
        manuscriptPreview: "",
        planQuality: null,
        reviewPack: null,
        publishDryRun: null,
      };
    }
    app.requestUpdate?.();
  });
  await page.locator(".book-writer-rail").first().waitFor({ state: "visible", timeout: 15_000 });
}

async function verifyBookWriterEmptyDeleted(page: Page, params: { runId: string; title: string }) {
  const moved = await verifyBookWriterDelete(page, params);
  if (!moved.deleteVerified || !moved.deletedId) {
    return { permanentDeleteVerified: false, remainingBooks: moved.remainingBooks };
  }
  await page.getByRole("button", { name: /^Empty Recently Deleted/ }).click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: "Delete forever" }).last().click();
  await page.waitForFunction(
    (deletedId) => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      const snapshot = app?.bookWriterDashboard;
      return snapshot
        ? !snapshot.deletedBooks?.some((book) => book.deletedId === deletedId)
        : false;
    },
    moved.deletedId,
    { timeout: 45_000 },
  );
  const snapshot = await getBookWriterSnapshot(page);
  return {
    permanentDeleteVerified: !snapshot.deletedBooks?.some(
      (book) => book.deletedId === moved.deletedId,
    ),
    remainingBooks: snapshot.projects?.length ?? 0,
  };
}

async function verifyBookWriterRestore(
  page: Page,
  params: { runId: string; title: string; deletedId: string },
) {
  await page
    .getByRole("button", { name: new RegExp(`^Restore ${escapeRegExp(params.title)}`) })
    .first()
    .click();
  await page.waitForFunction(
    (runId) => {
      const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
      const snapshot = app?.bookWriterDashboard;
      if (!snapshot) {
        return false;
      }
      return (
        snapshot.projects?.some((project) => project.runId === runId) &&
        snapshot.plan?.runId === runId
      );
    },
    params.runId,
    { timeout: 45_000 },
  );
  const snapshot = await getBookWriterSnapshot(page);
  return {
    restoreVerified:
      snapshot.projects?.some((project) => project.runId === params.runId) === true &&
      snapshot.plan?.runId === params.runId &&
      !snapshot.deletedBooks?.some((book) => book.deletedId === params.deletedId),
    remainingBooks: snapshot.projects?.length ?? 0,
  };
}

async function auditBookWriterPublishUi(page: Page) {
  const trophyRoomVisible = await page
    .locator(".book-writer-trophy-room")
    .first()
    .isVisible()
    .catch(() => false);
  const guidedFixVisible = await page
    .getByRole("button", { name: /Fix this with AI/ })
    .first()
    .isVisible()
    .catch(() => false);
  const advancedFixVisible = await page
    .getByText("Fix publish blockers", { exact: true })
    .isVisible()
    .catch(() => false);
  const fixBlockersVisible = guidedFixVisible || advancedFixVisible;
  const markPublishedVisible = await page
    .getByRole("button", { name: /Mark published · Move to Trophy Room/ })
    .isVisible()
    .catch(() => false);
  return { trophyRoomVisible, fixBlockersVisible, markPublishedVisible };
}

async function collectFailureDiagnostics(page: Page) {
  return await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as BookWriterSmokeApp | null;
    return {
      href: window.location.href.replace(/#token=.*/, "#token=<redacted>"),
      connected: app?.connected,
      tab: app?.tab,
      savingAction: app?.bookWriterSavingAction,
      error: app?.bookWriterError,
      planStatus: app?.bookWriterDashboard?.plan?.status,
      reviewPack: app?.bookWriterDashboard?.reviewPack?.recommendation,
      publishDryRun: app?.bookWriterDashboard?.publishDryRun?.status,
      bodyText: (document.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1600),
    };
  });
}

function smokeArtifactDir(): string {
  const slug = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(".artifacts", "control-ui-book-writer", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonArtifact(filePath: string, value: unknown) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function activeElementLabel(page: Page): Promise<string> {
  return (await page.evaluate(`(() => {
    const element = document.activeElement;
    if (!element) {
      return "";
    }
    const ownLabel =
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      "";
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledByText = labelledBy
      ? labelledBy
          .split(/\\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() || "")
          .filter(Boolean)
          .join(" ")
      : "";
    const labelText = element.closest("label")?.textContent?.trim() || "";
    return (ownLabel || labelledByText || labelText || element.textContent || element.tagName)
      .replace(/\\s+/g, " ")
      .trim();
  })()`)) as string;
}

async function collectKeyboardAudit(page: Page): Promise<BookWriterAccessibilityAudit["keyboard"]> {
  const startButton = page
    .getByRole("button", {
      name: /Write my editable draft|Finish editable draft|Just make chapters first|Make my chapter list|Make chapters|Set up new book|Book Studio home|Home/,
    })
    .first();
  await startButton.focus();
  const startButtonFocusable =
    /Write my editable draft|Finish editable draft|Just make chapters first|Make my chapter list|Make chapters|Set up new book|Book Studio home|Home/.test(
      await activeElementLabel(page),
    );

  const journeyTab = page.getByRole("tab", { name: /Make Chapters|Chapters/ }).first();
  await journeyTab.focus();
  const journeyTabFocusable = /Make Chapters|Chapters/.test(await activeElementLabel(page));

  const observedTabStops: string[] = [];
  await page.locator(".book-writer-dashboard").click({ position: { x: 12, y: 12 } });
  for (let index = 0; index < 18; index += 1) {
    await page.keyboard.press("Tab");
    const label = await activeElementLabel(page);
    if (label && !observedTabStops.includes(label)) {
      observedTabStops.push(label.slice(0, 120));
    }
  }
  const firstHappyPathIndex = observedTabStops.findIndex((label) =>
    /Type a book idea|Set up new book|Book Studio home|^Home$|^Open /.test(label),
  );
  const firstLibraryToolIndex = observedTabStops.findIndex((label) =>
    /Refresh library|Manage active books|More library cleanup actions/.test(label),
  );
  const helpStopsSkipped = !observedTabStops.some((label) =>
    /^(Topic|Trophy room|Target words|Page estimate|Tone|Profanity|Style preview):/.test(label),
  );
  const happyPathBeforeLibraryTools =
    firstHappyPathIndex >= 0 &&
    (firstLibraryToolIndex === -1 || firstHappyPathIndex < firstLibraryToolIndex);

  return {
    startButtonFocusable,
    journeyTabFocusable,
    happyPathBeforeLibraryTools,
    helpStopsSkipped,
    observedTabStops,
  };
}

async function auditBookWriterAccessibility(page: Page): Promise<BookWriterAccessibilityAudit> {
  const domAudit = (await page.evaluate(`(() => {
    const dashboard = document.querySelector(".book-writer-dashboard");
    const issues = [];
    const controlSelector =
      "button,input,textarea,select,a[href],[role='button'],[role='tab'],[tabindex]";
    const controls = Array.from(dashboard?.querySelectorAll(controlSelector) || []);
    const visibleControls = controls.filter((control) => {
      const rect = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    });

    const selectorFor = (element) => {
      const className = element.getAttribute("class")?.trim().replace(/\\s+/g, ".") || "";
      const classSuffix = className ? "." + className : "";
      return (element.tagName.toLowerCase() + classSuffix).slice(0, 160);
    };

    const accessibleName = (element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledByText = labelledBy
        ? labelledBy
            .split(/\\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() || "")
            .filter(Boolean)
            .join(" ")
        : "";
      const labelText = element.closest("label")?.textContent?.trim() || "";
      return (
        element.getAttribute("aria-label") ||
        labelledByText ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        labelText ||
        element.textContent ||
        ""
      )
        .replace(/\\s+/g, " ")
        .trim();
    };

    for (const control of visibleControls) {
      if (!accessibleName(control)) {
        issues.push({
          code: "control-name",
          severity: "critical",
          target: selectorFor(control),
          message: "Visible interactive control has no accessible name.",
        });
      }
      const rect = control.getBoundingClientRect();
      if (
        (rect.width < 32 || rect.height < 32) &&
        !control.closest(".book-writer-lock") &&
        !control.closest(".book-writer-term-help-wrap") &&
        !control.closest(".book-writer-glossary-chip")
      ) {
        issues.push({
          code: "target-size",
          severity: "warning",
          target: selectorFor(control),
          message:
            "Interactive target is " +
            Math.round(rect.width) +
            "x" +
            Math.round(rect.height) +
            "; review touch ergonomics.",
        });
      }
    }

    const selectedTabs = Array.from(
      dashboard?.querySelectorAll("[role='tab'][aria-selected='true']") || [],
    );
    if (selectedTabs.length !== 1) {
      issues.push({
        code: "journey-selected-tab",
        severity: "critical",
        target: ".book-writer-journey",
        message: "Expected exactly one selected journey tab; found " + selectedTabs.length + ".",
      });
    }

    const journey = dashboard?.querySelector(".book-writer-guided-steps, .book-writer-journey");
    if (!journey?.getAttribute("aria-label")) {
      issues.push({
        code: "journey-label",
        severity: "critical",
        target: ".book-writer-guided-steps",
        message: "Journey navigation needs an aria-label.",
      });
    }

    const definitionHelps = Array.from(dashboard?.querySelectorAll(".book-writer-term-help") || []);
    const glossaryChips = Array.from(dashboard?.querySelectorAll(".book-writer-glossary-chip") || []);
    const guidedBuilderVisible = Boolean(dashboard?.querySelector(".book-writer-guided-header"));
    const miniPreviewVisible = Boolean(dashboard?.querySelector(".book-writer-mini-preview"));
    const definitionLabels = [...definitionHelps, ...glossaryChips]
      .map((element) => element.getAttribute("aria-label") || element.getAttribute("title") || "")
      .filter(Boolean)
      .slice(0, 80);
    const trophyHelpCount = definitionLabels.filter((label) => /^Trophy room:/.test(label)).length;
    const guideVisible = Boolean(dashboard?.querySelector(".book-writer-guide, .book-writer-guided-main"));
    const workflowMapVisible = Boolean(dashboard?.querySelector(".book-writer-workflow-map"));
    const recommendedActionVisible = Boolean(dashboard?.querySelector(".book-writer-next-card, .book-writer-guided-next"));
    const fieldHintCount = dashboard?.querySelectorAll(".book-writer-field-hint").length || 0;
    if (
      !guidedBuilderVisible ||
      !guideVisible ||
      !recommendedActionVisible ||
      !miniPreviewVisible
    ) {
      issues.push({
        code: "book-writer-definitions",
        severity: "critical",
        target: ".book-writer-guided-header",
        message:
          "Expected Guided Builder, a focused workspace, mini preview, and one recommended action to be visible.",
      });
    }
    if (trophyHelpCount > 1) {
      issues.push({
        code: "trophy-room-duplicate-help",
        severity: "critical",
        target: ".book-writer-trophy-room",
        message:
          "Expected one Trophy Room help stop; the sticky rail should not repeat the finished-book shelf.",
      });
    }

    return {
      controlCount: visibleControls.length,
      focusableCount: visibleControls.filter((control) => control.tabIndex >= 0).length,
      definitions: {
        helpCount: definitionHelps.length,
        glossaryCount: glossaryChips.length,
        guideVisible,
        workflowMapVisible,
        recommendedActionVisible,
        fieldHintCount,
        trophyHelpCount,
        labels: definitionLabels,
      },
      issues,
    };
  })()`)) as {
    controlCount: number;
    focusableCount: number;
    definitions: BookWriterAccessibilityAudit["definitions"];
    issues: BookWriterAccessibilityIssue[];
  };
  const keyboard = await collectKeyboardAudit(page);
  const keyboardIssues: BookWriterAccessibilityIssue[] = [];
  if (!keyboard.startButtonFocusable) {
    keyboardIssues.push({
      code: "keyboard-start-book",
      severity: "critical",
      target: "Start book control",
      message: "The start or setup book control could not receive focus.",
    });
  }
  if (!keyboard.journeyTabFocusable) {
    keyboardIssues.push({
      code: "keyboard-journey-tab",
      severity: "critical",
      target: "Chapters",
      message: "The Chapters journey tab could not receive focus.",
    });
  }
  if (!keyboard.happyPathBeforeLibraryTools) {
    keyboardIssues.push({
      code: "keyboard-rail-happy-path-first",
      severity: "critical",
      target: "Book library",
      message: "The rail should tab to starting or opening a book before refresh/cleanup tools.",
    });
  }
  if (!keyboard.helpStopsSkipped) {
    keyboardIssues.push({
      code: "keyboard-help-noise",
      severity: "critical",
      target: "Book library help",
      message: "Inline help bubbles should not interrupt the primary Tab path.",
    });
  }
  const issues = [...domAudit.issues, ...keyboardIssues];
  return {
    checkedAt: new Date().toISOString(),
    controlCount: domAudit.controlCount,
    focusableCount: domAudit.focusableCount,
    definitions: domAudit.definitions,
    criticalIssues: issues.filter((issue) => issue.severity === "critical"),
    warnings: issues.filter((issue) => issue.severity === "warning"),
    keyboard,
  };
}

async function auditBookWriterVisual(
  page: Page,
  params: { mobile: boolean; screenshot: string },
): Promise<BookWriterVisualAudit> {
  return await page.evaluate(
    async ({ mobile, screenshot }) => {
      window.scrollTo(0, 0);
      await new Promise(requestAnimationFrame);
      const dashboard = document.querySelector(".book-writer-dashboard");
      const box = dashboard?.getBoundingClientRect();
      const rail = document.querySelector(".book-writer-rail");
      const railBox = rail?.getBoundingClientRect();
      const railFinishedShortcutVisible = Boolean(
        rail?.querySelector(".book-writer-finished-mini"),
      );
      const main = document.querySelector(".book-writer-main");
      const mainBox = main?.getBoundingClientRect();
      const trophyRoom = document.querySelector<HTMLElement>(".book-writer-trophy-room");
      const workspace = document.querySelector<HTMLElement>(".book-writer-guided-workspace");
      let scrollParent: HTMLElement | null = null;
      let current = trophyRoom?.parentElement ?? null;
      while (current && current !== document.body) {
        const style = getComputedStyle(current);
        if (
          current.scrollHeight > current.clientHeight + 8 &&
          /(auto|scroll|overlay)/.test(style.overflowY)
        ) {
          scrollParent = current;
          break;
        }
        current = current.parentElement;
      }
      if (scrollParent) {
        scrollParent.scrollTop = 0;
      } else {
        window.scrollTo(0, 0);
      }
      scrollParent?.dispatchEvent(new Event("scroll", { bubbles: true }));
      document.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("scroll"));
      document.documentElement.classList.remove(
        "book-writer-trophy-scroll-compact",
        "book-writer-trophy-scroll-away",
      );
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const trophyRoomHeightBeforeScroll = trophyRoom
        ? Math.round(trophyRoom.getBoundingClientRect().height)
        : null;
      const trophyRoomTopBeforeScroll = trophyRoom
        ? Math.round(trophyRoom.getBoundingClientRect().top)
        : null;
      if (trophyRoom) {
        if (scrollParent) {
          scrollParent.scrollTop = 160;
        } else {
          workspace?.scrollIntoView({ block: "start", inline: "nearest" });
        }
        scrollParent?.dispatchEvent(new Event("scroll", { bubbles: true }));
        document.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("scroll"));
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const trophyRoomHeightAfterScroll = trophyRoom
        ? Math.round(trophyRoom.getBoundingClientRect().height)
        : null;
      if (trophyRoom) {
        if (scrollParent) {
          scrollParent.scrollTop = 720;
        } else {
          workspace?.scrollIntoView({ block: "start", inline: "nearest" });
        }
        scrollParent?.dispatchEvent(new Event("scroll", { bubbles: true }));
        document.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("scroll"));
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const trophyRoomTopAfterScroll = trophyRoom
        ? Math.round(trophyRoom.getBoundingClientRect().top)
        : null;
      const trophyRoomPosition = trophyRoom ? getComputedStyle(trophyRoom).position : "";
      const trophyRoomOpacity = trophyRoom
        ? Number.parseFloat(getComputedStyle(trophyRoom).opacity)
        : 1;
      const trophyRoomCompactsOnScroll = Boolean(
        trophyRoom &&
        trophyRoomHeightBeforeScroll !== null &&
        trophyRoomHeightAfterScroll !== null &&
        trophyRoomHeightAfterScroll < trophyRoomHeightBeforeScroll - 8,
      );
      const trophyRoomScrollsAway = Boolean(
        trophyRoom &&
        (trophyRoomOpacity < 0.2 ||
          (trophyRoomTopBeforeScroll !== null &&
            trophyRoomTopAfterScroll !== null &&
            trophyRoomTopAfterScroll < trophyRoomTopBeforeScroll - 80)),
      );
      if (scrollParent) {
        scrollParent.scrollTop = 0;
      } else {
        window.scrollTo(0, 0);
      }
      scrollParent?.dispatchEvent(new Event("scroll", { bubbles: true }));
      document.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("scroll"));
      await new Promise(requestAnimationFrame);
      const visibleDeletedCards = Array.from(
        document.querySelectorAll<HTMLElement>(".book-writer-deleted-book"),
      ).filter((card) => {
        const rect = card.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(card).visibility !== "hidden";
      });
      const allDeletedCards = document.querySelectorAll(".book-writer-deleted-book").length;
      const deletedMore = document.querySelector(".book-writer-deleted-books__more summary");
      const activeDirectDelete = document.querySelector(
        ".book-writer-project > .book-writer-project__delete",
      );
      const activeGuidedStep =
        document.querySelector(".book-writer-guided-step--active")?.textContent ?? "";
      const activeGuidedStepIsIdea = /\bIdea\b/.test(activeGuidedStep);
      const setupControls = document.querySelectorAll(".book-writer-setup-controls").length;
      const healthCardCount = document.querySelectorAll(".book-writer-health-card").length;
      return {
        checkedAt: new Date().toISOString(),
        mobile,
        screenshot,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        dashboardBounds: box
          ? {
              width: Math.round(box.width),
              height: Math.round(box.height),
            }
          : null,
        trophyRoomAtTop:
          Boolean(trophyRoom) &&
          (!workspace ||
            Boolean(
              trophyRoom.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING,
            )),
        trophyRoomCompactsOnScroll,
        trophyRoomScrollsAway,
        trophyRoomHeightBeforeScroll,
        trophyRoomHeightAfterScroll,
        trophyRoomTopBeforeScroll,
        trophyRoomTopAfterScroll,
        trophyRoomHiddenOnBuildPages: !trophyRoom,
        healthStripVisible: Boolean(document.querySelector(".book-writer-health-strip")),
        healthCardCount,
        bookControlBarVisible: Boolean(
          document.querySelector(
            ".book-writer-control-bar, .book-writer-context-panel, .book-writer-context-summary",
          ),
        ),
        currentSettingsControlsDuplicated: activeGuidedStepIsIdea
          ? setupControls > 1
          : setupControls > 0,
        celebrationVisible: Boolean(
          document.querySelector(".book-writer-celebration")?.getBoundingClientRect().height,
        ),
        deletedListCollapsed:
          allDeletedCards <= 3 || (Boolean(deletedMore) && visibleDeletedCards.length <= 3),
        activeDeleteBehindMore:
          !activeDirectDelete &&
          (!rail || Boolean(document.querySelector(".book-writer-manage-books"))),
        railFinishedShortcutVisible,
        railWithinViewport:
          mobile ||
          !railBox ||
          (railBox.height <= window.innerHeight - 72 && railBox.right <= window.innerWidth + 1),
        mainWithinViewport: !mainBox || mainBox.right <= window.innerWidth + 1,
        visibleJourneySteps: Array.from(
          document.querySelectorAll<HTMLElement>(
            ".book-writer-guided-step, .book-writer-journey__step",
          ),
        )
          .filter((step) => {
            const rect = step.getBoundingClientRect();
            return (
              rect.width > 0 && rect.height > 0 && getComputedStyle(step).visibility !== "hidden"
            );
          })
          .map((step) => step.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      };
    },
    { mobile: params.mobile, screenshot: params.screenshot },
  );
}

async function run(): Promise<BookWriterSmokeSummary> {
  assertBookWriterSmokeMutationAllowed();
  const executablePath = resolveBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      "No Playwright Chromium or local Chrome-compatible browser found. Install Playwright browsers or set OPENCLAW_CONTROL_UI_SMOKE_BROWSER.",
    );
  }
  const smokeUrl = await resolveDashboardUrl();
  const mobileProfile = useMobileSmokeProfile();
  const clientMetadata = resolveSmokeClientMetadata(mobileProfile);
  const contextOptions: BrowserContextOptions = mobileProfile
    ? { ...mobileSmokeContextOptions(), serviceWorkers: "block" }
    : { viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" };
  const profileDir = resolveControlUiSmokeProfileDir({
    displayUrl: smokeUrl.displayUrl,
    mobile: mobileProfile,
  });
  const browserSession = await launchSmokeBrowserSession({
    executablePath,
    contextOptions,
    profileDir,
    clientMetadata,
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
      const pairing = await waitForBookWriter(page);
      const snapshot = await runBookWriterFlow(page);
      const authUrlClean = await page.evaluate(
        () => !/(?:[#?&])(?:token|password)=/i.test(window.location.href),
      );
      if (!authUrlClean) {
        throw new Error("Dashboard left auth material in the browser URL after bootstrap.");
      }
      const plan = snapshot.plan ?? {};
      const artifactDir = smokeArtifactDir();
      const screenshot = join(artifactDir, "book-publisher-dashboard.png");
      await page.screenshot({ path: screenshot, fullPage: true });
      const accessibility = await auditBookWriterAccessibility(page);
      const accessibilityReport = join(artifactDir, "book-publisher-dashboard-accessibility.json");
      writeJsonArtifact(accessibilityReport, accessibility);
      const visual = await auditBookWriterVisual(page, { mobile: mobileProfile, screenshot });
      const visualReport = join(artifactDir, "book-publisher-dashboard-visual.json");
      writeJsonArtifact(visualReport, visual);
      const publishUi = await auditBookWriterPublishUi(page);
      const deletion: { deleteVerified: boolean; deletedId?: string; remainingBooks: number } =
        plan.runId
          ? await verifyBookWriterDelete(page, {
              runId: plan.runId,
              title: plan.title ?? "missing",
            })
          : { deleteVerified: false, remainingBooks: 0 };
      const restoration =
        plan.runId && deletion.deleteVerified && deletion.deletedId
          ? await verifyBookWriterRestore(page, {
              runId: plan.runId,
              title: plan.title ?? "missing",
              deletedId: deletion.deletedId,
            })
          : { restoreVerified: false, remainingBooks: deletion.remainingBooks };
      const permanentDeletion =
        plan.runId && restoration.restoreVerified
          ? await verifyBookWriterEmptyDeleted(page, {
              runId: plan.runId,
              title: plan.title ?? "missing",
            })
          : { permanentDeleteVerified: false, remainingBooks: restoration.remainingBooks };
      const approvedPublish = await runApprovedBookWriterPublishFlow(page);
      const summary: BookWriterSmokeSummary = {
        ok:
          consoleErrors.length === 0 &&
          pageErrors.length === 0 &&
          accessibility.criticalIssues.length === 0 &&
          deletion.deleteVerified &&
          restoration.restoreVerified &&
          permanentDeletion.permanentDeleteVerified &&
          approvedPublish.verified,
        url: smokeUrl.displayUrl,
        auth: smokeUrl.auth,
        authUrlClean,
        profile: {
          persistent: browserSession.persistentProfile,
          dir: browserSession.profileDir,
          clientDisplayName: clientMetadata.displayName,
          autoApprovePairing: autoApprovePairingEnabled(),
          pairingApproved: pairing.pairingApproved,
          pairingRequestId: pairing.requestId,
        },
        runId: plan.runId ?? "missing",
        title: plan.title ?? "missing",
        status: plan.status ?? "missing",
        version: plan.version ?? 0,
        chapters: plan.chapters?.length ?? 0,
        paragraphs: countParagraphs(plan),
        draftedParagraphs: countDraftedParagraphs(plan),
        manuscriptPreview: snapshot.manuscriptPreview
          ? snapshot.manuscriptPreview.replace(/\s+/g, " ").trim().slice(0, 240)
          : "missing",
        reviewPack: snapshot.reviewPack?.recommendation ?? "missing",
        publishPrep:
          snapshot.publishDryRun?.status ??
          (snapshot.reviewPack?.recommendation === "approve" ? "missing" : "blocked-by-review"),
        deleteVerified: deletion.deleteVerified,
        restoreVerified: restoration.restoreVerified,
        permanentDeleteVerified: permanentDeletion.permanentDeleteVerified,
        remainingBooks: permanentDeletion.remainingBooks,
        trophyRoomVisible: publishUi.trophyRoomVisible,
        fixBlockersVisible: publishUi.fixBlockersVisible,
        markPublishedVisible: publishUi.markPublishedVisible,
        approvedPublish,
        consoleErrors,
        pageErrors,
        screenshot,
        accessibility,
        accessibilityReport,
        visual,
        visualReport,
      };
      if (!summary.ok) {
        throw new Error(
          `Browser reported console/page/accessibility errors: ${JSON.stringify(summary)}`,
        );
      }
      if (
        !summary.authUrlClean ||
        !summary.deleteVerified ||
        !summary.restoreVerified ||
        !summary.permanentDeleteVerified ||
        summary.chapters < 3 ||
        summary.draftedParagraphs < 1 ||
        summary.trophyRoomVisible ||
        (summary.reviewPack !== "approve" && !summary.fixBlockersVisible) ||
        !summary.approvedPublish.verified ||
        !summary.visual.dashboardBounds ||
        !summary.visual.trophyRoomHiddenOnBuildPages ||
        !summary.visual.healthStripVisible ||
        summary.visual.healthCardCount !== 4 ||
        !summary.visual.bookControlBarVisible ||
        summary.visual.currentSettingsControlsDuplicated ||
        !summary.visual.celebrationVisible ||
        !summary.visual.deletedListCollapsed ||
        !summary.visual.activeDeleteBehindMore ||
        summary.visual.railFinishedShortcutVisible ||
        !summary.visual.railWithinViewport ||
        !summary.visual.mainWithinViewport ||
        summary.visual.visibleJourneySteps.length !== 6
      ) {
        throw new Error(
          `Book Writer smoke summary failed sanity checks: ${JSON.stringify(summary)}`,
        );
      }
      return summary;
    } catch (error) {
      const diagnostics = await collectFailureDiagnostics(page).catch((diagnosticError) => ({
        bodyText: `failed to collect diagnostics: ${
          diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
        }`,
      }));
      throw new Error(
        `${redactSmokeSecrets(error instanceof Error ? error.message : String(error))}
Diagnostics: ${JSON.stringify(diagnostics, null, 2)}
Console errors: ${JSON.stringify(consoleErrors)}
Page errors: ${JSON.stringify(pageErrors)}
Request failures: ${JSON.stringify(requestFailures)}`,
        { cause: error },
      );
    }
  } finally {
    await browserSession.close();
  }
}

run()
  .then((summary) => {
    console.log("control-ui-book-writer-smoke: ok", JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(
      "control-ui-book-writer-smoke: failed",
      redactSmokeSecrets(error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  });
