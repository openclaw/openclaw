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
    <title>OpenClaw Chat Multi-agent Work Tree Smoke</title>
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
    runOpenClawChatMultiAgentWorkTreeSmoke: (mode: Mode) => Promise<Result>;
  }
}

const root = document.getElementById("root")!;

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "agent:main:main",
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

const sessions = {
  count: 4,
  defaults: { contextTokens: null, model: null, modelProvider: null },
  path: "",
  sessions: [
    {
      childSessions: ["agent:main:subagent:research"],
      displayName: "Main chat",
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 100,
    },
    {
      displayName: "Research agent",
      hasActiveRun: true,
      key: "agent:main:subagent:research",
      kind: "direct",
      lastMessagePreview: "Reading source evidence",
      parentSessionKey: "agent:main:main",
      spawnedBy: "agent:main:main",
      updatedAt: 90,
    },
    {
      displayName: "Judge agent",
      hasActiveSubagentRun: true,
      key: "agent:main:subagent:research:subagent:judge",
      kind: "direct",
      lastMessagePreview: "Checking acceptance criteria",
      parentSessionKey: "agent:main:subagent:research",
      updatedAt: 80,
    },
    {
      displayName: "Other agent",
      hasActiveRun: true,
      key: "agent:other:subagent:worker",
      kind: "direct",
      spawnedBy: "agent:other:main",
      updatedAt: 120,
    },
  ],
  ts: 0,
};

window.runOpenClawChatMultiAgentWorkTreeSmoke = async (mode: Mode): Promise<Result> => {
  const checks: Record<string, boolean> = {};
  const calls = { canceled: [] as string[], opened: [] as string[], sent: 0 };

  await renderState();
  let surface = root.querySelector("[data-chat-work-surface]");
  checks.emptyState = includes(surface, "No child agents running");

  await renderState({
    sessions,
    workTasks: [
      {
        id: "task-research",
        taskId: "task-research",
        sessionKey: "agent:main:subagent:research",
        status: "running",
        progressSummary: "Watching child proof",
      },
    ],
    onSessionSelect: (sessionKey: string) => calls.opened.push(sessionKey),
    onWorkTaskCancel: (taskId: string) => calls.canceled.push(taskId),
  });
  surface = root.querySelector("[data-chat-work-surface]");
  root.querySelector<HTMLDetailsElement>("[data-chat-work-surface]")!.open = true;
  checks.summaryWorking = includes(surface, "Working");
  const tree = root.querySelector(".chat-agent-work-tree");
  checks.treeHeader = includes(tree, "Agent Work Tree");
  checks.rootRow = includes(tree, "Current chat");
  checks.childRow = includes(tree, "Research agent") && includes(tree, "Watching child proof");
  checks.nestedChildRow = includes(tree, "Judge agent") && includes(tree, "Checking acceptance criteria");
  checks.unrelatedHidden = !includes(tree, "Other agent");
  checks.cancelAction = clickButtonByText(tree!, "Cancel") && calls.canceled[0] === "task-research";
  checks.openAction = clickButtonByText(tree!, "Open") && calls.opened[0] === "agent:main:main";

  await renderState({
    draft: "hello",
    getDraft: () => "hello",
    onSend: () => calls.sent++,
  });
  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
  checks.composerStillSends = calls.sent === 1;

  if (mode === "mobile") {
    await renderState({ sessions });
    root.querySelector<HTMLDetailsElement>("[data-chat-work-surface]")!.open = true;
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
    return await window.runOpenClawChatMultiAgentWorkTreeSmoke(nextMode);
  }, mode);
  if (!result.ok) {
    throw new Error(
      `Chat multi-agent work tree ${mode} smoke failed: ${JSON.stringify(result.checks, null, 2)}`,
    );
  }
  return result;
}

async function main() {
  const artifactDir = join(".artifacts", "control-ui-chat-multi-agent-work-tree", timestampSlug());
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
    const appPath = `${appDir.split(/[\\/]/).join("/")}/index.html`;
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
