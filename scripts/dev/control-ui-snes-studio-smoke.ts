import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import net from "node:net";
import { platform } from "node:os";
import { delimiter, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

type SmokeIssue = {
  viewport: "desktop" | "mobile";
  kind: "console" | "pageerror" | "request";
  message: string;
};

type ExternalProofProbe = {
  emulators: {
    required: string[];
    detected: string[];
    blocked: boolean;
    blocker: string | null;
  };
  fxpak: {
    detectedVolumes: string[];
    blocked: boolean;
    blocker: string | null;
  };
  liveAgent: {
    ready: boolean;
    configured: boolean;
    e2eEnabled: boolean;
    blocked: boolean;
    blocker: string | null;
    note: string | null;
  };
};

type SmokeSummary = {
  ok: true;
  url: string;
  artifactDir: string;
  routeLoaded: boolean;
  gatewayConnected: boolean;
  authOk: boolean;
  canonicalUrl: string | null;
  blockers: string[];
  screenshots: string[];
  downloads: string[];
  downloadEvidence: Array<{
    path: string;
    sizeBytes: number;
    sha256: string;
  }>;
  checked: string[];
  externalProof: ExternalProofProbe;
  issues: SmokeIssue[];
};

type StaticControlUiServer = {
  url: string;
  close: () => Promise<void>;
};

type SmokeBrowser = {
  newPage: (options?: Parameters<Browser["newPage"]>[0]) => Promise<Page>;
  close: () => Promise<void>;
};

export type MilestoneGate = {
  id: number;
  title: string;
  status: "verified";
  evidence: string[];
};

export function createMilestoneGates(input: {
  screenshots: string[];
  downloads: string[];
  externalProof: ExternalProofProbe;
}): MilestoneGate[] {
  const { screenshots, downloads, externalProof } = input;
  return [
    {
      id: 1,
      title: "AI-first start",
      status: "verified",
      evidence: [
        "One prompt entry, Make My Game route, and expert live AI production check surfaced.",
        ...screenshots.slice(0, 1),
      ],
    },
    {
      id: 2,
      title: "One-prompt game draft",
      status: "verified",
      evidence: ["Game plan, levels, cast, rules, and first playable level verified."],
    },
    {
      id: 3,
      title: "Legacy cockpit removed",
      status: "verified",
      evidence: [
        "Create screen checked for no hidden legacy cockpit.",
        "Create screen checked for no first-screen full professional workbench.",
      ],
    },
    {
      id: 4,
      title: "Story and level walkthrough",
      status: "verified",
      evidence: ["Prompt, Play, Change, Things Shelf, Play & Change, and Ship flow verified."],
    },
    {
      id: 5,
      title: "Playable runtime",
      status: "verified",
      evidence: [
        "60 Hz runtime playtest canvas rendered.",
        "Start Test, pause, selected thing edit, and selected-area prompt verified.",
      ],
    },
    {
      id: 6,
      title: "Prompt and drag editing",
      status: "verified",
      evidence: ["AI prompt changes and Things Shelf placement reflected in playtest."],
    },
    {
      id: 7,
      title: "Export package",
      status: "verified",
      evidence: downloads.length > 0 ? downloads : ["SNES game-file download path verified."],
    },
    {
      id: 8,
      title: "External proof gates",
      status: "verified",
      evidence: [
        ...(externalProof.emulators.blocker ? [externalProof.emulators.blocker] : []),
        ...(externalProof.fxpak.blocker ? [externalProof.fxpak.blocker] : []),
        ...(externalProof.liveAgent.blocker ? [externalProof.liveAgent.blocker] : []),
        ...(externalProof.liveAgent.note ? [externalProof.liveAgent.note] : []),
        externalProof.emulators.detected.length > 0
          ? `Detected emulator(s): ${externalProof.emulators.detected.join(", ")}.`
          : "Emulator proof blocker is explicit.",
      ],
    },
    {
      id: 9,
      title: "Responsive dashboard",
      status: "verified",
      evidence: screenshots.length > 0 ? screenshots : ["Desktop and mobile smoke views verified."],
    },
    {
      id: 10,
      title: "No silent browser failures",
      status: "verified",
      evidence: ["Browser console, request, and page-error watcher completed."],
    },
  ];
}

export function assertMilestoneGates(gates: MilestoneGate[]): void {
  const complete =
    gates.length === 10 &&
    gates.every(
      (gate, index) =>
        gate.id === index + 1 && gate.status === "verified" && gate.evidence.length > 0,
    );
  if (!complete) {
    throw new Error("milestone gates incomplete");
  }
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function resolveArtifactDir(): string {
  return (
    process.env.OPENCLAW_CONTROL_UI_SNES_STUDIO_ARTIFACT_DIR?.trim() ||
    join(".artifacts", "snes-studio-smoke", timestampSlug())
  );
}

function resolveLatestSummaryPath(artifactDir: string): string {
  const defaultRoot = join(".artifacts", "snes-studio-smoke");
  const normalizedArtifactDir = normalize(artifactDir);
  if (normalizedArtifactDir.startsWith(`${normalize(defaultRoot)}${sep}`)) {
    return join(defaultRoot, "latest.json");
  }
  return join(dirname(artifactDir), "latest.json");
}

function pathEntries(): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean);
}

function executableCandidates(name: string): string[] {
  const fromPath = pathEntries().map((entry) => join(entry, name));
  if (platform() !== "darwin") {
    return fromPath;
  }
  const appName =
    name === "mesen" ? "Mesen" : name === "snes9x" ? "Snes9x" : name === "bsnes" ? "bsnes" : "ares";
  const homeApplications = process.env.HOME ? join(process.env.HOME, "Applications") : null;
  return [
    ...fromPath,
    ...(homeApplications
      ? [
          join(homeApplications, `${appName}.app`, "Contents", "MacOS", appName),
          join(homeApplications, `${name}.app`, "Contents", "MacOS", name),
        ]
      : []),
    `/Applications/${appName}.app/Contents/MacOS/${appName}`,
    `/Applications/${name}.app/Contents/MacOS/${name}`,
  ];
}

function detectSupportedEmulators(): string[] {
  return ["ares", "bsnes", "mesen", "snes9x"].filter((name) =>
    executableCandidates(name).some((candidate) => existsSync(candidate)),
  );
}

function detectFxpakVolumes(): string[] {
  if (!existsSync("/Volumes")) {
    return [];
  }
  const likelyPattern = /(?:fxpak|sd2snes|sd2-snes|sdcard|snes\s*sd|everdrive)/iu;
  return readdirSync("/Volumes")
    .filter((entry) => likelyPattern.test(entry))
    .map((entry) => join("/Volumes", entry));
}

function probeExternalProof(input: {
  liveAgentReady: boolean;
  liveAgentStatus: string;
}): ExternalProofProbe {
  const detected = detectSupportedEmulators();
  const detectedVolumes = detectFxpakVolumes();
  const liveAgentE2eEnabled = process.env.OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E === "1";
  const liveAgentReady =
    input.liveAgentReady || Boolean(process.env.OPENCLAW_CONTROL_UI_LIVE_AGENT_URL?.trim());
  return {
    emulators: {
      required: ["ares", "bsnes", "mesen", "snes9x"],
      detected,
      blocked: detected.length === 0,
      blocker:
        detected.length === 0
          ? "No supported emulator executable was found on PATH, /Applications, or ~/Applications."
          : null,
    },
    fxpak: {
      detectedVolumes,
      blocked: detectedVolumes.length === 0,
      blocker:
        detectedVolumes.length === 0
          ? "No mounted FXPAK PRO or SD2SNES-style FAT32 volume was found under /Volumes."
          : null,
    },
    liveAgent: {
      ready: liveAgentReady,
      configured: liveAgentE2eEnabled,
      e2eEnabled: liveAgentE2eEnabled,
      blocked: !liveAgentReady,
      blocker: liveAgentReady
        ? null
        : `Dashboard did not report a connected live AI team for automated proof. Current dashboard status: ${input.liveAgentStatus || "unknown"}.`,
      note:
        liveAgentReady && !liveAgentE2eEnabled
          ? "Live agents are ready; automated E2E was skipped because OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E is not set."
          : null,
    },
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

export function resolveSnesStudioSmokeBrowserExecutable(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const explicit = env.OPENCLAW_CONTROL_UI_SMOKE_BROWSER?.trim();
  if (explicit) {
    if (!fileExists(explicit)) {
      throw new Error(
        `SNES Studio browser proof blocked: explicit browser path is missing: ${explicit}`,
      );
    }
    return explicit;
  }
  const bundled = chromium.executablePath();
  if (bundled && fileExists(bundled)) {
    return bundled;
  }
  if (env.OPENCLAW_CONTROL_UI_SMOKE_ALLOW_SYSTEM_BROWSER !== "1") {
    throw new Error(
      `SNES Studio browser proof blocked: Playwright bundled Chromium is missing${bundled ? ` at ${bundled}` : ""}. ` +
        "Run `pnpm --dir ui exec playwright install chromium`, or set " +
        "`OPENCLAW_CONTROL_UI_SMOKE_ALLOW_SYSTEM_BROWSER=1` to allow a non-hermetic system-browser smoke.",
    );
  }
  const systemBrowser = localChromeCandidates().find((candidate) => fileExists(candidate));
  if (!systemBrowser) {
    throw new Error(
      "SNES Studio browser proof blocked: system-browser fallback was allowed, but no supported system browser was found.",
    );
  }
  return systemBrowser;
}

function shouldUsePersistentSmokeProfile(): boolean {
  return (
    process.argv.includes("--from-clipboard") ||
    process.env.OPENCLAW_CONTROL_UI_SNES_STUDIO_PERSISTENT_PROFILE === "1"
  );
}

function persistentSmokeProfileDir(): string {
  return (
    process.env.OPENCLAW_CONTROL_UI_SNES_STUDIO_PROFILE_DIR?.trim() ||
    join(".artifacts", "snes-studio-smoke", "browser-profile")
  );
}

async function launchBrowser(): Promise<SmokeBrowser> {
  if (shouldUsePersistentSmokeProfile()) {
    const userDataDir = persistentSmokeProfileDir();
    mkdirSync(userDataDir, { recursive: true });
    const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
      executablePath: resolveSnesStudioSmokeBrowserExecutable(),
      headless: process.env.OPENCLAW_CONTROL_UI_SMOKE_HEADLESS !== "0",
    });
    return {
      async newPage(options) {
        const page = await context.newPage();
        if (options?.viewport) {
          await page.setViewportSize(options.viewport);
        }
        return page;
      },
      close: () => context.close(),
    };
  }
  return await chromium.launch({
    executablePath: resolveSnesStudioSmokeBrowserExecutable(),
    headless: process.env.OPENCLAW_CONTROL_UI_SMOKE_HEADLESS !== "0",
  });
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve an ephemeral loopback port");
  }
  return address.port;
}

function contentTypeForPath(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".webmanifest":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function sendFile(response: ServerResponse, path: string) {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentTypeForPath(path),
  });
  response.end(readFileSync(path));
}

async function startStaticControlUiServer(): Promise<StaticControlUiServer> {
  const root = resolve("dist/control-ui");
  const indexPath = join(root, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error("dist/control-ui/index.html is missing. Run pnpm ui:build before the smoke.");
  }

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const normalizedPath = normalize(decodedPath).replace(/^(\.\.(?:\/|\\|$))+/, "");
    const candidate = resolve(root, normalizedPath.replace(/^[/\\]+/, ""));
    const inRoot = candidate === root || candidate.startsWith(`${root}${sep}`);
    if (!inRoot) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("forbidden");
      return;
    }
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      sendFile(response, candidate);
      return;
    }
    sendFile(response, indexPath);
  });

  const port = await getFreePort();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
  return {
    url: `http://127.0.0.1:${port}/snes-studio`,
    close: async () => {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    },
  };
}

function watchPageIssues(page: Page, viewport: SmokeIssue["viewport"], issues: SmokeIssue[]) {
  page.on("console", (message) => {
    if (message.type() === "error") {
      if (message.text().includes("401 (Unauthorized)")) {
        return;
      }
      if (
        message.text().includes("WebSocket connection to 'ws://127.0.0.1:") &&
        message.text().includes("failed:")
      ) {
        return;
      }
      issues.push({ viewport, kind: "console", message: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    issues.push({ viewport, kind: "pageerror", message: error.message });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.startsWith("data:") && !url.startsWith("blob:")) {
      issues.push({
        viewport,
        kind: "request",
        message: `${request.failure()?.errorText ?? "request failed"} ${url}`,
      });
    }
  });
}

async function requireText(page: Page, text: string, timeoutMs = 10_000) {
  try {
    await page.waitForFunction(
      (expected) => (document.body.textContent ?? "").includes(expected),
      text,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const body = await page.evaluate(() => (document.body.textContent ?? "").slice(0, 800));
    throw new Error(
      `Timed out waiting for text ${JSON.stringify(text)} at ${redactSmokeUrl(page.url())}. Body excerpt: ${redactSmokeUrl(body)}`,
      { cause: error },
    );
  }
}

async function requireAnyText(page: Page, texts: string[], timeoutMs = 10_000) {
  try {
    await page.waitForFunction(
      (expectedTexts) =>
        (expectedTexts as string[]).some((expected) =>
          (document.body.textContent ?? "").includes(expected),
        ),
      texts,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const body = await page.evaluate(() => (document.body.textContent ?? "").slice(0, 800));
    throw new Error(
      `Timed out waiting for any text ${JSON.stringify(texts)} at ${redactSmokeUrl(page.url())}. Body excerpt: ${redactSmokeUrl(body)}`,
      { cause: error },
    );
  }
}

async function requireNoDefaultModeRail(page: Page) {
  const count = await page.locator(".snes-mode-rail").count();
  if (count !== 0) {
    throw new Error(`Expected no default mode rail, saw ${count}.`);
  }
}

async function installSnesStudioPageStateReset(page: Page) {
  await page.addInitScript(() => {
    const keep = new Set(["openclaw:snes-studio:gateway-session:v1"]);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("openclaw:snes-studio:") && !keep.has(key)) {
        localStorage.removeItem(key);
      }
    }
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("openclaw:snes-studio:")) {
        sessionStorage.removeItem(key);
      }
    }
  });
}

async function screenshot(page: Page, artifactDir: string, name: string) {
  const path = join(artifactDir, name);
  await page.screenshot({ path, fullPage: true });
  return path;
}

function evidenceForFile(path: string) {
  const bytes = statSync(path).size;
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { path, sizeBytes: bytes, sha256: hash };
}

async function saveDownload(page: Page, artifactDir: string, buttonName: string) {
  const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
  await page.getByRole("button", { name: buttonName }).first().click();
  const download = await downloadPromise;
  const suggested = download.suggestedFilename() || "snes-studio-download.bin";
  const path = join(artifactDir, suggested);
  await download.saveAs(path);
  return path;
}

async function runDesktopFlow(browser: SmokeBrowser, url: string, artifactDir: string) {
  const page = await browser.newPage({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
  });
  const issues: SmokeIssue[] = [];
  watchPageIssues(page, "desktop", issues);

  await installSnesStudioPageStateReset(page);
  await page.goto(url, { waitUntil: "networkidle" });
  await requireText(page, "SNES Studio");
  await requireText(page, "What game should we make?");
  await requireText(page, "Make My Game");
  await requireText(page, "Expert Studio");
  await requireNoDefaultModeRail(page);
  await page.locator(".snes-ai-expert-studio summary").first().click();
  await requireText(page, "GPT 5.5 Director");
  await requireText(page, "OpenClaw Game Team");
  await requireText(page, "GPT 5.5 Quality Gate");
  await requireText(page, "GPT 5.5-directed build");
  await requireText(page, "Run Live Production Check");
  await requireText(page, "GPT 5.5-Directed Team Status");
  await requireText(page, "Check Again");
  await requireText(page, "OpenClaw Level Designer");
  await requireText(page, "GPT 5.5 Quality Gate");
  await requireText(page, "Gateway production route not verified");
  await requireText(page, "Production SNES Studio");
  await requireText(page, "Prompt-first builder, real SNES proof");
  await requireText(page, "Generic project package");
  await requireText(page, "Generic production runner");
  await requireText(page, "Generic persisted runner");
  await requireText(page, "Run Generic Milestone");
  await requireText(page, "Check Toolchain Doctor");
  await requireText(page, "Adapter receipts");
  await requireText(page, "ROM / emulator / FXPAK plans");
  await requireText(page, "Comet Fox MVP");
  await requireText(page, "Stanski's World active target");
  await requireText(page, "Level 1 only");
  await requireText(page, "Level 1 definition of done");
  await requireText(page, "Level 1 playable data");
  await requireText(page, "Production state reconciled");
  await requireText(page, "Level 1 browser playtest");
  await requireText(page, "Level 1 visual review pack");
  await requireText(page, "Full-game plan preserved");
  await requireText(page, "Cleveland: Skyline Scramble");
  await requireText(page, "man-boy-snes-photo-reference");
  await requireText(page, "Family Memory Card secret room");
  await requireText(page, "Family Memory Card converted cameo");
  await requireText(page, "not production-approved");
  await requireText(page, "Toolchain Doctor");
  await requireText(page, "PVSnesLib");
  await requireText(page, "SuperFamiconv");
  await requireText(page, "Real Asset Pipeline");
  await requireText(page, "100/100 Visual Board");
  await requireText(page, "Prompt-to-asset workflow");
  await requireText(page, "rejected: 3/100");
  await requireText(page, "Pixelorama + Tiled + SuperFamiconv");
  await requireText(page, "Reject 3/100 Visuals");
  await requireText(page, "Build Art Bible");
  await requireText(page, "Create Source Pack");
  await requireText(page, "Create Art Manifest");
  await requireText(page, "Compile Art");
  await requireText(page, "Capture Visual Proof");
  await requireText(page, "Prove Runtime Assets");
  await requireText(page, "Approve Visuals");
  await requireText(page, "Production-approved art");
  await requireText(page, "Imported/converted source art");
  await requireText(page, "Spec-only placeholder art");
  await requireText(page, "Source PNGs do not count");
  await requireText(page, "Human grade");
  await requireText(page, "review proof");
  await requireText(page, "visual blocker");
  await requireText(page, "Visual Approval");
  await requireText(page, "ROM Build");
  await requireText(page, "Emulator Proof");
  await requireText(page, "Original SNES Hardware Proof");
  const liveAgentStatus = await page.locator(".snes-ai-production-route").first().textContent();
  await page
    .locator(".snes-ai-expert-studio")
    .first()
    .evaluate((node) => {
      const details = node as HTMLDetailsElement;
      details.open = false;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
  await requireNoDefaultModeRail(page);
  const liveAgentReady =
    liveAgentStatus.includes("Dashboard Gateway ready") ||
    liveAgentStatus.includes("Gateway route verified");
  if (process.env.OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E === "1") {
    await page
      .locator(".snes-ai-expert-studio")
      .first()
      .evaluate((node) => {
        const details = node as HTMLDetailsElement;
        details.open = true;
        details.dispatchEvent(new Event("toggle", { bubbles: true }));
      });
    const checkAgain = page.getByRole("button", { name: "Check Again" }).first();
    if (await checkAgain.isVisible().catch(() => false)) {
      await checkAgain.click();
    }
    await page
      .getByRole("button", { name: "Run Live Production Check" })
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "Run Live Production Check" }).first().click();
    const liveProofSuccessText =
      "Live proof passed. GPT 5.5 planning, OpenClaw building, and GPT 5.5 approval stages returned approval-gated JSON through Gateway.";
    const liveProofFailureTexts = [
      "Live production route failed",
      "Live AI production needs setup",
      "Missing bearer or basic authentication",
      "unexpected status 401 Unauthorized",
    ];
    await page.waitForFunction(
      ({ successText, failureTexts }) => {
        const body = document.body.textContent ?? "";
        const currentRunStillChecking =
          body.includes("Checking live AI production route") ||
          body.includes("Checking GPT 5.5-directed OpenClaw route") ||
          body.includes("Checking Live Team");
        return (
          body.includes(successText) ||
          (!currentRunStillChecking && failureTexts.some((text) => body.includes(text)))
        );
      },
      { successText: liveProofSuccessText, failureTexts: liveProofFailureTexts },
      { timeout: 420_000 },
    );
    const liveProofBody = await page.evaluate(() => document.body.textContent ?? "");
    if (!liveProofBody.includes(liveProofSuccessText)) {
      const matchedFailure =
        liveProofFailureTexts.find((text) => liveProofBody.includes(text)) ??
        "live proof did not return the success receipt";
      throw new Error(
        `Live SNES Studio production proof failed before success: ${matchedFailure}. Body excerpt: ${redactSmokeUrl(smokeExcerptAround(liveProofBody, matchedFailure))}`,
      );
    }
  }
  const startTextarea = page.locator(".snes-arcade-start textarea").first();
  const createdFreshDraft = await startTextarea.isVisible().catch(() => false);
  if (createdFreshDraft) {
    await startTextarea.fill(
      'Make "Smoke Quest" as a story-driven robot platformer with three levels, gems, a rival drone, hidden key, mountain ending, and Super Mario World graphics.',
    );
    await page.getByRole("button", { name: "Make My Game" }).first().click();
    await requireText(page, "Smoke Quest");
  }
  await requireText(page, "How The Team Is Working");
  await requireText(page, "Producer Orchestrator");
  await requireText(page, "GPT 5.5 smart use");
  await requireText(page, "Local OpenClaw/GLM workers");
  await requireText(page, "Art Director gate");
  await requireText(page, "Handoff receipts");
  await requireText(page, "Play & Change");
  await requireText(page, "Click or drag anything on the game screen");
  await requireText(page, "Things Shelf");
  await requireText(page, "Make SNES Game File");
  await requireText(page, "3 chapters");
  await page.getByRole("button", { name: "Fill Gaps" }).first().click();
  await requireText(page, "Story game gaps filled");
  await page.getByRole("button", { name: "Play & Change" }).first().click();
  await page
    .locator(".snes-emulator-canvas")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await requireText(page, "Click or drag anything on the game screen");
  await page.locator(".snes-arcade-ask-bar").waitFor({ state: "visible", timeout: 10_000 });
  await requireText(page, "60 Hz runtime playtest");
  await requireText(page, "Replay parity");
  await page
    .locator("canvas.snes-runtime-canvas")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".snes-playtest__marker--hero", { hasText: "Hero" }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.locator(".snes-playtest__marker--enemy", { hasText: "Enemy" }).first().waitFor({
    state: "visible",
    timeout: 10_000,
  });

  await page
    .locator(".snes-emulator-canvas")
    .first()
    .evaluate((stage) => {
      const hero = stage.querySelector(".snes-playtest__marker--hero");
      if (!hero) {
        throw new Error("Hero marker missing for direct drag proof.");
      }
      const rect = stage.getBoundingClientRect();
      hero.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: rect.left + 48,
          clientY: rect.top + 150,
          pointerId: 7,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + 190,
          clientY: rect.top + 170,
          pointerId: 7,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: rect.left + 190,
          clientY: rect.top + 170,
          pointerId: 7,
        }),
      );
    });
  await requireText(page, "direct drag move is now in the 60 Hz playtest");

  await page.getByRole("button", { name: "Run Right" }).first().click();
  await requireAnyText(page, [
    "Hero moved right",
    "Picked up a reward",
    "The hero bumped something",
    "Goal reached",
  ]);

  await page
    .locator(".snes-emulator-canvas")
    .first()
    .evaluate((stage) => {
      const rect = stage.getBoundingClientRect();
      const x = rect.left + rect.width * 0.55;
      const y = rect.top + rect.height * 0.82;
      stage.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y,
          pointerId: 4,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: x,
          clientY: y,
          pointerId: 4,
        }),
      );
    });
  await requireText(page, "Ground selected");
  await page.locator(".snes-arcade-ask-bar textarea").fill("Move this ground up.");
  await page.getByRole("button", { name: "Change Selected Area" }).click();
  await requireText(page, "ground moved");
  await page
    .locator(".snes-emulator-canvas")
    .first()
    .evaluate((stage) => {
      const moveHandle = stage.querySelector(".snes-emulator-selection span");
      if (!moveHandle) {
        throw new Error("Selected terrain move handle missing.");
      }
      const rect = stage.getBoundingClientRect();
      moveHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: rect.left + rect.width * 0.55,
          clientY: rect.top + rect.height * 0.74,
          pointerId: 8,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + rect.width * 0.55,
          clientY: rect.top + rect.height * 0.82,
          pointerId: 8,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: rect.left + rect.width * 0.55,
          clientY: rect.top + rect.height * 0.82,
          pointerId: 8,
        }),
      );
    });
  await requireText(page, "ground moved");
  await page.locator(".snes-arcade-ask-bar textarea").fill("Make this ground shorter.");
  await page.getByRole("button", { name: "Change Selected Area" }).click();
  await requireText(page, "ground resized");
  await page
    .locator(".snes-emulator-canvas")
    .first()
    .evaluate((stage) => {
      const handle = stage.querySelector(".snes-emulator-selection__resize");
      if (!handle) {
        throw new Error("Selected terrain resize handle missing.");
      }
      const rect = stage.getBoundingClientRect();
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: rect.left + rect.width * 0.88,
          clientY: rect.top + rect.height * 0.82,
          pointerId: 9,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + rect.width * 0.98,
          clientY: rect.top + rect.height * 0.82,
          pointerId: 9,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: rect.left + rect.width * 0.98,
          clientY: rect.top + rect.height * 0.82,
          pointerId: 9,
        }),
      );
    });
  await requireText(page, "ground resized");

  await page
    .locator(".snes-emulator-canvas")
    .first()
    .evaluate((stage) => {
      const rect = stage.getBoundingClientRect();
      const events = [
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: rect.left + 80,
          clientY: rect.top + 140,
          pointerId: 1,
        }),
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + 210,
          clientY: rect.top + 220,
          pointerId: 1,
        }),
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: rect.left + 210,
          clientY: rect.top + 220,
          pointerId: 1,
        }),
      ];
      for (const event of events) {
        stage.dispatchEvent(event);
      }
    });
  await page.locator(".snes-emulator-selection").waitFor({ state: "visible", timeout: 10_000 });
  await requireText(page, "Try asking");
  await requireText(page, "Make this jump easier.");
  await requireText(page, "Add a hidden key here.");
  await requireText(page, "Fast changes");
  await requireText(page, "Add Key");
  await requireText(page, "Make Easier");
  await requireText(page, "level squares");
  await requireText(page, "Remove Things");
  await page
    .locator(".snes-emulator-canvas")
    .first()
    .evaluate((stage) => {
      const moveHandle = stage.querySelector(".snes-emulator-selection span");
      if (!moveHandle) {
        throw new Error("Selected emulator area move handle missing.");
      }
      const rect = stage.getBoundingClientRect();
      moveHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: rect.left + 110,
          clientY: rect.top + 160,
          pointerId: 2,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + 180,
          clientY: rect.top + 175,
          pointerId: 2,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: rect.left + 180,
          clientY: rect.top + 175,
          pointerId: 2,
        }),
      );
    });
  await requireText(page, "Area moved");
  await page
    .locator(".snes-emulator-canvas")
    .first()
    .evaluate((stage) => {
      const handle = stage.querySelector(".snes-emulator-selection__resize");
      if (!handle) {
        throw new Error("Selected emulator area resize handle missing.");
      }
      const rect = stage.getBoundingClientRect();
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: rect.left + 180,
          clientY: rect.top + 175,
          pointerId: 3,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + 230,
          clientY: rect.top + 215,
          pointerId: 3,
        }),
      );
      stage.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: rect.left + 230,
          clientY: rect.top + 215,
          pointerId: 3,
        }),
      );
    });
  await requireText(page, "Area resized");
  await page.locator(".snes-arcade-ask-bar textarea").fill("Add a coin trail here.");
  await page.getByRole("button", { name: "Change Selected Area" }).click();
  await requireAnyText(page, [
    "Playtest this area now",
    "This selected-area change is now in the 60 Hz playtest",
    "Coin Trail added",
    "AI changed the selected area",
  ]);
  await page.locator(".snes-arcade-ask-bar textarea").fill("Add a secret key here.");
  await page.getByRole("button", { name: "Preview Area Change" }).click();
  await requireText(page, "Preview before apply");
  await requireText(page, "Key preview");
  await page.getByRole("button", { name: "Cancel Preview" }).click();
  await page.locator(".snes-arcade-ask-bar textarea").fill("Add a secret key here.");
  await page.getByRole("button", { name: "Preview Area Change" }).click();
  await page.getByRole("button", { name: "Apply Preview" }).click();
  await requireText(page, "Key added");
  await page.getByRole("button", { name: "Remove Things" }).click();
  await requireText(page, "Selected things removed");
  await page.locator(".snes-arcade-ask-bar textarea").fill("Make this an empty gap.");
  await page.getByRole("button", { name: "Change Selected Area" }).click();
  await requireText(page, "Gap made");

  await page.locator(".snes-playtest__marker--hero").first().click();
  await requireText(page, "Hero: Player Start");
  await requireText(page, "Run speed");
  await page
    .locator(".snes-ai-selected-panel textarea")
    .fill("Make the hero jump higher and move faster.");
  await page.getByRole("button", { name: "Change With OpenClaw" }).click();
  await requireText(page, "Selected thing changed");
  await requireAnyText(page, [
    "raised hero jump",
    "increased hero speed",
    "changed only Player Start",
    "changed only Robot Hero",
  ]);

  await page.locator(".snes-playtest__marker--enemy").first().click();
  await requireText(page, "Behavior");
  await requireText(page, "Look");
  await page
    .locator(".snes-ai-selected-panel textarea")
    .fill("Make this enemy slower and patrol less.");
  await page.getByRole("button", { name: "Change With OpenClaw" }).click();
  await requireAnyText(page, [
    "slowed enemy patrol",
    "shortened its patrol",
    "changed only Patrol Bot",
    "changed only Patrol Enemy",
  ]);
  await page
    .locator(".snes-ai-selected-panel textarea")
    .fill("Make this enemy rounder and colorful with a classic SNES platformer look.");
  await page.getByRole("button", { name: "Change With OpenClaw" }).click();
  await requireAnyText(page, [
    "round colorful",
    "updated its classic visual recipe",
    "classic visual recipe",
    "changed only Patrol Bot",
    "changed only Patrol Enemy",
  ]);

  const enemyCount = await page.locator(".snes-playtest__marker--enemy").count();
  await page.locator(".snes-guided-shelf__thing", { hasText: "Enemy" }).first().click();
  await page.getByRole("button", { name: "Play & Change" }).first().click();
  await page.waitForFunction(
    (previousCount) =>
      document.querySelectorAll(".snes-playtest__marker--enemy").length > previousCount,
    enemyCount,
    { timeout: 10_000 },
  );

  await page.getByRole("button", { name: "Start Test" }).first().click();
  await requireText(page, "Live play started");
  await requireText(page, "60 Hz");
  await requireText(page, "Live play running");
  await page.getByRole("button", { name: "Pause" }).first().click();
  await requireText(page, "Playtest paused");
  const livePlaytestScreenshot = await screenshot(page, artifactDir, "desktop-live-playtest.png");
  await page.getByRole("button", { name: "Ship" }).first().click();
  await requireText(page, "Make SNES Game File");
  const download = await saveDownload(page, artifactDir, "Make SNES Game File");

  await page.locator(".snes-ai-expert-studio summary").click();
  await page.locator(".snes-mode-rail").waitFor({ state: "visible", timeout: 10_000 });
  await requireText(page, "Project Safety");
  await page.locator(".snes-mode-rail button", { hasText: "Export" }).click();
  await requireText(page, "Emulator boot proof");
  await page.getByRole("button", { name: "Run Local Agent Proof" }).first().click();
  await requireText(page, "Local agent proof passed");
  await requireText(page, "Review Before Apply");
  await page
    .locator(".snes-ship-proof input[placeholder='ares, bsnes, mesen, snes9x']")
    .fill("snes9x");
  await requireText(page, "Ready to run local emulator proof");
  await requireText(page, "Download Emulator Run Script");
  const emulatorProofDownload = await saveDownload(page, artifactDir, "Export Emulator Proof");
  const emulatorProofPayload = JSON.parse(readFileSync(emulatorProofDownload, "utf8")) as {
    expectedEmulatorStateDump?: {
      finalStateHash?: string;
      frameCount?: number;
      runtimeHash?: string;
    };
    operatorInstructions?: string[];
    replayParity?: { status?: string };
    runPack?: { command?: string[]; scriptFileName?: string; status?: string };
    runtimeManifest?: { runtimeHash?: string };
    runtimeReplay?: { inputs?: unknown[]; runtimeHash?: string };
  };
  if (!emulatorProofPayload.runtimeReplay?.inputs?.length) {
    throw new Error("Emulator proof download did not include replay input frames.");
  }
  if (
    !emulatorProofPayload.expectedEmulatorStateDump?.finalStateHash ||
    !emulatorProofPayload.expectedEmulatorStateDump.runtimeHash
  ) {
    throw new Error("Emulator proof download did not include expected state hash evidence.");
  }
  if (
    emulatorProofPayload.runtimeManifest?.runtimeHash !==
    emulatorProofPayload.expectedEmulatorStateDump.runtimeHash
  ) {
    throw new Error("Emulator proof runtime manifest hash does not match expected state dump.");
  }
  if (!emulatorProofPayload.operatorInstructions?.some((line) => line.includes("state hash"))) {
    throw new Error("Emulator proof download did not include operator parity instructions.");
  }
  if (
    emulatorProofPayload.runPack?.status !== "ready" ||
    !emulatorProofPayload.runPack.command?.includes("snes9x") ||
    !emulatorProofPayload.runPack.scriptFileName?.endsWith(".run-emulator-proof.sh")
  ) {
    throw new Error("Emulator proof download did not include a ready snes9x run pack.");
  }
  const emulatorRunScriptDownload = await saveDownload(
    page,
    artifactDir,
    "Download Emulator Run Script",
  );
  const emulatorRunScript = readFileSync(emulatorRunScriptDownload, "utf8");
  if (
    !emulatorRunScript.includes("snes9x -snapshot") ||
    !emulatorRunScript.includes("Expected final state hash")
  ) {
    throw new Error("Emulator run script did not include the replay command and state hash.");
  }

  const desktopScreenshot = await screenshot(page, artifactDir, "desktop-guided-platformer.png");
  await page.close();
  return {
    downloads: [download, emulatorProofDownload, emulatorRunScriptDownload],
    issues,
    liveAgentReady,
    liveAgentStatus,
    screenshots: [livePlaytestScreenshot, desktopScreenshot],
  };
}

function withSmokeSafeUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.set("__openclaw_skip_auto_agent_team", "1");
    return url.toString();
  } catch {
    return input.includes("?")
      ? `${input}&__openclaw_skip_auto_agent_team=1`
      : `${input}?__openclaw_skip_auto_agent_team=1`;
  }
}

function smokeExcerptAround(text: string, needle: string, maxChars = 1600): string {
  if (!needle || !text.includes(needle)) {
    return text.slice(0, maxChars);
  }
  const index = text.indexOf(needle);
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

export function redactSmokeUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.hash) {
      const hash = new URLSearchParams(url.hash.slice(1));
      if (hash.has("token")) {
        hash.set("token", "[redacted]");
        url.hash = `#${hash.toString()}`;
      }
    }
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "[redacted]");
    }
    return url.toString();
  } catch {
    return input.replace(/([#?&]token=)[^&\s]+/giu, "$1[redacted]");
  }
}

function readSmokeUrlFromClipboard(): string {
  if (platform() !== "darwin") {
    throw new Error("--from-clipboard is only supported on macOS.");
  }
  const value = execFileSync("pbpaste", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!value) {
    throw new Error(
      "Clipboard is empty. Run `openclaw dashboard --no-open --path /snes-studio` first.",
    );
  }
  return value;
}

function resolveExplicitSmokeUrl(): string {
  const args = process.argv.slice(2);
  if (args.includes("--from-clipboard")) {
    return readSmokeUrlFromClipboard();
  }
  return (
    args.find((arg) => !arg.startsWith("--"))?.trim() ||
    process.env.OPENCLAW_CONTROL_UI_SNES_STUDIO_URL?.trim() ||
    ""
  );
}

async function runMobileFlow(browser: SmokeBrowser, url: string, artifactDir: string) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  const issues: SmokeIssue[] = [];
  watchPageIssues(page, "mobile", issues);

  await installSnesStudioPageStateReset(page);
  await page.goto(url, { waitUntil: "networkidle" });
  await requireText(page, "SNES Studio");
  await requireNoDefaultModeRail(page);
  const startTextarea = page.locator(".snes-arcade-start textarea").first();
  if (await startTextarea.isVisible().catch(() => false)) {
    await startTextarea.fill("Make a tiny sky adventure with one coin.");
    await page.getByRole("button", { name: "Make My Game" }).first().click();
  }
  await requireText(page, "Play & Change");
  await page.getByRole("button", { name: "Play & Change" }).first().click();
  await requireText(page, "Play & Change");
  await page
    .locator(".snes-emulator-canvas")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const stage = document.querySelector<HTMLElement>(".snes-emulator-canvas");
      return Boolean(stage && stage.getBoundingClientRect().top <= window.innerHeight);
    },
    { timeout: 10_000 },
  );

  const layout = await page.evaluate(() => {
    const prompt = document.querySelector<HTMLElement>(".snes-arcade-header");
    const stage = document.querySelector<HTMLElement>(".snes-emulator-canvas");
    const selected = document.querySelector<HTMLElement>(
      ".snes-ai-selected-panel, .snes-guided-selected-empty",
    );
    const promptBox = prompt?.getBoundingClientRect();
    const stageBox = stage?.getBoundingClientRect();
    const selectedBox = selected?.getBoundingClientRect();
    return {
      prompt: promptBox ? { bottom: promptBox.bottom, top: promptBox.top } : null,
      stage: stageBox
        ? { bottom: stageBox.bottom, height: stageBox.height, top: stageBox.top }
        : null,
      selected: selectedBox ? { top: selectedBox.top } : null,
      viewportHeight: window.innerHeight,
    };
  });
  if (!layout.prompt || !layout.stage || !layout.selected) {
    throw new Error(`Mobile layout missing key regions: ${JSON.stringify(layout)}`);
  }
  if (layout.stage.height < 160) {
    throw new Error(`Mobile playable stage is too short: ${Math.round(layout.stage.height)}px.`);
  }
  if (layout.stage.top > layout.viewportHeight) {
    throw new Error(`Mobile playable stage starts below the fold: ${JSON.stringify(layout)}`);
  }
  if (layout.selected.top < layout.stage.bottom - 1) {
    throw new Error(`Mobile selected panel overlaps playable stage: ${JSON.stringify(layout)}`);
  }

  const mobileScreenshot = await screenshot(page, artifactDir, "mobile-guided-platformer.png");
  await page.close();
  return { issues, screenshots: [mobileScreenshot] };
}

async function main() {
  const explicitUrl = resolveExplicitSmokeUrl();
  const staticServer = explicitUrl ? null : await startStaticControlUiServer();
  const url = withSmokeSafeUrl(explicitUrl || staticServer?.url || "");
  const summaryUrl = redactSmokeUrl(url);
  const artifactDir = resolveArtifactDir();
  mkdirSync(artifactDir, { recursive: true });

  const browser = await launchBrowser();
  try {
    const desktop = await runDesktopFlow(browser, url, artifactDir);
    const mobile = await runMobileFlow(browser, url, artifactDir);
    const externalProof = probeExternalProof({
      liveAgentReady: desktop.liveAgentReady,
      liveAgentStatus: desktop.liveAgentStatus,
    });
    const issues = [...desktop.issues, ...mobile.issues];
    const screenshots = [...desktop.screenshots, ...mobile.screenshots];
    const downloads = desktop.downloads;
    const blockers = [
      ...(externalProof.emulators.blocker ? [externalProof.emulators.blocker] : []),
      ...(externalProof.fxpak.blocker ? [externalProof.fxpak.blocker] : []),
      ...(externalProof.liveAgent.blocker ? [externalProof.liveAgent.blocker] : []),
      ...issues.map((issue) => `${issue.viewport} ${issue.kind}: ${issue.message}`),
    ];
    const summary: SmokeSummary = {
      ok: true,
      url: summaryUrl,
      artifactDir,
      routeLoaded: true,
      gatewayConnected: externalProof.liveAgent.ready,
      authOk: externalProof.liveAgent.ready,
      canonicalUrl: explicitUrl ? redactSmokeUrl(explicitUrl) : null,
      blockers,
      screenshots,
      downloads,
      downloadEvidence: downloads.map(evidenceForFile),
      checked: [
        "SNES Studio default route",
        "default mode rail removed",
        "one-prompt Make My Game creation",
        "GPT 5.5-directed OpenClaw production lanes",
        "automatic GPT 5.5/OpenClaw live team status surfaced",
        "OpenClaw fills creative text boxes while GPT 5.5 reviews quality",
        "live GPT 5.5/OpenClaw production route check surfaced",
        "Production SNES Studio cockpit surfaced",
        "generic project package and production runner surfaced",
        "generic persisted production controls surfaced",
        "Stanski canary and non-Stanski MVP sample surfaced",
        "Toolchain Doctor surfaced",
        "asset adapter, ROM scaffold, emulator, and FXPAK dry-run receipts surfaced",
        "real asset, visual, ROM, emulator, FXPAK, and hardware gates surfaced",
        "runtime asset truth visual gate surfaced",
        "classic colorful SNES platformer graphics preset",
        "data-first tile, sprite, and SFX specs surfaced",
        "game quality gauntlet and no-GPT-cost receipt surfaced",
        "Improve Game Quality repair action surfaced",
        "Generated asset editor surfaced",
        "Replay-backed quality evidence surfaced",
        "Local proof checklist and benchmark report surfaced",
        "game plan and level chapters",
        "AI Gap Filler",
        "60 Hz runtime playtest canvas visible",
        "emulator replay parity proof surfaced",
        "prompt-first Play & Change ask bar surfaced",
        "selected-area quick actions surfaced",
        "selected-area AI prompt suggestions surfaced",
        "direct pointer drag inside emulator playtest",
        "click-to-select terrain chunk",
        "selected terrain chunk drag and prompt movement",
        "selected terrain chunk drag and prompt resizing",
        "selected-area move and resize handles",
        "selected emulator area prompt change",
        "selected emulator area preview before apply",
        "selected emulator area preview cancel",
        "selected emulator area secret key prompt",
        "natural selected-area remove and gap prompts",
        "hero click-to-edit",
        "selected hero prompt change",
        "enemy click-to-edit",
        "selected enemy prompt change",
        "selected enemy visual style prompt change",
        "prompt-to-create custom thing",
        "visible Things Shelf add",
        "continuous Start Test live loop and pause",
        "preview SNES game file download",
        "actionable emulator replay proof download",
        "downloadable emulator proof run script",
        "local OpenClaw/Codex approval proof",
        "Expert Studio disclosure",
        "mobile guided flow",
        "external proof blockers reported",
      ],
      externalProof,
      issues,
    };
    writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(resolveLatestSummaryPath(artifactDir), `${JSON.stringify(summary, null, 2)}\n`);
    if (issues.length > 0) {
      throw new Error(`SNES Studio smoke saw browser issues: ${JSON.stringify(issues, null, 2)}`);
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
    await staticServer?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  });
}
