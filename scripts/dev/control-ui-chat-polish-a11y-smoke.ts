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
    <title>OpenClaw Chat Polish Accessibility Smoke</title>
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
    runOpenClawChatPolishA11ySmoke: (mode: Mode) => Promise<Result>;
  }
}

const root = document.getElementById("root")!;
let projectPickerOpen = false;
let goalPanelOpen = false;
let sentCount = 0;

const baseTime = Date.now();
const approval = {
  id: "approval-exec-polish",
  kind: "exec",
  request: {
    command: "pnpm test ui/src/ui/views/chat.test.ts",
    cwd: "/Users/openclaw/OpenClaw",
    host: "gateway",
    security: "allowlist",
    ask: "on-miss",
    agentId: "main",
    sessionKey: "agent:main:chat",
    commandSpans: [{ startIndex: 0, endIndex: 9 }],
  },
  createdAtMs: baseTime,
  expiresAtMs: baseTime + 120_000,
};

const projectsList = {
  ok: true,
  ts: 1,
  count: 1,
  projects: [
    {
      id: "project-polish",
      name: "Polish Project",
      description: "Calm design proof",
      memoryMode: "project_only",
      createdAt: 1,
      updatedAt: 2,
      resources: [],
    },
  ],
};

const sessions = {
  count: 2,
  defaults: { contextTokens: null, model: null, modelProvider: null },
  path: "",
  sessions: [
    {
      childSessions: ["agent:main:subagent:design"],
      controlDirectorTruthAudit: [
        {
          ts: 10,
          runId: "run-1",
          status: "blocked",
          missing: ["command exit code 0"],
          payloadsChecked: 1,
          payloadsRewritten: 1,
          claims: [
            {
              claim: "tests passed",
              claimHash: "hash-1",
              claimType: "verification",
              requiredEvidenceType: "command",
              matchStatus: "missing",
              missingCondition: "missing command evidence with exit code 0",
              rewriteAction: "blocked_unsupported_truth_claim",
            },
          ],
        },
      ],
      key: "agent:main:main",
      kind: "direct",
      projectId: "project-polish",
      updatedAt: 100,
    },
    {
      displayName: "Design reviewer",
      hasActiveRun: true,
      key: "agent:main:subagent:design",
      kind: "direct",
      lastMessagePreview: "Checking keyboard focus",
      spawnedBy: "agent:main:main",
      updatedAt: 90,
    },
  ],
  ts: 0,
};

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
    messages: [
      {
        role: "assistant",
        content: "<proposed_plan>\\n# Ship polished chat\\n- Verify keyboard access.\\n</proposed_plan>",
      },
    ],
    sideResult: null,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "hello",
    queue: [{ id: "queue-1", text: "follow-up polish", createdAt: 90 }],
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    realtimeTalkTranscript: null,
    connected: true,
    canSend: true,
    currentRunId: "run-1",
    disabledReason: null,
    error: null,
    sessions,
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
    getDraft: () => "hello",
    onDraftChange: () => undefined,
    onRequestUpdate: () => undefined,
    onSend: () => {
      sentCount += 1;
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
    basePath: "",
    execApprovalQueue: [approval],
    goalDraft: "Polish the chat",
    goalFlows: [
      {
        id: "flow-polish",
        flowId: "flow-polish",
        status: "running",
        goal: "Polish the Chat experience",
        currentStep: "Checking accessibility",
        tasks: [{ taskId: "task-goal", status: "running", progressSummary: "Reviewing focus" }],
      },
    ],
    goalPanelOpen,
    onGoalPanelToggle: (open: boolean) => {
      goalPanelOpen = open;
    },
    projectsList,
    projectPickerOpen,
    onProjectPickerToggle: (open: boolean) => {
      projectPickerOpen = open;
    },
    projectCreateName: "Polish Project",
    workTasks: [
      { id: "task-remote", taskId: "task-remote", title: "Remote proof", status: "running", progressSummary: "Watching workflow" },
    ],
    ...overrides,
  };
}

async function renderState(overrides: Record<string, unknown> = {}) {
  render(renderChat(baseProps(overrides) as Parameters<typeof renderChat>[0]), root);
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  return root;
}

function hasSelector(selector: string): boolean {
  return root.querySelector(selector) !== null;
}

function text(node: Element | null): string {
  return node?.textContent ?? "";
}

function focusVisibleWorks(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }
  element.focus();
  const style = getComputedStyle(element);
  return style.outlineStyle !== "none" && style.outlineWidth !== "0px";
}

async function closeWithEscape(selector: string): Promise<boolean> {
  const details = root.querySelector<HTMLDetailsElement>(selector);
  if (!details) {
    return false;
  }
  details.open = true;
  details.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  return !details.open;
}

window.runOpenClawChatPolishA11ySmoke = async (mode: Mode): Promise<Result> => {
  const checks: Record<string, boolean> = {};
  projectPickerOpen = true;
  goalPanelOpen = true;
  sentCount = 0;
  await renderState();

  checks.coreSurfaces =
    hasSelector("[data-chat-work-surface]") &&
    hasSelector("[data-chat-project-picker]") &&
    hasSelector("[data-chat-approval-card]") &&
    hasSelector("[data-chat-goal]") &&
    hasSelector("[data-control-director-diagnostics]") &&
    text(root).includes("Agent Work Tree");
  checks.accessibleLabels =
    hasSelector('.chat-work-surface__summary[aria-label^="Working Now"]') &&
    hasSelector('.chat-project-picker__summary[aria-label^="Project:"]') &&
    hasSelector('.chat-approval-card__summary[aria-label*="approval needed"]') &&
    hasSelector('.chat-goal__summary[aria-label^="Pursue Goal"]') &&
    hasSelector('[aria-label="Allow approval once"]') &&
    hasSelector('[aria-label="Refresh projects"]') &&
    hasSelector('[aria-label="Start pursue goal"]');
  checks.keyboardEscape =
    (await closeWithEscape("[data-chat-work-surface]")) &&
    (await closeWithEscape("[data-chat-project-picker]")) &&
    (await closeWithEscape("[data-chat-approval-card]")) &&
    (await closeWithEscape("[data-chat-goal]"));
  checks.visibleFocus = focusVisibleWorks(root.querySelector<HTMLElement>(".chat-work-surface__summary"));
  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
  checks.composerStillSends = sentCount === 1;
  checks.planCardStillVisible = text(root).includes("Proposed Plan") || text(root).includes("Ship polished chat");

  if (mode === "mobile") {
    projectPickerOpen = true;
    goalPanelOpen = true;
    await renderState();
    const details = root.querySelector<HTMLDetailsElement>("[data-chat-project-picker]");
    if (details) {
      details.open = true;
    }
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const panel = root.querySelector<HTMLElement>(".chat-project-picker__panel");
    const panelRect = panel?.getBoundingClientRect();
    checks.mobileViewport = window.matchMedia("(max-width: 720px)").matches;
    checks.mobileSheetAboveComposer = panel && panelRect
      ? getComputedStyle(panel).position === "fixed" && panelRect.bottom < window.innerHeight
      : false;
    checks.mobileComposerUsable =
      Boolean(root.querySelector("textarea")) && Boolean(root.querySelector('[aria-label="Send message"]'));
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
  if (mode === "mobile") {
    await page.emulateMedia({ reducedMotion: "reduce" });
  } else {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  const result = await page.evaluate(async (nextMode) => {
    return await window.runOpenClawChatPolishA11ySmoke(nextMode);
  }, mode);
  if (!result.ok) {
    throw new Error(
      `Chat polish accessibility ${mode} smoke failed: ${JSON.stringify(result.checks, null, 2)}`,
    );
  }
  return result;
}

async function main() {
  const artifactDir = join(".artifacts", "control-ui-chat-polish-a11y", timestampSlug());
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
