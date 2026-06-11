import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import { platform } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  appendControlUiTokenFragment,
  redactControlUiSmokeSecrets,
} from "./control-ui-smoke-url.js";

type GatewayInstance = {
  port: number;
  baseUrl: string;
  appStudioUrl: string;
  token: string;
  artifactDir: string;
  stateDir: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  stop: () => Promise<void>;
};

type DashboardSnapshot = {
  selectedProject?: {
    appName?: string;
    appDir?: string;
    latestReports?: {
      aiBuild?: Record<string, unknown> | null;
      patch?: Record<string, unknown> | null;
    };
  } | null;
};

type AppStudioFlowResult = {
  snapshot: DashboardSnapshot;
  attempts: Array<{
    attempt: number;
    connectedToAi: boolean;
    hasPatchReport: boolean;
    error: string | null;
  }>;
};

type AiBuildReport = {
  connectedToAi?: boolean;
  rawOutputSha256?: string | null;
  changedFiles?: string[];
  ready?: boolean;
  error?: string | null;
};

type PatchReport = {
  applied?: boolean;
  ready?: boolean;
  changedFiles?: string[];
  rejectedChanges?: unknown[];
};

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redact(value: string): string {
  return redactControlUiSmokeSecrets(value);
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

function resolveRepoRoot(): string {
  return process.cwd();
}

function resolveGatewayEntrypoint(repoRoot: string): string {
  for (const relative of ["dist/index.js", "dist/index.mjs", "scripts/run-node.mjs"]) {
    const candidate = path.join(repoRoot, relative);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not find a Gateway entrypoint.");
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve an ephemeral loopback port");
  }
  return address.port;
}

function formatLogs(stdout: string[], stderr: string[]): string {
  return `--- stdout ---\n${redact(stdout.join(""))}\n--- stderr ---\n${redact(stderr.join(""))}`;
}

async function waitForPortOpen(params: {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stdout: string[];
  stderr: string[];
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (params.child.exitCode !== null) {
      throw new Error(
        `Gateway exited before listening (code=${String(params.child.exitCode)}):\n${formatLogs(
          params.stdout,
          params.stderr,
        )}`,
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: params.port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(
    `Timed out waiting for isolated Gateway on ${params.port}:\n${formatLogs(
      params.stdout,
      params.stderr,
    )}`,
  );
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  return await Promise.race([
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      child.once("exit", () => resolve(true));
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function startIsolatedGateway(
  repoRoot: string,
  artifactDir: string,
): Promise<GatewayInstance> {
  const port = await getFreePort();
  const token = `app-studio-smoke-${randomUUID()}`;
  const homeDir = path.join(artifactDir, "home");
  const stateDir = path.join(homeDir, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          port,
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: true },
        },
        hooks: { enabled: false },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(
    "node",
    [
      resolveGatewayEntrypoint(repoRoot),
      "gateway",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      cwd: artifactDir,
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: "",
        OPENCLAW_GATEWAY_PASSWORD: "",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  await waitForPortOpen({ child, port, stdout, stderr, timeoutMs: 90_000 });

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    port,
    baseUrl,
    appStudioUrl: `${baseUrl}/app-studio`,
    token,
    artifactDir,
    stateDir,
    child,
    stdout,
    stderr,
    stop: async () => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
      const stopped = await waitForExit(child, 2_000);
      if (!stopped && child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000);
      }
    },
  };
}

async function assertOllamaModelAvailable() {
  const response = await fetch("http://127.0.0.1:11434/api/tags");
  if (!response.ok) {
    throw new Error(`Ollama tags returned HTTP ${response.status}`);
  }
  const parsed = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
  const hasQwen = (parsed.models ?? []).some(
    (model) => model.name === "qwen3.6:27b-q8_0" || model.model === "qwen3.6:27b-q8_0",
  );
  if (!hasQwen) {
    throw new Error("Ollama is reachable, but qwen3.6:27b-q8_0 is not installed.");
  }
}

async function readDashboardSnapshot(page: Page): Promise<DashboardSnapshot> {
  const handle = await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { appStudioDashboard?: DashboardSnapshot | null })
        | null;
      return app?.appStudioDashboard?.selectedProject ? app.appStudioDashboard : null;
    },
    null,
    { timeout: 60_000 },
  );
  return (await handle.jsonValue()) as DashboardSnapshot;
}

async function waitForSelectedProject(page: Page, appName: string): Promise<DashboardSnapshot> {
  const handle = await page.waitForFunction(
    (expectedName) => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { appStudioDashboard?: DashboardSnapshot | null })
        | null;
      const snapshot = app?.appStudioDashboard;
      return snapshot?.selectedProject?.appName === expectedName ? snapshot : null;
    },
    appName,
    { timeout: 120_000 },
  );
  return (await handle.jsonValue()) as DashboardSnapshot;
}

async function waitForAiGateResult(page: Page): Promise<DashboardSnapshot> {
  const handle = await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            appStudioDashboard?: DashboardSnapshot | null;
            appStudioSavingAction?: string | null;
          })
        | null;
      const snapshot = app?.appStudioDashboard;
      const reports = snapshot?.selectedProject?.latestReports;
      if (app?.appStudioSavingAction || !reports?.aiBuild) {
        return null;
      }
      const aiBuild = reports.aiBuild as { error?: unknown };
      return reports.patch || typeof aiBuild.error === "string" ? snapshot : null;
    },
    null,
    { timeout: 900_000 },
  );
  return (await handle.jsonValue()) as DashboardSnapshot;
}

function aiAttemptFromSnapshot(snapshot: DashboardSnapshot, attempt: number) {
  const reports = snapshot.selectedProject?.latestReports;
  const aiBuild = reports?.aiBuild ?? null;
  return {
    attempt,
    connectedToAi: aiBuild?.connectedToAi === true,
    hasPatchReport: reports?.patch !== null && reports?.patch !== undefined,
    error: typeof aiBuild?.error === "string" ? aiBuild.error : null,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`Missing ${label}.`);
}

async function runAiBuildAttempt(page: Page, artifactDir: string, attempt: number) {
  await page.getByRole("button", { name: "Run AI build pass", exact: true }).first().click();
  await page.waitForFunction(
    () =>
      document.body.textContent.includes("AI build running") ||
      document.body.textContent.includes("Working now"),
    null,
    { timeout: 30_000 },
  );
  await page.screenshot({
    path: path.join(artifactDir, `03-ai-running-attempt-${attempt}.png`),
    fullPage: false,
  });
  const snapshot = await waitForAiGateResult(page);
  await page.screenshot({
    path: path.join(artifactDir, `04-ai-result-attempt-${attempt}.png`),
    fullPage: false,
  });
  return snapshot;
}

async function runAppStudioFlow(page: Page, artifactDir: string): Promise<AppStudioFlowResult> {
  await page.getByText("Prompt-first app builder").waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Build new app", exact: true }).waitFor({
    timeout: 60_000,
  });
  await page.screenshot({ path: path.join(artifactDir, "01-initial.png"), fullPage: false });

  const appName = `AI Smoke ${Date.now()}`;
  await page
    .locator(".app-studio-prompt-card textarea")
    .first()
    .fill(
      "Create a private birdwatching checklist app with sightings, local notes, no accounts, and no tracking.",
    );
  await page.locator(".app-studio-create-fields input").nth(0).fill(appName);
  await page.locator(".app-studio-create-fields input").nth(1).fill("ai-smoke");
  await page.locator(".app-studio-create-fields input").nth(2).fill("com.openclaw.aismoke");
  await page.getByRole("button", { name: "Build new app", exact: true }).click();

  let snapshot = await waitForSelectedProject(page, appName);
  await page.getByText("AI build status").waitFor({ timeout: 60_000 });
  await page.screenshot({ path: path.join(artifactDir, "02-created.png"), fullPage: false });

  const attempts: AppStudioFlowResult["attempts"] = [];
  const maxAttempts = Number.parseInt(
    process.env.OPENCLAW_CONTROL_UI_APP_STUDIO_AI_ATTEMPTS ?? "2",
    10,
  );
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    snapshot = await runAiBuildAttempt(page, artifactDir, attempt);
    const attemptResult = aiAttemptFromSnapshot(snapshot, attempt);
    attempts.push(attemptResult);
    if (attemptResult.hasPatchReport) {
      return { snapshot, attempts };
    }
  }
  return { snapshot, attempts };
}

async function main() {
  await assertOllamaModelAvailable();
  const repoRoot = resolveRepoRoot();
  const artifactDir =
    process.env.OPENCLAW_CONTROL_UI_APP_STUDIO_ARTIFACT_DIR?.trim() ||
    path.join(repoRoot, ".artifacts", "control-ui-app-studio", timestampSlug());
  mkdirSync(artifactDir, { recursive: true });

  const executablePath = resolveBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      "No Playwright Chromium or local Chrome-compatible browser found. Install Playwright browsers or set OPENCLAW_CONTROL_UI_SMOKE_BROWSER.",
    );
  }

  let gateway: GatewayInstance | null = null;
  let browser: Browser | null = null;
  const consoleErrors: string[] = [];
  const responseErrors: string[] = [];
  const pageErrors: string[] = [];
  try {
    gateway = await startIsolatedGateway(repoRoot, artifactDir);
    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await context.addInitScript(
      (metadata) => {
        localStorage.setItem("openclaw.controlUi.clientMetadata", JSON.stringify(metadata));
      },
      {
        displayName: "OpenClaw App Studio smoke desktop profile",
        deviceFamily: "control-ui-smoke",
        platform: "desktop",
      },
    );
    const page = await context.newPage();
    await page.addInitScript("globalThis.__name = (fn) => fn;");
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(redact(message.text()));
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 500) {
        responseErrors.push(`${response.status()} ${redact(response.url())}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(redact(error.message)));

    await page.goto(appendControlUiTokenFragment(gateway.appStudioUrl, gateway.token), {
      waitUntil: "domcontentloaded",
    });
    const { snapshot, attempts } = await runAppStudioFlow(page, artifactDir);
    const appDir = requireString(snapshot.selectedProject?.appDir, "selected appDir");
    const reportDir = path.join(appDir, ".openclaw-app-builder");
    const aiBuild = await readJsonFile<AiBuildReport>(path.join(reportDir, "ai-build-report.json"));
    if (aiBuild.connectedToAi !== true) {
      throw new Error("AI build report did not prove a completed AI connection.");
    }
    if (!attempts.some((attempt) => attempt.hasPatchReport)) {
      throw new Error(
        `AI connected but did not produce a patch report after ${attempts.length} attempt(s): ${JSON.stringify(
          attempts,
        )}`,
      );
    }
    const patch = await readJsonFile<PatchReport>(path.join(reportDir, "patch-report.json"));
    await fs.access(path.join(reportDir, "ai-build-raw-output.txt"));
    await fs.access(path.join(reportDir, "patch-transcript.json"));

    const rawSha = requireString(aiBuild.rawOutputSha256, "AI raw output sha256");
    if (patch.applied !== true || !patch.changedFiles?.length) {
      throw new Error(`Patch report did not apply an app-local change: ${JSON.stringify(patch)}`);
    }
    const bodyText = await page.locator("body").textContent();
    for (const expected of [
      "Evidence proof",
      "AI connected",
      "ai-build-report.json",
      "patch-report.json",
      rawSha.slice(0, 12),
    ]) {
      if (!bodyText.includes(expected)) {
        throw new Error(`Dashboard did not show expected App Studio evidence text: ${expected}`);
      }
    }
    if (consoleErrors.length > 0 || responseErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(
        `App Studio smoke saw browser errors: ${JSON.stringify({
          consoleErrors,
          responseErrors,
          pageErrors,
        })}`,
      );
    }

    const summary = {
      ok: true,
      url: gateway.appStudioUrl,
      artifactDir,
      stateDir: gateway.stateDir,
      appDir,
      attempts,
      aiBuild: {
        connectedToAi: aiBuild.connectedToAi,
        ready: aiBuild.ready,
        rawOutputSha256: rawSha,
        changedFiles: aiBuild.changedFiles ?? [],
      },
      patch: {
        applied: patch.applied,
        ready: patch.ready,
        changedFiles: patch.changedFiles ?? [],
        rejectedChanges: patch.rejectedChanges?.length ?? 0,
      },
      consoleErrors,
      responseErrors,
      pageErrors,
    };
    writeFileSync(path.join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`control-ui-app-studio-smoke: ok ${JSON.stringify(summary, null, 2)}`);
  } catch (error) {
    const logs = gateway ? `\nGateway logs:\n${formatLogs(gateway.stdout, gateway.stderr)}` : "";
    throw new Error(
      `${redact(error instanceof Error ? error.stack || error.message : String(error))}${logs}`,
      { cause: error },
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await gateway?.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    "control-ui-app-studio-smoke: failed",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
