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
    <title>OpenClaw Chat Projects Smoke</title>
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
import { renderChat } from "/ui/src/ui/views/chat.ts";

type Mode = "desktop" | "mobile";
type Result = { mode: Mode; ok: boolean; checks: Record<string, boolean>; bodyText: string };

declare global {
  interface Window {
    runOpenClawChatProjectsSmoke: (mode: Mode) => Promise<Result>;
  }
}

const root = document.getElementById("root")!;
const projectsList = {
  ok: true,
  ts: 1,
  count: 2,
  projects: [
    {
      id: "project-alpha",
      name: "Alpha Project",
      description: "Research context",
      memoryMode: "project_only",
      createdAt: 1,
      updatedAt: 2,
      resources: [],
    },
    {
      id: "project-beta",
      name: "Beta Project",
      memoryMode: "project_only",
      createdAt: 1,
      updatedAt: 3,
      resources: [],
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

window.runOpenClawChatProjectsSmoke = async (mode: Mode): Promise<Result> => {
  const checks: Record<string, boolean> = {};
  const calls = {
    attach: [] as string[],
    detach: 0,
    newChat: [] as string[],
    create: 0,
    fields: [] as string[],
    sent: 0,
  };

  await renderState({
    projectsList,
    sessions: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      sessions: [{ key: "main", kind: "direct", updatedAt: 1 }],
    },
  });
  let picker = root.querySelector("[data-chat-project-picker]");
  checks.noProject = includes(picker, "No Project");

  await renderState({
    projectPickerOpen: true,
    projectCreateName: "New project",
    projectsList,
    sessions: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      sessions: [{ key: "main", kind: "direct", updatedAt: 1, projectId: "project-alpha" }],
    },
    onProjectAttach: (projectId: string) => calls.attach.push(projectId),
    onProjectDetach: () => calls.detach++,
    onNewProjectChat: (projectId: string) => calls.newChat.push(projectId),
    onProjectCreateAndAttach: () => calls.create++,
    onProjectCreateFieldChange: (field: string, value: string) => calls.fields.push(field + ":" + value),
  });
  picker = root.querySelector("[data-chat-project-picker]");
  checks.currentProject = includes(picker, "Alpha Project");
  checks.projectList = includes(picker, "Beta Project") && includes(picker, "Research context");
  root.querySelector<HTMLButtonElement>('[data-chat-project-action="attach"]')?.click();
  root.querySelector<HTMLButtonElement>('[data-chat-project-action="detach"]')?.click();
  root.querySelector<HTMLButtonElement>('[data-chat-project-action="new-chat"]')?.click();
  root.querySelector<HTMLButtonElement>('[data-chat-project-action="create-and-attach"]')?.click();
  const input = root.querySelector<HTMLInputElement>('input[placeholder="Project name"]')!;
  input.value = "Edited";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  checks.actions =
    calls.attach[0] === "project-beta" &&
    calls.detach === 1 &&
    calls.newChat[0] === "project-alpha" &&
    calls.create === 1 &&
    calls.fields.includes("name:Edited");

  await renderState({
    projectPickerOpen: true,
    projectError: "offline",
    draft: "hello",
    getDraft: () => "hello",
    onSend: () => calls.sent++,
  });
  picker = root.querySelector("[data-chat-project-picker]");
  checks.failureState = includes(picker, "Project status unavailable");
  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
  checks.composerStillSends = calls.sent === 1;

  if (mode === "mobile") {
    await renderState({ projectPickerOpen: true, projectsList });
    const details = root.querySelector<HTMLDetailsElement>("[data-chat-project-picker]")!;
    details.open = true;
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const panel = root.querySelector<HTMLElement>(".chat-project-picker__panel");
    checks.mobileViewport = window.matchMedia("(max-width: 720px)").matches;
    checks.mobileBottomSheet = panel ? getComputedStyle(panel).position === "fixed" : false;
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
  const result = await page.evaluate(async (nextMode) => {
    return await window.runOpenClawChatProjectsSmoke(nextMode);
  }, mode);
  if (!result.ok) {
    throw new Error(
      `Chat projects ${mode} smoke failed: ${JSON.stringify(result.checks, null, 2)}`,
    );
  }
  return result;
}

async function main() {
  const artifactDir = join(".artifacts", "control-ui-chat-projects", timestampSlug());
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
      resolve: controlUiSmokeViteResolve(),
      root: process.cwd(),
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
