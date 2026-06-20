import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { controlUiSmokeViteResolve } from "./control-ui-smoke-vite.ts";

type SmokeModeResult = {
  bodyText: string;
  checks: Record<string, boolean>;
  mode: "desktop" | "mobile";
  ok: boolean;
};

type SmokeSummary = {
  artifactDir: string;
  consoleErrors: string[];
  modeResults: SmokeModeResult[];
  ok: true;
  pageErrors: string[];
  responseErrors: string[];
  screenshots: string[];
  url: string;
};

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
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

function writeSmokeApp(appDir: string) {
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw Chat Work Surface Smoke</title>
  </head>
  <body>
    <main id="root"></main>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`,
  );
  writeFileSync(
    join(appDir, "main.ts"),
    `import "/ui/src/styles/chat.css";
import { render } from "lit";
import { renderChat } from "/ui/src/ui/views/chat.ts";

type Mode = "desktop" | "mobile";
type Result = { mode: Mode; ok: boolean; checks: Record<string, boolean>; bodyText: string };

declare global {
  interface Window {
    runOpenClawChatWorkSurfaceSmoke: (mode: Mode) => Promise<Result>;
  }
}

const root = document.getElementById("root")!;

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    sideResult: null,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    realtimeTalkTranscript: null,
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: null,
    focusMode: false,
    sidebarOpen: false,
    sidebarContent: null,
    sidebarError: null,
    splitRatio: 0.6,
    canvasPluginSurfaceUrl: null,
    embedSandboxMode: "scripts",
    allowExternalEmbedUrls: false,
    assistantName: "Val",
    assistantAvatar: null,
    userName: null,
    userAvatar: null,
    localMediaPreviewRoots: [],
    assistantAttachmentAuthToken: null,
    autoExpandToolCalls: false,
    attachments: [],
    onAttachmentsChange: () => undefined,
    showNewMessages: false,
    onScrollToBottom: () => undefined,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    getDraft: () => "",
    onDraftChange: () => undefined,
    onRequestUpdate: () => undefined,
    onSend: () => undefined,
    onCompact: () => undefined,
    onToggleRealtimeTalk: () => undefined,
    onDismissError: () => undefined,
    onAbort: () => undefined,
    onQueueRemove: () => undefined,
    onQueueSteer: () => undefined,
    onDismissSideResult: () => undefined,
    onNewSession: () => undefined,
    onClearHistory: () => undefined,
    onOpenSessionCheckpoints: () => undefined,
    agentsList: null,
    currentAgentId: "main",
    onAgentChange: () => undefined,
    onNavigateToAgent: () => undefined,
    onSessionSelect: () => undefined,
    onOpenSidebar: () => undefined,
    onCloseSidebar: () => undefined,
    onSplitRatioChange: () => undefined,
    onChatScroll: () => undefined,
    basePath: "",
    ...overrides,
  };
}

async function renderState(overrides: Record<string, unknown> = {}) {
  render(renderChat(baseProps(overrides) as Parameters<typeof renderChat>[0]), root);
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  return root;
}

function text(node: Element | null): string {
  return node?.textContent ?? "";
}

function includes(node: Element | null, expected: string): boolean {
  return text(node).includes(expected);
}

function clickButtonByText(container: Element, label: string): boolean {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    (candidate.textContent ?? "").includes(label),
  );
  button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return Boolean(button);
}

window.runOpenClawChatWorkSurfaceSmoke = async (mode: Mode): Promise<Result> => {
  const checks: Record<string, boolean> = {};

  await renderState();
  let surface = root.querySelector("[data-chat-work-surface]");
  checks.idleSummary = includes(surface, "Nothing running");
  checks.idleExpandedState = includes(surface, "Nothing is running.");

  const calls = {
    canceled: [] as string[],
    opened: [] as string[],
    removed: [] as string[],
    sent: 0,
    stopped: 0,
  };
  await renderState({
    canAbort: true,
    currentRunId: "run-1",
    queue: [{ id: "queue-1", text: "follow up", createdAt: 90 }],
    workTasks: [
      {
        id: "task-1",
        taskId: "task-1",
        title: "Remote proof",
        status: "running",
        progressSummary: "Watching CI",
        updatedAt: 80,
      },
    ],
    sessions: {
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [
        {
          displayName: "Research lane",
          hasActiveRun: true,
          key: "agent:main:research",
          kind: "direct",
          updatedAt: 70,
        },
      ],
      ts: 0,
    },
    onAbort: () => calls.stopped++,
    onQueueRemove: (id: string) => calls.removed.push(id),
    onSessionSelect: (sessionKey: string) => calls.opened.push(sessionKey),
    onWorkTaskCancel: (taskId: string) => calls.canceled.push(taskId),
  });
  surface = root.querySelector("[data-chat-work-surface]");
  root.querySelector<HTMLDetailsElement>("[data-chat-work-surface]")!.open = true;
  checks.activeSummary = includes(surface, "Working");
  checks.activeRun = includes(surface, "Val is working…");
  checks.queuedMessage = includes(surface, "follow up");
  checks.runningTask = includes(surface, "Remote proof") && includes(surface, "Watching CI");
  checks.activeSession = includes(surface, "Research lane");
  checks.stopAction = clickButtonByText(surface!, "Stop") && calls.stopped === 1;
  checks.removeAction = clickButtonByText(surface!, "Remove") && calls.removed[0] === "queue-1";
  checks.cancelAction = clickButtonByText(surface!, "Cancel") && calls.canceled[0] === "task-1";
  checks.openAction =
    clickButtonByText(surface!, "Open") && calls.opened[0] === "agent:main:research";

  await renderState({
    workTasks: [{ id: "task-2", title: "Still visible", status: "running" }],
    workTasksError: "offline",
  });
  surface = root.querySelector("[data-chat-work-surface]");
  checks.failureState = includes(surface, "Work status unavailable") && includes(surface, "Still visible");

  await renderState({
    workTasks: [{ title: "No id task", status: "running" }],
    onWorkTaskCancel: (taskId: string) => calls.canceled.push(taskId),
  });
  surface = root.querySelector("[data-chat-work-surface]");
  checks.noCancelWithoutTaskId =
    includes(surface, "No id task") &&
    ![...surface!.querySelectorAll("button")].some((button) =>
      (button.textContent ?? "").includes("Cancel"),
    );

  await renderState({
    draft: "hello",
    getDraft: () => "hello",
    onSend: () => calls.sent++,
  });
  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
  checks.composerStillSends = calls.sent === 1;

  if (mode === "mobile") {
    await renderState({
      workTasks: [{ id: "mobile-task", taskId: "mobile-task", title: "Mobile work", status: "running" }],
    });
    const details = root.querySelector<HTMLDetailsElement>("[data-chat-work-surface]")!;
    details.open = true;
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const panel = root.querySelector<HTMLElement>(".chat-work-surface__panel");
    checks.mobileViewport = window.matchMedia("(max-width: 720px)").matches;
    checks.mobileBottomSheet = panel ? getComputedStyle(panel).position === "fixed" : false;
    checks.mobileComposerUsable =
      Boolean(root.querySelector("textarea")) &&
      Boolean(root.querySelector('[aria-label="Send message"]'));
  }

  const ok = Object.values(checks).every(Boolean);
  return { mode, ok, checks, bodyText: document.body.textContent ?? "" };
};
`,
  );
}

async function runMode(page: Page, mode: "desktop" | "mobile"): Promise<SmokeModeResult> {
  await page.setViewportSize(
    mode === "mobile" ? { height: 844, width: 390 } : { height: 900, width: 1280 },
  );
  const result = await page.evaluate(async (nextMode) => {
    return await window.runOpenClawChatWorkSurfaceSmoke(nextMode);
  }, mode);
  if (!result.ok) {
    throw new Error(
      `Chat work surface ${mode} smoke failed: ${JSON.stringify(result.checks, null, 2)}`,
    );
  }
  return result;
}

async function main() {
  const artifactDir = join(".artifacts", "control-ui-chat-work-surface", timestampSlug());
  const appDir = join(artifactDir, "app");
  writeSmokeApp(appDir);

  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const responseErrors: string[] = [];
  const screenshots: string[] = [];
  try {
    server = await createServer({
      appType: "spa",
      define: { "process.env": "{}" },
      logLevel: "error",
      root: process.cwd(),
      resolve: controlUiSmokeViteResolve(),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0];
    if (!baseUrl) {
      throw new Error("Vite server did not report a local URL");
    }
    const appPath = `${appDir.split(/[\\\\/]/).join("/")}/index.html`;
    const url = new URL(appPath, baseUrl).toString();

    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
    });
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (
        response.status() >= 400 &&
        !/\/(apple-touch-icon|favicon(?:-32)?|openclaw-logo)\./.test(response.url())
      ) {
        responseErrors.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto(url, { waitUntil: "networkidle" });
    const desktop = await runMode(page, "desktop");
    const desktopScreenshot = join(artifactDir, "desktop.png");
    await page.screenshot({ fullPage: true, path: desktopScreenshot });
    screenshots.push(desktopScreenshot);

    const mobile = await runMode(page, "mobile");
    const mobileScreenshot = join(artifactDir, "mobile.png");
    await page.screenshot({ fullPage: true, path: mobileScreenshot });
    screenshots.push(mobileScreenshot);

    if (consoleErrors.length > 0 || pageErrors.length > 0 || responseErrors.length > 0) {
      throw new Error(
        `Browser reported errors: ${JSON.stringify(
          { consoleErrors, pageErrors, responseErrors },
          null,
          2,
        )}`,
      );
    }

    const summary: SmokeSummary = {
      artifactDir,
      consoleErrors,
      modeResults: [desktop, mobile],
      ok: true,
      pageErrors,
      responseErrors,
      screenshots,
      url,
    };
    writeFileSync(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser?.close();
    await server?.close();
  }
}

await main();
