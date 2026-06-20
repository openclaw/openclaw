import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import {
  appendControlUiTokenFragment,
  redactControlUiSmokeSecrets,
} from "./control-ui-smoke-url.js";

export const CONTROL_DIRECTOR_NO_RESPONSE_PROMPT = "empty response exhaustion qa check";
export const CONTROL_DIRECTOR_EXPECTED_VISIBLE_MARKERS = Object.freeze([
  "Verified state",
  "Next build gap",
  "Completion Grade:",
  "Criticality:",
  "Status: continuing",
]);
export const CONTROL_DIRECTOR_NO_RESPONSE_PROOF_SCRIPT = "ui:smoke:control-director-no-response";
export const MOBILE_WEB_VIEWPORT_PROOF_KIND = "mobile web viewport proof";
export const NATIVE_MOBILE_DEVICE_PROOF_KIND = "native mobile device proof";
const SMOKE_SEND_ERROR_KEY = "controlDirectorNoResponseSmokeSendError";

export type ControlDirectorMobileProofKind =
  | typeof MOBILE_WEB_VIEWPORT_PROOF_KIND
  | typeof NATIVE_MOBILE_DEVICE_PROOF_KIND;

type GatewayInstance = {
  port: number;
  url: string;
  token: string;
  artifactDir: string;
  stateDir: string;
  configPath: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  stop: () => Promise<void>;
};

type MockProviderInstance = {
  baseUrl: string;
  stop: () => Promise<void>;
};

export type ControlDirectorNoResponseVisibilityValidation =
  | { ok: true; missing: [] }
  | { ok: false; missing: string[] };

export type ControlDirectorMobileDeviceSummary = {
  iosDevices: string[];
  androidDevices: string[];
};

export type ControlDirectorMobileProofDecision = {
  proofKind: ControlDirectorMobileProofKind;
  nativeDeviceRequired: boolean;
  deviceSummary: ControlDirectorMobileDeviceSummary;
};

export type ControlDirectorNoResponseDiagnostics = {
  livenessAuditPresent: boolean;
  missionLedgerPresent: boolean;
  unsupportedCompleteDelivered: boolean;
  sessionKey: string | null;
  matchingSessionKeys: string[];
};

export type ControlDirectorNoResponseSmokeSummary = {
  ok: true;
  proofKind: ControlDirectorMobileProofKind;
  webVisibleStatus: string;
  mobileVisibleStatus: string;
  livenessAuditPresent: boolean;
  missionLedgerPresent: boolean;
  unsupportedCompleteDelivered: false;
  artifactDir: string;
  stateDir: string;
  mockProviderUrl: string;
  screenshots: {
    web: string;
    mobile: string;
  };
  mobileDeviceCheck: ControlDirectorMobileDeviceSummary;
  sessionDiagnostics: ControlDirectorNoResponseDiagnostics;
  consoleErrors: string[];
  responseErrors: string[];
  pageErrors: string[];
};

type DeviceCommand = {
  command: string;
  args: string[];
};

type DeviceCommandRunner = (
  command: string,
  args: string[],
) => {
  stdout: string;
  status: number | null;
  error?: unknown;
};

type SessionRow = {
  key?: unknown;
  controlDirectorLivenessAudit?: unknown;
  controlDirectorMissionLedger?: unknown;
};

type SessionsListResult = {
  sessions?: SessionRow[];
};

type ChatProofResult = {
  visibleText: string;
  sessionKey: string | null;
  screenshotPath: string;
};

function extractSmokeText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return record.content
      .map((entry) => extractSmokeText(entry))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function collectControlDirectorSmokeVisibleText(messages: readonly unknown[]): string {
  return messages
    .map((message) => extractSmokeText(message))
    .filter(Boolean)
    .join("\n\n");
}

export function extractControlDirectorSmokeHistoryMessages(value: unknown): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.messages) ? record.messages : [];
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactSmokeSecrets(value: string): string {
  return redactControlUiSmokeSecrets(value);
}

function mockProviderApiBaseUrl(provider: MockProviderInstance): string {
  return provider.baseUrl.replace(/\/v1\/?$/iu, "") + "/v1";
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

function resolveGatewayEntrypoint(): string {
  const explicit = process.env.OPENCLAW_CONTROL_DIRECTOR_SMOKE_GATEWAY_ENTRYPOINT?.trim();
  if (explicit) {
    return explicit;
  }
  // This proof validates the current checkout, not a possibly stale dist/ build.
  // scripts/run-node.mjs rebuilds/runs the local sources as needed and keeps the
  // dashboard smoke aligned with the active worktree.
  return "scripts/run-node.mjs";
}

function formatLogs(stdout: string[], stderr: string[]): string {
  return `--- stdout ---\n${redactSmokeSecrets(stdout.join(""))}\n--- stderr ---\n${redactSmokeSecrets(
    stderr.join(""),
  )}`;
}

function ensureControlUiBuild(): void {
  const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
  const nodeOptions = existingNodeOptions?.includes("--max-old-space-size=")
    ? existingNodeOptions
    : [existingNodeOptions, "--max-old-space-size=6144"].filter(Boolean).join(" ");
  const result = spawnSync("pnpm", ["ui:build"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.status === 0) {
    return;
  }
  const stdout = redactSmokeSecrets(result.stdout || "");
  const stderr = redactSmokeSecrets(result.stderr || "");
  throw new Error(
    `Control UI build failed before no-response smoke (status=${result.status ?? "signal"}, signal=${
      result.signal ?? "none"
    }).\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  );
}

function hasArrayEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildControlDirectorNoResponseSmokeCommand(): string[] {
  return ["pnpm", CONTROL_DIRECTOR_NO_RESPONSE_PROOF_SCRIPT];
}

export function validateVisibleBlockedText(
  text: string,
): ControlDirectorNoResponseVisibilityValidation {
  const missing = CONTROL_DIRECTOR_EXPECTED_VISIBLE_MARKERS.filter(
    (marker) => !text.includes(marker),
  );
  if (/\bStatus\s*:\s*complete\b/iu.test(text)) {
    missing.push("no unsupported delivered Status: complete");
  }
  return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing };
}

export function validateSessionDiagnostics(params: {
  sessions: SessionRow[];
  sessionKey?: string | null;
  visibleText: string;
}): ControlDirectorNoResponseDiagnostics {
  const targetKey = params.sessionKey?.trim() || null;
  const candidateRows = params.sessions.filter((row) => {
    if (!targetKey) {
      return (
        hasArrayEntries(row.controlDirectorLivenessAudit) ||
        hasArrayEntries(row.controlDirectorMissionLedger)
      );
    }
    return (
      row.key === targetKey ||
      hasArrayEntries(row.controlDirectorLivenessAudit) ||
      hasArrayEntries(row.controlDirectorMissionLedger)
    );
  });
  const livenessAuditPresent = candidateRows.some((row) =>
    hasArrayEntries(row.controlDirectorLivenessAudit),
  );
  const missionLedgerPresent = candidateRows.some((row) =>
    hasArrayEntries(row.controlDirectorMissionLedger),
  );
  const unsupportedCompleteDelivered = /\bStatus\s*:\s*complete\b/iu.test(params.visibleText);
  return {
    livenessAuditPresent,
    missionLedgerPresent,
    unsupportedCompleteDelivered,
    sessionKey: targetKey,
    matchingSessionKeys: candidateRows
      .map((row) => (typeof row.key === "string" ? row.key : null))
      .filter((key): key is string => Boolean(key)),
  };
}

export function assertControlDirectorNoResponseEvidence(params: {
  diagnostics: ControlDirectorNoResponseDiagnostics;
  visibleText: string;
}) {
  const visible = validateVisibleBlockedText(params.visibleText);
  const missing = [
    ...(visible.ok ? [] : visible.missing),
    ...(params.diagnostics.livenessAuditPresent ? [] : ["controlDirectorLivenessAudit"]),
    ...(params.diagnostics.missionLedgerPresent ? [] : ["controlDirectorMissionLedger"]),
    ...(params.diagnostics.unsupportedCompleteDelivered
      ? ["no unsupported delivered Status: complete"]
      : []),
  ];
  if (missing.length > 0) {
    throw new Error(`Control Director no-response proof missing evidence: ${missing.join(", ")}`);
  }
}

export function mobileDeviceDetectionCommands(): DeviceCommand[] {
  return [
    { command: "xcrun", args: ["xctrace", "list", "devices"] },
    { command: "adb", args: ["devices"] },
  ];
}

function defaultDeviceCommandRunner(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function parseIosDeviceLines(output: string): string[] {
  const deviceSection = output.split(/^==\s*Simulators\s*==$/imu)[0] ?? output;
  return deviceSection
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\b(?:iPhone|iPad|iPod)\b/u.test(line))
    .filter((line) => !line.startsWith("=="))
    .filter((line) => !/simulator|unavailable|placeholder|disconnected/iu.test(line));
}

export function parseAndroidDeviceLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("\tdevice"))
    .filter((line) => !line.startsWith("emulator-"));
}

export function detectMobileDevices(
  runner: DeviceCommandRunner = defaultDeviceCommandRunner,
): ControlDirectorMobileDeviceSummary {
  const [iosCommand, androidCommand] = mobileDeviceDetectionCommands();
  const iosResult = runner(iosCommand.command, iosCommand.args);
  const androidResult = runner(androidCommand.command, androidCommand.args);
  return {
    iosDevices: iosResult.status === 0 ? parseIosDeviceLines(iosResult.stdout) : [],
    androidDevices: androidResult.status === 0 ? parseAndroidDeviceLines(androidResult.stdout) : [],
  };
}

export function resolveMobileProofDecision(
  deviceSummary: ControlDirectorMobileDeviceSummary,
): ControlDirectorMobileProofDecision {
  const nativeDeviceRequired =
    deviceSummary.iosDevices.length > 0 || deviceSummary.androidDevices.length > 0;
  return {
    proofKind: nativeDeviceRequired
      ? NATIVE_MOBILE_DEVICE_PROOF_KIND
      : MOBILE_WEB_VIEWPORT_PROOF_KIND,
    nativeDeviceRequired,
    deviceSummary,
  };
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve an ephemeral loopback port");
  }
  return address.port;
}

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  return await Promise.race([
    new Promise<boolean>((resolve) => {
      if (childHasExited(child)) {
        resolve(true);
        return;
      }
      child.once("exit", () => resolve(true));
    }),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    }),
  ]);
}

function signalChildProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (childHasExited(child)) {
    return;
  }
  if (platform() !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child when process groups are unavailable.
    }
  }
  child.kill(signal);
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams) {
  signalChildProcess(child, "SIGTERM");
  const stopped = await waitForExit(child, 2_000);
  if (!stopped) {
    signalChildProcess(child, "SIGKILL");
    await waitForExit(child, 2_000);
  }
}

async function cleanupWithTimeout(label: string, cleanup: () => Promise<unknown>) {
  await Promise.race([
    cleanup(),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        console.warn(`control-ui-control-director-no-response-smoke: cleanup timed out: ${label}`);
        resolve();
      }, 5_000);
    }),
  ]);
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
  throw new Error(
    `Timed out waiting for isolated Gateway on ${params.port}:\n${formatLogs(
      params.stdout,
      params.stderr,
    )}`,
  );
}

async function startMockProvider(): Promise<MockProviderInstance> {
  const { startQaMockOpenAiServer } =
    await import("../../extensions/qa-lab/src/providers/mock-openai/server.js");
  return (await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 })) as MockProviderInstance;
}

async function writeGatewayConfig(params: {
  configPath: string;
  gatewayPort: number;
  mockProviderBaseUrl: string;
  token: string;
  workspaceDir: string;
}) {
  const { buildQaGatewayConfig } = await import("../../extensions/qa-lab/src/qa-gateway-config.js");
  const config = buildQaGatewayConfig({
    bind: "loopback",
    controlUiEnabled: true,
    gatewayPort: params.gatewayPort,
    gatewayToken: params.token,
    primaryModel: "mock-openai/gpt-5.5",
    alternateModel: "mock-openai/gpt-5.5-alt",
    providerBaseUrl: params.mockProviderBaseUrl,
    providerMode: "mock-openai",
    workspaceDir: params.workspaceDir,
  });
  const nextConfig = {
    ...config,
    agents: {
      ...config.agents,
      list: [
        {
          id: "main",
          default: true,
          model: { primary: "mock-openai/gpt-5.5" },
          identity: {
            name: "Control Director",
            theme: "Reliability proof",
            emoji: "🦞",
          },
          subagents: { allowAgents: ["*"] },
          tools: { profile: "coding" },
        },
      ],
    },
    hooks: { enabled: false },
  };
  await fs.mkdir(params.workspaceDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    join(params.workspaceDir, "QA_KICKOFF_TASK.md"),
    "# QA kickoff task\n\nUse this fixture for deterministic no-response proof.\n",
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(params.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function startIsolatedGateway(params: {
  artifactDir: string;
  mockProviderBaseUrl: string;
}): Promise<GatewayInstance> {
  const port = await getFreePort();
  const token = `control-director-no-response-smoke-${randomUUID()}`;
  const homeDir = join(params.artifactDir, "home");
  const stateDir = join(homeDir, ".openclaw");
  const configPath = join(stateDir, "openclaw.json");
  const workspaceDir = join(homeDir, "workspace");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  await writeGatewayConfig({
    configPath,
    gatewayPort: port,
    mockProviderBaseUrl: params.mockProviderBaseUrl,
    token,
    workspaceDir,
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const entrypoint = resolveGatewayEntrypoint();
  const child = spawn(
    "node",
    [entrypoint, "gateway", "--port", String(port), "--bind", "loopback", "--allow-unconfigured"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_PASSWORD: "",
        OPENCLAW_GATEWAY_TOKEN: "",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  try {
    await waitForPortOpen({ child, port, stdout, stderr, timeoutMs: 300_000 });
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }

  return {
    artifactDir: params.artifactDir,
    child,
    configPath,
    port,
    stateDir,
    stderr,
    stdout,
    token,
    url: `http://127.0.0.1:${port}/`,
    stop: async () => stopChildProcess(child),
  };
}

async function resolveBrowserExecutable(
  chromiumExecutablePath: string,
): Promise<string | undefined> {
  const explicit = process.env.OPENCLAW_CONTROL_UI_SMOKE_BROWSER?.trim();
  if (explicit) {
    return explicit;
  }
  if (chromiumExecutablePath && existsSync(chromiumExecutablePath)) {
    return chromiumExecutablePath;
  }
  return localChromeCandidates().find((candidate) => existsSync(candidate));
}

async function waitForChatReady(page: Page) {
  const startedAt = Date.now();
  let lastState: unknown;
  while (Date.now() - startedAt < 120_000) {
    const ready = await page.evaluate(() => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { connected?: boolean; handleSendChat?: unknown })
        | null;
      return app?.connected === true && typeof app.handleSendChat === "function";
    });
    if (ready) {
      return;
    }
    lastState = await page.evaluate(() => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            connected?: boolean;
            handleSendChat?: unknown;
            lastError?: unknown;
            client?: unknown;
          })
        | null;
      return {
        hasApp: Boolean(app),
        connected: app?.connected === true,
        hasHandleSendChat: typeof app?.handleSendChat === "function",
        hasClient: Boolean(app?.client),
        lastError: typeof app?.lastError === "string" ? app.lastError : undefined,
        text: document.body.textContent?.replace(/\s+/g, " ").trim().slice(0, 1000) ?? "",
      };
    });
    if (
      typeof lastState === "object" &&
      lastState &&
      "text" in lastState &&
      typeof (lastState as { text?: unknown }).text === "string" &&
      (lastState as { text: string }).text.includes("Control UI assets not found")
    ) {
      await page.waitForTimeout(1_000);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      continue;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Control UI chat did not become ready: ${JSON.stringify(lastState)}`);
}

async function sendControlDirectorPrompt(page: Page, prompt: string): Promise<string | null> {
  return await page.evaluate(
    async ({ message, sendErrorKey }) => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            handleSendChat?: (messageOverride?: string) => Promise<void>;
            sessionKey?: string;
          })
        | null;
      if (!app?.handleSendChat) {
        throw new Error("Control UI chat send handler was not ready");
      }
      const smokeState = globalThis as Record<string, unknown>;
      smokeState[sendErrorKey] = null;
      void app.handleSendChat(message).catch((error: unknown) => {
        smokeState[sendErrorKey] = error instanceof Error ? error.message : String(error);
      });
      const startedAt = Date.now();
      while (Date.now() - startedAt < 3_000) {
        if (typeof app.sessionKey === "string" && app.sessionKey.trim()) {
          return app.sessionKey;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      return typeof app.sessionKey === "string" && app.sessionKey.trim() ? app.sessionKey : null;
    },
    { message: prompt, sendErrorKey: SMOKE_SEND_ERROR_KEY },
  );
}

async function waitForVisibleBlockedResponse(page: Page): Promise<string> {
  const deadline = Date.now() + 300_000;
  let lastVisibleText = "";
  while (Date.now() < deadline) {
    const result = await page.evaluate(
      async ({ markers, sendErrorKey }) => {
        function extractText(value: unknown): string {
          if (typeof value === "string") {
            return value;
          }
          if (!value || typeof value !== "object") {
            return "";
          }
          const record = value as Record<string, unknown>;
          if (typeof record.text === "string") {
            return record.text;
          }
          if (typeof record.content === "string") {
            return record.content;
          }
          if (Array.isArray(record.content)) {
            return record.content
              .map((entry) => extractText(entry))
              .filter(Boolean)
              .join("\n");
          }
          return "";
        }
        function collectMessagesText(messages: readonly unknown[]): string {
          return messages
            .map((message) => extractText(message))
            .filter(Boolean)
            .join("\n\n");
        }
        function hasAllMarkers(text: string): boolean {
          return markers.every((marker) => text.includes(marker));
        }
        const app = document.querySelector("openclaw-app") as
          | (HTMLElement & {
              chatMessages?: unknown[];
              chatRunId?: string | null;
              chatStream?: string | null;
              client?: {
                request?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
              };
              requestUpdate?: () => void;
              sessionKey?: string;
            })
          | null;
        const smokeState = globalThis as Record<string, unknown>;
        const sendError = smokeState[sendErrorKey];
        if (typeof sendError === "string" && sendError) {
          throw new Error(`Control UI chat send failed: ${sendError}`);
        }
        const messageText = collectMessagesText(app?.chatMessages ?? []);
        const bodyText = document.body.textContent ?? "";
        const currentVisibleText = `${messageText}\n${app?.chatStream ?? ""}\n${bodyText}`;
        if (hasAllMarkers(currentVisibleText)) {
          return { ok: true, text: currentVisibleText };
        }
        const sessionKey = typeof app?.sessionKey === "string" ? app.sessionKey.trim() : "";
        if (!sessionKey || !app?.client?.request) {
          return { ok: false, text: currentVisibleText };
        }
        const history = (await app.client.request("chat.history", {
          sessionKey,
          limit: 200,
          maxChars: 4000,
        })) as { messages?: unknown[] };
        const historyMessages = Array.isArray(history.messages) ? history.messages : [];
        const historyText = collectMessagesText(historyMessages);
        if (!hasAllMarkers(historyText)) {
          return { ok: false, text: historyText || currentVisibleText };
        }
        app.chatMessages = historyMessages;
        app.chatStream = null;
        app.chatRunId = null;
        app.requestUpdate?.();
        return { ok: true, text: historyText };
      },
      {
        markers: CONTROL_DIRECTOR_EXPECTED_VISIBLE_MARKERS as string[],
        sendErrorKey: SMOKE_SEND_ERROR_KEY,
      },
    );
    if (result.ok) {
      return result.text;
    }
    lastVisibleText = result.text;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Timed out waiting for Control Director visible recovery response. Last visible text: ${normalizeVisibleText(
      lastVisibleText,
    )}`,
  );
}

async function readSessionDiagnostics(page: Page, sessionKey: string | null, visibleText: string) {
  const result = await page.evaluate(async () => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          client?: {
            request?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
          };
        })
      | null;
    const response = await app?.client?.request?.("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    return response ?? null;
  });
  const sessions =
    result && typeof result === "object" && Array.isArray((result as SessionsListResult).sessions)
      ? ((result as SessionsListResult).sessions ?? [])
      : [];
  return validateSessionDiagnostics({ sessionKey, sessions, visibleText });
}

async function runChatProof(params: {
  artifactDir: string;
  browser: Browser;
  consoleErrors: string[];
  contextOptions: BrowserContextOptions;
  gateway: GatewayInstance;
  label: string;
  metadata: Record<string, string>;
  pageErrors: string[];
  responseErrors: string[];
  screenshotName: string;
}): Promise<ChatProofResult> {
  const context = await params.browser.newContext(params.contextOptions);
  await context.addInitScript((metadata) => {
    localStorage.setItem("openclaw.controlUi.clientMetadata", JSON.stringify(metadata));
  }, params.metadata);
  const page = await context.newPage();
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  page.on("console", (message) => {
    if (message.type() === "error") {
      params.consoleErrors.push(redactSmokeSecrets(message.text()));
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      params.responseErrors.push(`${response.status()} ${redactSmokeSecrets(response.url())}`);
    }
  });
  page.on("pageerror", (error) => params.pageErrors.push(redactSmokeSecrets(error.message)));
  try {
    await page.goto(appendControlUiTokenFragment(params.gateway.url, params.gateway.token), {
      waitUntil: "domcontentloaded",
    });
    await waitForChatReady(page);
    const sessionKey = await sendControlDirectorPrompt(page, CONTROL_DIRECTOR_NO_RESPONSE_PROMPT);
    const visibleText = await waitForVisibleBlockedResponse(page);
    const normalizedVisibleText = normalizeVisibleText(visibleText);
    const validation = validateVisibleBlockedText(visibleText);
    if (!validation.ok) {
      throw new Error(
        `${params.label} visible response missing markers: ${validation.missing.join(", ")}. Visible text: ${normalizedVisibleText}`,
      );
    }
    const screenshotPath = join(params.artifactDir, params.screenshotName);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    return { visibleText, sessionKey, screenshotPath };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function runSmoke() {
  const artifactDir =
    process.env.OPENCLAW_CONTROL_UI_CONTROL_DIRECTOR_ARTIFACT_DIR?.trim() ||
    join(".artifacts", "control-ui-control-director-no-response", timestampSlug());
  mkdirSync(artifactDir, { recursive: true });

  const deviceSummary = detectMobileDevices();
  const mobileDecision = resolveMobileProofDecision(deviceSummary);
  if (mobileDecision.nativeDeviceRequired) {
    throw new Error(
      `Real mobile device detected; native-device proof is required but this smoke only implements browser and mobile viewport proof. Devices: ${JSON.stringify(
        deviceSummary,
      )}`,
    );
  }

  ensureControlUiBuild();

  const { chromium } = await import("playwright");
  const executablePath = await resolveBrowserExecutable(chromium.executablePath());
  if (!executablePath) {
    throw new Error(
      "No Playwright Chromium or local Chrome-compatible browser found. Install Playwright browsers or set OPENCLAW_CONTROL_UI_SMOKE_BROWSER.",
    );
  }

  let browser: Browser | null = null;
  let gateway: GatewayInstance | null = null;
  let mockProvider: MockProviderInstance | null = null;
  const consoleErrors: string[] = [];
  const responseErrors: string[] = [];
  const pageErrors: string[] = [];

  try {
    mockProvider = await startMockProvider();
    gateway = await startIsolatedGateway({
      artifactDir,
      mockProviderBaseUrl: mockProviderApiBaseUrl(mockProvider),
    });
    browser = await chromium.launch({ headless: true, executablePath });
    browser.on("disconnected", () => undefined);

    const webProof = await runChatProof({
      artifactDir,
      browser,
      consoleErrors,
      contextOptions: { viewport: { width: 1360, height: 960 } },
      gateway,
      label: "web",
      metadata: {
        deviceFamily: "control-ui-smoke",
        displayName: "OpenClaw Control Director no-response web proof",
        platform: "desktop",
      },
      pageErrors,
      responseErrors,
      screenshotName: "01-web-blocked.png",
    });

    const mobileProof = await runChatProof({
      artifactDir,
      browser,
      consoleErrors,
      contextOptions: {
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
      gateway,
      label: MOBILE_WEB_VIEWPORT_PROOF_KIND,
      metadata: {
        deviceFamily: "mobile-web",
        displayName: "OpenClaw Control Director no-response mobile viewport proof",
        platform: "mobile-web",
      },
      pageErrors,
      responseErrors,
      screenshotName: "02-mobile-web-viewport-blocked.png",
    });

    const diagnosticsPage = await browser.newPage();
    await diagnosticsPage.addInitScript("globalThis.__name = (fn) => fn;");
    await diagnosticsPage.goto(appendControlUiTokenFragment(gateway.url, gateway.token), {
      waitUntil: "domcontentloaded",
    });
    await waitForChatReady(diagnosticsPage);
    const diagnostics = await readSessionDiagnostics(
      diagnosticsPage,
      mobileProof.sessionKey ?? webProof.sessionKey,
      `${webProof.visibleText}\n${mobileProof.visibleText}`,
    );
    await diagnosticsPage.close().catch(() => undefined);

    assertControlDirectorNoResponseEvidence({
      diagnostics,
      visibleText: `${webProof.visibleText}\n${mobileProof.visibleText}`,
    });

    const summary: ControlDirectorNoResponseSmokeSummary = {
      ok: true,
      proofKind: mobileDecision.proofKind,
      webVisibleStatus: "visible recovery status",
      mobileVisibleStatus: "visible recovery status",
      livenessAuditPresent: diagnostics.livenessAuditPresent,
      missionLedgerPresent: diagnostics.missionLedgerPresent,
      unsupportedCompleteDelivered: false,
      artifactDir,
      stateDir: gateway.stateDir,
      mockProviderUrl: mockProvider.baseUrl,
      screenshots: {
        web: webProof.screenshotPath,
        mobile: mobileProof.screenshotPath,
      },
      mobileDeviceCheck: deviceSummary,
      sessionDiagnostics: diagnostics,
      consoleErrors,
      responseErrors,
      pageErrors,
    };
    writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `control-ui-control-director-no-response-smoke: ok ${JSON.stringify(summary, null, 2)}`,
    );
  } catch (error) {
    const logs = gateway ? `\nGateway logs:\n${formatLogs(gateway.stdout, gateway.stderr)}` : "";
    throw new Error(
      `${redactSmokeSecrets(error instanceof Error ? error.stack || error.message : String(error))}${logs}`,
      { cause: error },
    );
  } finally {
    if (browser) {
      await cleanupWithTimeout("browser", () => browser.close()).catch(() => undefined);
    }
    if (gateway) {
      await cleanupWithTimeout("gateway", () => gateway.stop()).catch(() => undefined);
    }
    if (mockProvider) {
      await cleanupWithTimeout("mock-provider", () => mockProvider.stop()).catch(() => undefined);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSmoke().then(
    () => {
      process.exit(0);
    },
    (error: unknown) => {
      console.error(
        "control-ui-control-director-no-response-smoke: failed",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    },
  );
}
