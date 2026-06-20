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
    <title>OpenClaw Chat Pursue Goal Smoke</title>
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
    runOpenClawChatPursueGoalSmoke: (mode: Mode) => Promise<Result>;
  }
}

const root = document.getElementById("root")!;
let draft = "";
let goalDraft = "";
let startCalls = 0;
let continueCalls: string[] = [];
let cancelCalls: string[] = [];
let sendCalls = 0;

const runningGoal = {
  id: "flow-1",
  flowId: "flow-1",
  status: "running",
  goal: "Finish Pursue Goal V1",
  currentStep: "Running local proof.",
  tasks: [
    {
      taskId: "task-1",
      status: "running",
      progressSummary: "Testing gateway linkage",
      judgeStatus: "pending",
    },
  ],
};

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
    draft,
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
    assistantName: "OpenClaw",
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
    getDraft: () => draft,
    onDraftChange: (next: string) => {
      draft = next;
      renderState(overrides);
    },
    onRequestUpdate: () => renderState(overrides),
    onSend: () => {
      sendCalls += 1;
    },
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
    goalDraft,
    goalPanelOpen: false,
    goalFlows: [],
    onGoalDraftChange: (next: string) => {
      goalDraft = next;
      renderState(overrides);
    },
    onGoalStart: () => {
      startCalls += 1;
    },
    onGoalContinue: (flowId: string) => {
      continueCalls.push(flowId);
    },
    onGoalCancel: (flowId: string) => {
      cancelCalls.push(flowId);
    },
    onGoalRefresh: () => undefined,
    onGoalPanelToggle: () => undefined,
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

window.runOpenClawChatPursueGoalSmoke = async (mode: Mode): Promise<Result> => {
  const checks: Record<string, boolean> = {};
  draft = "Write a verified release note";
  goalDraft = "";
  startCalls = 0;
  continueCalls = [];
  cancelCalls = [];
  sendCalls = 0;

  await renderState({ goalPanelOpen: true });
  let surface = root.querySelector("[data-chat-goal]");
  checks.noGoal = includes(surface, "No goal") && includes(surface, "Create durable work from the current request");
  root.querySelector<HTMLButtonElement>('[data-chat-goal-action="start"]')?.click();
  checks.startGoal = startCalls === 1;

  const goalInput = root.querySelector<HTMLTextAreaElement>("[data-chat-goal] textarea");
  if (goalInput) {
    goalInput.value = "Run proof to 100%";
    goalInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  checks.goalDraftEditable = goalDraft === "Run proof to 100%";

  await renderState({ goalPanelOpen: true, goalFlows: [runningGoal] });
  surface = root.querySelector("[data-chat-goal]");
  checks.runningGoal =
    includes(surface, "Finish Pursue Goal V1") &&
    includes(surface, "Pursuing") &&
    includes(surface, "Testing gateway linkage") &&
    includes(surface, "Judge pending");
  root.querySelector<HTMLButtonElement>('[data-chat-goal-action="continue"]')?.click();
  root.querySelector<HTMLButtonElement>('[data-chat-goal-action="cancel"]')?.click();
  checks.continueGoal = continueCalls[0] === "flow-1";
  checks.cancelGoal = cancelCalls[0] === "flow-1";

  await renderState({
    goalPanelOpen: true,
    goalError: "offline",
    draft: "hello",
    getDraft: () => "hello",
  });
  surface = root.querySelector("[data-chat-goal]");
  checks.failureState = includes(surface, "Goal status unavailable");
  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
  checks.composerStillSends = sendCalls === 1;

  if (mode === "mobile") {
    await renderState({ goalPanelOpen: true, goalFlows: [runningGoal] });
    const panel = root.querySelector<HTMLElement>(".chat-goal__panel");
    const textarea = root.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox textarea");
    checks.mobileViewport = window.matchMedia("(max-width: 720px)").matches;
    checks.mobileBottomSheet = panel ? getComputedStyle(panel).position === "fixed" : false;
    checks.mobileComposerUsable = Boolean(textarea && !textarea.disabled);
  }

  return {
    mode,
    ok: Object.values(checks).every(Boolean),
    checks,
    bodyText: document.body.textContent ?? "",
  };
};

void renderState();
`,
  );
}

async function runMode(page: Page, mode: "desktop" | "mobile"): Promise<SmokeModeResult> {
  await page.setViewportSize(
    mode === "mobile" ? { height: 844, width: 390 } : { height: 900, width: 1280 },
  );
  const result = await page.evaluate(async (nextMode) => {
    return await window.runOpenClawChatPursueGoalSmoke(nextMode);
  }, mode);
  if (!result.ok) {
    throw new Error(
      `Chat Pursue Goal ${mode} smoke failed: ${JSON.stringify(result.checks, null, 2)}`,
    );
  }
  return result;
}

async function main() {
  const artifactDir = join(".artifacts", "control-ui-chat-pursue-goal", timestampSlug());
  const appDir = join(artifactDir, "app");
  mkdirSync(artifactDir, { recursive: true });
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
    const executablePath = resolveBrowserExecutable();
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
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
    const modeResults: SmokeModeResult[] = [];
    for (const mode of ["desktop", "mobile"] as const) {
      const result = await runMode(page, mode);
      modeResults.push(result);
      const screenshot = join(artifactDir, `${mode}.png`);
      await page.screenshot({ fullPage: true, path: screenshot });
      screenshots.push(screenshot);
    }
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
      modeResults,
      ok: true,
      pageErrors,
      responseErrors,
      screenshots,
      url,
    };
    writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser?.close();
    await server?.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
