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
    <title>OpenClaw Chat Plan Mode Smoke</title>
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
    `import { render } from "lit";
import "/ui/src/styles/chat.css";
import "/ui/src/styles/chat/grouped.css";
import { renderChat } from "/ui/src/ui/views/chat.ts";

type Mode = "desktop" | "mobile";
type Result = { mode: Mode; ok: boolean; checks: Record<string, boolean>; bodyText: string };

declare global {
  interface Window {
    runOpenClawChatPlanModeSmoke: (mode: Mode) => Promise<Result>;
  }
}

const root = document.getElementById("root")!;
let draft = "";
let sendCount = 0;

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
    messages: [
      {
        role: "assistant",
        content:
          "Here is the safe implementation path.\\n<proposed_plan>\\n# Plan Mode UI V1\\n\\n1. Render the plan card.\\n2. Let the user load the implementation prompt.\\n3. Do not send automatically.\\n</proposed_plan>\\nReview it first.",
        timestamp: 1,
      },
    ],
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
      renderState();
    },
    onRequestUpdate: () => renderState(),
    onSend: () => {
      sendCount += 1;
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

window.runOpenClawChatPlanModeSmoke = async (mode: Mode): Promise<Result> => {
  draft = "";
  sendCount = 0;
  await renderState();
  const checks: Record<string, boolean> = {};
  const card = root.querySelector<HTMLElement>("[data-proposed-plan-card]");
  checks.cardVisible = Boolean(card);
  checks.titleVisible = text(card).includes("Proposed Plan");
  checks.awaitingApproval = text(card).includes("Awaiting approval");
  checks.planBodyVisible = text(card).includes("Plan Mode UI V1") && text(card).includes("Do not send automatically");
  checks.rawTagsHidden = !root.textContent?.includes("<proposed_plan>") && !root.textContent?.includes("</proposed_plan>");

  const useButton = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.includes("Use plan"),
  );
  useButton?.click();
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  const textarea = root.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox textarea");
  checks.usePlanLoadedComposer = Boolean(
    textarea?.value.startsWith("PLEASE IMPLEMENT THIS PLAN:\\n# Plan Mode UI V1"),
  );
  checks.usePlanDidNotSend = sendCount === 0;
  checks.readyStateVisible = Boolean(root.textContent?.includes("Ready to send"));
  checks.composerUsable = Boolean(textarea && !textarea.disabled && textarea.offsetParent !== null);

  const sendButton = root.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
  sendButton?.click();
  checks.composerStillSends = sendCount === 1;

  if (mode === "mobile") {
    const box = card?.getBoundingClientRect();
    const composer = textarea?.getBoundingClientRect();
    checks.mobileCardFits = Boolean(box && box.width <= window.innerWidth && box.left >= 0);
    checks.mobileComposerVisible = Boolean(composer && composer.bottom <= window.innerHeight + 1);
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
  if (mode === "desktop") {
    await page.setViewportSize({ width: 1280, height: 900 });
  } else {
    await page.setViewportSize({ width: 390, height: 844 });
  }
  return await page.evaluate(
    (selectedMode) => window.runOpenClawChatPlanModeSmoke(selectedMode),
    mode,
  );
}

async function main() {
  const artifactDir = join(".artifacts", "control-ui-chat-plan-mode", timestampSlug());
  const appDir = join(artifactDir, "app");
  mkdirSync(artifactDir, { recursive: true });
  writeSmokeApp(appDir);

  const server: ViteDevServer = await createServer({
    appType: "spa",
    define: { "process.env": "{}" },
    logLevel: "error",
    resolve: controlUiSmokeViteResolve(),
    root: process.cwd(),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const responseErrors: string[] = [];
  const screenshots: string[] = [];
  let browser: Browser | null = null;

  try {
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
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error" && !msg.text().includes("Failed to load resource")) {
        consoleErrors.push(msg.text());
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
      await page.screenshot({ path: screenshot, fullPage: true });
      screenshots.push(screenshot);
    }
    const failures = modeResults.flatMap((result) =>
      Object.entries(result.checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => `${result.mode}:${name}`),
    );
    if (consoleErrors.length || pageErrors.length || responseErrors.length || failures.length) {
      throw new Error(
        `Chat Plan Mode smoke failed: ${JSON.stringify({
          failures,
          consoleErrors,
          pageErrors,
          responseErrors,
        })}`,
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
    const summaryPath = join(artifactDir, "summary.json");
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
