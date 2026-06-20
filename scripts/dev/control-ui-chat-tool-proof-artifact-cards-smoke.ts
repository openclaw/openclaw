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
    <title>OpenClaw Chat Tool Proof Artifact Cards Smoke</title>
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
import "/ui/src/styles/chat/tool-cards.css";
import { render } from "lit";
import { renderChat } from "/ui/src/ui/views/chat.ts";

type Mode = "desktop" | "mobile";
type Result = { mode: Mode; ok: boolean; checks: Record<string, boolean>; bodyText: string };

declare global {
  interface Window {
    runOpenClawChatToolProofArtifactCardsSmoke: (mode: Mode) => Promise<Result>;
  }
}

const root = document.getElementById("root")!;
const sidebarCalls: unknown[] = [];

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
    autoExpandToolCalls: true,
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
    onOpenSidebar: (content: unknown) => sidebarCalls.push(content),
    onCloseSidebar: () => undefined,
    onSplitRatioChange: () => undefined,
    onChatScroll: () => undefined,
    basePath: "",
    ...overrides,
  };
}

const messages = [
  {
    id: "assistant-command-success",
    role: "assistant",
    timestamp: 1000,
    content: [
      {
        type: "toolcall",
        id: "cmd-success",
        name: "system.run",
        arguments: {
          command: "echo tool-card-ok",
          cwd: "/repo",
        },
      },
      {
        type: "toolresult",
        id: "cmd-success",
        name: "system.run",
        text: JSON.stringify({
          exitCode: 0,
          durationMs: 1800,
          stdout: "tool-card-ok",
        }),
      },
      {
        type: "toolresult",
        id: "proof-success",
        name: "github.run",
        text: JSON.stringify({
          workflow: "Workflow Sanity",
          runId: "27818122460",
          runUrl: "https://github.com/SnowBelt/openclaw/actions/runs/27818122460",
          headSha: "0963807b1a",
          conclusion: "success",
          evidence: "Remote proof completed on the implementation SHA.",
        }),
      },
      {
        type: "toolresult",
        id: "artifact-summary",
        name: "artifacts.write",
        text: JSON.stringify({
          title: "Smoke summary",
          kind: "report",
          artifactPath: ".artifacts/control-ui-chat-tool-proof-artifact-cards/summary.json",
          ok: true,
          summary: "Summary artifact was written.",
        }),
      },
      {
        type: "toolcall",
        id: "cmd-failed",
        name: "exec.command",
        arguments: { command: "node missing-script.js" },
      },
      {
        type: "toolresult",
        id: "cmd-failed",
        name: "exec.command",
        text: JSON.stringify({ exitCode: 1, stderr: "missing-script failed" }),
      },
    ],
  },
];

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

window.runOpenClawChatToolProofArtifactCardsSmoke = async (mode: Mode): Promise<Result> => {
  sidebarCalls.length = 0;
  const checks: Record<string, boolean> = {};
  await renderState({ messages, draft: "hello", getDraft: () => "hello", onSend: () => undefined });

  const commandCards = [...root.querySelectorAll('[data-tool-card-kind="command"]')];
  const proofEvidence = root.querySelector('[data-tool-card-kind="proof"]');
  const proofCard = proofEvidence?.closest('.chat-tool-card');
  const artifactEvidence = root.querySelector('[data-tool-card-kind="artifact"]');
  const artifactCard = artifactEvidence?.closest('.chat-tool-card');

  checks.commandSuccess = commandCards.some(
    (card) => includes(card, "Passed") && includes(card, "echo tool-card-ok"),
  );
  checks.commandFailure = commandCards.some(
    (card) => includes(card, "Failed") && includes(card, "missing-script failed"),
  );
  checks.proofCard =
    includes(proofCard, "Proof") &&
    includes(proofCard, "Workflow Sanity") &&
    includes(proofCard, "27818122460") &&
    includes(proofCard, "Passed");
  checks.artifactCard =
    includes(artifactCard, "Smoke summary") &&
    includes(artifactCard, ".artifacts/control-ui-chat-tool-proof-artifact-cards/summary.json");

  artifactCard?.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn")?.click();
  checks.artifactAction = sidebarCalls.length >= 1;

  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
  checks.composerUsable = Boolean(root.querySelector("textarea"));

  if (mode === "mobile") {
    checks.mobileViewport = window.matchMedia("(max-width: 720px)").matches;
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
    return await window.runOpenClawChatToolProofArtifactCardsSmoke(nextMode);
  }, mode);
  if (!result.ok) {
    throw new Error(
      `Chat tool/proof/artifact cards ${mode} smoke failed: ${JSON.stringify(
        result.checks,
        null,
        2,
      )}`,
    );
  }
  return result;
}

async function main() {
  const artifactDir = join(
    ".artifacts",
    "control-ui-chat-tool-proof-artifact-cards",
    timestampSlug(),
  );
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
      define: { "process.argv": "[]", "process.env": "{}" },
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
