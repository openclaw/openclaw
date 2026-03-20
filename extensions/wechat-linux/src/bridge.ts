import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type {
  BridgeEnvelope,
  BridgeProbe,
  BridgeResolveTargetResult,
  BridgeSearchKind,
  BridgeSearchResult,
  BridgeSendResult,
  ResolvedWechatLinuxAccount,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveBridgePath(): string {
  return fileURLToPath(new URL("../bridge/wechat_linux_bridge.py", import.meta.url));
}

function buildBridgeEnv(account: ResolvedWechatLinuxAccount): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(account.display ? { DISPLAY: account.display } : {}),
    ...(account.xauthority ? { XAUTHORITY: account.xauthority } : {}),
  };
}

function buildCommonArgs(account: ResolvedWechatLinuxAccount): string[] {
  const config = account.config;
  return [
    "--pywxdump-root",
    account.pyWxDumpRoot,
    "--key-file",
    account.keyFile,
    "--output-dir",
    account.outputDir,
    "--window-class",
    account.windowClass,
    "--window-mode",
    account.windowMode,
    ...(account.dbDir ? ["--db-dir", account.dbDir] : []),
    ...(account.display ? ["--display", account.display] : []),
    ...(account.xauthority ? ["--xauthority", account.xauthority] : []),
    ...(config.imageAnalysis === true
      ? ["--image-analysis"]
      : config.imageAnalysis === false
        ? ["--no-image-analysis"]
        : []),
    ...(config.videoAnalysis === true
      ? ["--video-analysis"]
      : config.videoAnalysis === false
        ? ["--no-video-analysis"]
        : []),
    ...(config.voiceAsr === true
      ? ["--voice-asr"]
      : config.voiceAsr === false
        ? ["--no-voice-asr"]
        : []),
    ...(config.linkDocs === true
      ? ["--link-docs"]
      : config.linkDocs === false
        ? ["--no-link-docs"]
        : []),
    ...(config.visionBaseUrl ? ["--vision-base-url", config.visionBaseUrl] : []),
    ...(config.visionModel ? ["--vision-model", config.visionModel] : []),
    ...(config.visionApiKeyEnv ? ["--vision-api-key-env", config.visionApiKeyEnv] : []),
    ...(config.summaryBaseUrl ? ["--summary-base-url", config.summaryBaseUrl] : []),
    ...(config.summaryModel ? ["--summary-model", config.summaryModel] : []),
    ...(config.summaryApiKeyEnv ? ["--summary-api-key-env", config.summaryApiKeyEnv] : []),
    ...(config.asrUrl ? ["--asr-url", config.asrUrl] : []),
    ...(config.linkHookCmd ? ["--link-hook-cmd", config.linkHookCmd] : []),
    ...(config.linkDocRoot ? ["--link-doc-root", config.linkDocRoot] : []),
    ...(config.linkDomains?.length ? ["--link-domains", config.linkDomains.join(",")] : []),
    ...(config.linkHookTimeoutSec
      ? ["--link-hook-timeout-sec", String(config.linkHookTimeoutSec)]
      : []),
  ];
}

export function spawnWechatLinuxBridgeWatch(
  account: ResolvedWechatLinuxAccount,
): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(account.pythonPath, [resolveBridgePath(), "watch", ...buildCommonArgs(account)], {
    env: buildBridgeEnv(account),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function parseWechatLinuxBridgeEnvelope(line: string): BridgeEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as BridgeEnvelope;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    if (parsed.type === "ready") {
      return parsed;
    }
    if (parsed.type === "message" && "message" in parsed) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseWechatLinuxBridgeJsonFromStdout<T>(stdout: string, command: string): T {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as T;
    } catch {
      // Ignore noisy stdout lines and keep looking for the last JSON object.
    }
  }
  throw new Error(`wechat-linux bridge returned invalid JSON for ${command}:\n${stdout.trim()}`);
}

export async function runWechatLinuxBridgeJson<T>(
  account: ResolvedWechatLinuxAccount,
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return await new Promise<T>((resolve, reject) => {
    const child = spawn(
      account.pythonPath,
      [resolveBridgePath(), command, ...buildCommonArgs(account), ...args],
      {
        env: buildBridgeEnv(account),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`wechat-linux bridge timed out after ${timeoutMs}ms (${command})`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const message =
          stderr.trim() || stdout.trim() || `${command} exited with ${code ?? signal}`;
        reject(new Error(message));
        return;
      }
      try {
        resolve(parseWechatLinuxBridgeJsonFromStdout<T>(stdout, command));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function probeWechatLinuxBridge(
  account: ResolvedWechatLinuxAccount,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BridgeProbe> {
  return await runWechatLinuxBridgeJson<BridgeProbe>(account, "probe", [], { timeoutMs });
}

export async function resolveWechatLinuxBridgeTarget(params: {
  account: ResolvedWechatLinuxAccount;
  input: string;
  kind?: "direct" | "group";
  timeoutMs?: number;
}): Promise<BridgeResolveTargetResult> {
  return await runWechatLinuxBridgeJson<BridgeResolveTargetResult>(
    params.account,
    "resolve-target",
    ["--input", params.input, ...(params.kind ? ["--kind", params.kind] : [])],
    { timeoutMs: params.timeoutMs },
  );
}

export async function sendWechatLinuxBridgeText(params: {
  account: ResolvedWechatLinuxAccount;
  chatId: string;
  text: string;
  timeoutMs?: number;
}): Promise<BridgeSendResult> {
  return await runWechatLinuxBridgeJson<BridgeSendResult>(
    params.account,
    "send-text",
    ["--chat-id", params.chatId, "--text", params.text],
    { timeoutMs: params.timeoutMs },
  );
}

export async function sendWechatLinuxBridgeFile(params: {
  account: ResolvedWechatLinuxAccount;
  chatId: string;
  path: string;
  image: boolean;
  timeoutMs?: number;
}): Promise<BridgeSendResult> {
  return await runWechatLinuxBridgeJson<BridgeSendResult>(
    params.account,
    params.image ? "send-image" : "send-file",
    ["--chat-id", params.chatId, "--path", params.path],
    { timeoutMs: params.timeoutMs },
  );
}

export async function searchWechatLinuxBridgeHistory(params: {
  account: ResolvedWechatLinuxAccount;
  searchKind: BridgeSearchKind;
  query?: string;
  chatId?: string;
  limit?: number;
  scanLimit?: number;
  timeoutMs?: number;
}): Promise<BridgeSearchResult> {
  return await runWechatLinuxBridgeJson<BridgeSearchResult>(
    params.account,
    "search-history",
    [
      "--search-kind",
      params.searchKind,
      ...(params.query ? ["--query", params.query] : []),
      ...(params.chatId ? ["--chat-id", params.chatId] : []),
      ...(params.limit ? ["--limit", String(params.limit)] : []),
      ...(params.scanLimit ? ["--scan-limit", String(params.scanLimit)] : []),
    ],
    { timeoutMs: params.timeoutMs ?? 120_000 },
  );
}
