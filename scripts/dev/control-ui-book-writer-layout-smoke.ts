import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import {
  extractControlUiPairingRequestId,
  redactControlUiSmokeSecrets,
  resolveControlUiSmokeProfileDir,
  resolveControlUiSmokeUrl,
} from "./control-ui-smoke-url.js";

function bookWriterUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = "/book-writer";
  return url.toString();
}

function displayUrl(rawUrl: string): string {
  const url = new URL(bookWriterUrl(rawUrl));
  url.hash = "";
  url.searchParams.delete("token");
  url.searchParams.delete("password");
  return url.toString();
}

async function approvePairingIfNeeded(pageText: string): Promise<boolean> {
  const requestId = extractControlUiPairingRequestId(pageText);
  if (!requestId) {
    return false;
  }
  const result = spawnSync("pnpm", ["openclaw", "devices", "approve", requestId], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `Pairing approval failed with status ${result.status}: ${redactControlUiSmokeSecrets(
        result.stderr || result.stdout,
      )}`,
    );
  }
  return true;
}

type LayoutSmokeSummary = {
  ok: boolean;
  displayUrl: string;
  pairedDuringSmoke: boolean;
  authUrlClean: boolean;
  openedExistingProject: boolean;
  projectCountBefore: number;
  projectCountAfter: number;
  noNewBookCreated: boolean;
  stepCount: number;
  compactCommandBarVisible: boolean;
  workspaceDirectlyFollowsHeader: boolean;
  workspaceStartsWithin160px: boolean;
  headerToWorkspacePx: number | null;
  oldScrollBlockersAbsent: boolean;
  readerBadgeVisible: boolean;
  healthBadgeVisible: boolean;
  primaryActionVisible: boolean;
};

async function run(): Promise<LayoutSmokeSummary> {
  const smokeUrl = await resolveControlUiSmokeUrl();
  const cleanDisplayUrl = displayUrl(smokeUrl.displayUrl);
  const launchUrl = bookWriterUrl(smokeUrl.launchUrl);
  const profileDir = resolveControlUiSmokeProfileDir({
    displayUrl: cleanDisplayUrl,
    mobile: false,
  });
  const context = await chromium.launchPersistentContext(profileDir ?? "", {
    headless: true,
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(launchUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForSelector("body", { timeout: 10_000 });
    let bodyText = await page.locator("body").textContent({ timeout: 10_000 });
    const pairedDuringSmoke = await approvePairingIfNeeded(bodyText);
    if (pairedDuringSmoke) {
      await page.goto(launchUrl, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForSelector("body", { timeout: 10_000 });
      bodyText = await page.locator("body").textContent({ timeout: 10_000 });
    }
    await page.waitForSelector(".book-writer-dashboard", { timeout: 20_000 });

    const projectCountBefore = await page.evaluate(
      `(() => {
        const app = document.querySelector("openclaw-app");
        return app?.bookWriterDashboard?.projects?.length ?? document.querySelectorAll(".book-writer-project__select").length;
      })()`,
    );
    const firstProject = page.locator(".book-writer-project__select").first();
    if ((await firstProject.count()) === 0) {
      throw new Error(
        "No existing Book Publisher draft is available for non-mutating layout smoke.",
      );
    }
    await firstProject.click({ timeout: 10_000 });
    await page.waitForSelector(".book-writer-guided-header", { timeout: 20_000 });
    await page.waitForSelector(".book-writer-guided-workspace", { timeout: 20_000 });
    await page.waitForTimeout(500);

    const evaluated = await page.evaluate(`(() => {
      const header = document.querySelector(".book-writer-guided-header");
      const workspace = document.querySelector(".book-writer-guided-workspace");
      const commandRow = document.querySelector(".book-writer-command-row");
      const oldBlockers = [
        ".book-writer-mini-preview",
        ".book-writer-health-strip",
        ".book-writer-plan-write-legend",
      ];
      const headerBox = header ? header.getBoundingClientRect() : null;
      const workspaceBox = workspace ? workspace.getBoundingClientRect() : null;
      const headerToWorkspacePx = headerBox && workspaceBox ? Math.round(workspaceBox.top - headerBox.top) : null;
      return {
        authUrlClean: !/(?:[#?&])(?:token|password)=/i.test(window.location.href),
        projectCountAfter: document.querySelector("openclaw-app")?.bookWriterDashboard?.projects?.length ?? document.querySelectorAll(".book-writer-project__select").length,
        stepCount: document.querySelectorAll(".book-writer-guided-step").length,
        compactCommandBarVisible: Boolean(commandRow),
        workspaceDirectlyFollowsHeader: Boolean(header && workspace && header.nextElementSibling === workspace),
        workspaceStartsWithin160px: headerToWorkspacePx !== null && headerToWorkspacePx <= 160,
        headerToWorkspacePx,
        oldScrollBlockersAbsent: oldBlockers.every((selector) => !document.querySelector(selector)),
        readerBadgeVisible: Boolean(document.querySelector(".book-writer-command-popover--reader")),
        healthBadgeVisible: Boolean(document.querySelector(".book-writer-guided-header__status")),
        primaryActionVisible: Boolean(document.querySelector(".book-writer-command-primary")),
      };
    })()`);

    const noNewBookCreated = evaluated.projectCountAfter === projectCountBefore;
    const summary: LayoutSmokeSummary = {
      ok:
        evaluated.authUrlClean &&
        noNewBookCreated &&
        evaluated.stepCount === 6 &&
        evaluated.compactCommandBarVisible &&
        evaluated.workspaceDirectlyFollowsHeader &&
        evaluated.workspaceStartsWithin160px &&
        evaluated.oldScrollBlockersAbsent &&
        evaluated.readerBadgeVisible &&
        evaluated.healthBadgeVisible &&
        evaluated.primaryActionVisible,
      displayUrl: cleanDisplayUrl,
      pairedDuringSmoke,
      authUrlClean: evaluated.authUrlClean,
      openedExistingProject: true,
      projectCountBefore,
      projectCountAfter: evaluated.projectCountAfter,
      noNewBookCreated,
      stepCount: evaluated.stepCount,
      compactCommandBarVisible: evaluated.compactCommandBarVisible,
      workspaceDirectlyFollowsHeader: evaluated.workspaceDirectlyFollowsHeader,
      workspaceStartsWithin160px: evaluated.workspaceStartsWithin160px,
      headerToWorkspacePx: evaluated.headerToWorkspacePx,
      oldScrollBlockersAbsent: evaluated.oldScrollBlockersAbsent,
      readerBadgeVisible: evaluated.readerBadgeVisible,
      healthBadgeVisible: evaluated.healthBadgeVisible,
      primaryActionVisible: evaluated.primaryActionVisible,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      throw new Error(`Book Publisher layout smoke failed: ${JSON.stringify(summary)}`);
    }
    return summary;
  } finally {
    await context.close();
  }
}

run().catch((error) => {
  console.error(
    redactControlUiSmokeSecrets(error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
});
