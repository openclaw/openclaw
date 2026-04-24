import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND,
  DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND,
} from "./config.js";
import {
  GOOGLE_MEET_SYSTEM_PROFILER_COMMAND,
  outputMentionsBlackHole2ch,
} from "./transports/chrome.js";

type NodeBridgeSession = {
  id: string;
  input?: ChildProcess;
  output?: ChildProcess;
  chunks: Buffer[];
  waiters: Array<() => void>;
  closed: boolean;
  createdAt: string;
  lastInputAt?: string;
  lastOutputAt?: string;
  lastInputBytes: number;
  lastOutputBytes: number;
};

type BrowserStatus = {
  inCall?: boolean;
  micMuted?: boolean;
  browserUrl?: string;
  browserTitle?: string;
  status?: string;
  notes?: string[];
};

const sessions = new Map<string, NodeBridgeSession>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return result.length > 0 ? result : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function runCommandWithTimeout(argv: string[], timeoutMs: number) {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("command must not be empty");
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    code: typeof result.status === "number" ? result.status : result.error ? 1 : 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? formatErrorMessage(result.error) : ""),
  };
}

function runAppleScript(script: string, timeoutMs: number) {
  return runCommandWithTimeout(["/usr/bin/osascript", "-e", script], timeoutMs);
}

function normalizeAppleScriptString(value: string): string {
  return JSON.stringify(value);
}

function activeMeetTabStatus(timeoutMs: number): BrowserStatus {
  const script = `
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      set tabUrl to URL of t
      if tabUrl starts with "https://meet.google.com/" then
        set active tab index of w to index of t
        set index of w to 1
        set tabTitle to title of t
        return tabUrl & linefeed & tabTitle
      end if
    end repeat
  end repeat
end tell`;
  const result = runAppleScript(script, timeoutMs);
  if (result.code !== 0) {
    return {
      inCall: false,
      status: "browser-unavailable",
      notes: [result.stderr || result.stdout || "Google Chrome tab status unavailable"],
    };
  }
  const [browserUrl = "", browserTitle = ""] = result.stdout.split(/\r?\n/u);
  return {
    inCall: Boolean(browserUrl.trim()) && !/Meet$/u.test(browserTitle.trim()),
    browserUrl: browserUrl.trim() || undefined,
    browserTitle: browserTitle.trim() || undefined,
    status: "ok",
  };
}

function activateExistingMeetTab(url: string, timeoutMs: number): boolean {
  const script = `
set targetUrl to ${normalizeAppleScriptString(url)}
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t is targetUrl then
        set active tab index of w to index of t
        set index of w to 1
        activate
        return "found"
      end if
    end repeat
  end repeat
end tell
return "missing"`;
  const result = runAppleScript(script, timeoutMs);
  return result.code === 0 && result.stdout.trim() === "found";
}

function executeMeetTabScript(url: string, javascript: string, timeoutMs: number) {
  const script = `
set targetUrl to ${normalizeAppleScriptString(url)}
set source to ${normalizeAppleScriptString(javascript)}
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t starts with targetUrl then
        set active tab index of w to index of t
        set index of w to 1
        return execute t javascript source
      end if
    end repeat
  end repeat
end tell
return ""`;
  return runAppleScript(script, timeoutMs);
}

function tryAutoJoinMeet(params: {
  url: string;
  guestName: string;
  timeoutMs: number;
}): BrowserStatus {
  const js = `
(() => {
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const input = [...document.querySelectorAll('input')].find((el) =>
    /your name/i.test(el.getAttribute('aria-label') || el.placeholder || '')
  );
  if (input && !input.value) {
    input.focus();
    input.value = ${JSON.stringify(params.guestName)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const buttons = [...document.querySelectorAll('button')];
  const join = buttons.find((button) => /join now|ask to join/i.test(text(button)) && !button.disabled);
  if (join) join.click();
  const mic = buttons.find((button) => /turn off microphone|turn on microphone|microphone/i.test(button.getAttribute('aria-label') || text(button)));
  return JSON.stringify({
    clickedJoin: Boolean(join),
    inCall: buttons.some((button) => /leave call/i.test(button.getAttribute('aria-label') || text(button))),
    micMuted: mic ? /turn on microphone/i.test(mic.getAttribute('aria-label') || text(mic)) : undefined,
    title: document.title,
    url: location.href
  });
})();`;
  const result = executeMeetTabScript(params.url, js, Math.min(params.timeoutMs, 5_000));
  if (result.code !== 0) {
    return {
      ...activeMeetTabStatus(Math.min(params.timeoutMs, 2_000)),
      notes: [
        "Chrome JavaScript automation is unavailable; enable Chrome > View > Developer > Allow JavaScript from Apple Events for guest auto-join.",
        result.stderr || result.stdout || "unknown Apple Events failure",
      ],
    };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      inCall?: boolean;
      micMuted?: boolean;
      url?: string;
      title?: string;
    };
    return {
      inCall: parsed.inCall,
      micMuted: parsed.micMuted,
      browserUrl: parsed.url,
      browserTitle: parsed.title,
      status: "ok",
    };
  } catch {
    return activeMeetTabStatus(Math.min(params.timeoutMs, 2_000));
  }
}

async function waitForInCall(params: {
  url: string;
  guestName: string;
  autoJoin: boolean;
  timeoutMs: number;
}): Promise<BrowserStatus> {
  const deadline = Date.now() + Math.max(0, params.timeoutMs);
  let status: BrowserStatus = activeMeetTabStatus(2_000);
  while (Date.now() <= deadline) {
    status = params.autoJoin
      ? tryAutoJoinMeet({ url: params.url, guestName: params.guestName, timeoutMs: 5_000 })
      : activeMeetTabStatus(2_000);
    if (status.inCall === true) {
      return status;
    }
    await sleep(750);
  }
  return status;
}

function assertBlackHoleAvailable(timeoutMs: number) {
  if (process.platform !== "darwin") {
    throw new Error("Chrome Meet transport with blackhole-2ch audio is currently macOS-only");
  }
  const result = runCommandWithTimeout(
    [GOOGLE_MEET_SYSTEM_PROFILER_COMMAND, "SPAudioDataType"],
    timeoutMs,
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || !outputMentionsBlackHole2ch(output)) {
    throw new Error("BlackHole 2ch audio device not found on the node.");
  }
}

function splitCommand(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("audio command must not be empty");
  }
  return { command, args };
}

function wake(session: NodeBridgeSession) {
  const waiters = session.waiters.splice(0);
  for (const waiter of waiters) {
    waiter();
  }
}

function stopSession(session: NodeBridgeSession) {
  if (session.closed) {
    return;
  }
  session.closed = true;
  session.input?.kill("SIGTERM");
  session.output?.kill("SIGTERM");
  wake(session);
}

function startCommandPair(params: {
  inputCommand: string[];
  outputCommand: string[];
}): NodeBridgeSession {
  const input = splitCommand(params.inputCommand);
  const output = splitCommand(params.outputCommand);
  const session: NodeBridgeSession = {
    id: `meet_node_${randomUUID()}`,
    chunks: [],
    waiters: [],
    closed: false,
    createdAt: new Date().toISOString(),
    lastInputBytes: 0,
    lastOutputBytes: 0,
  };
  const outputProcess = spawn(output.command, output.args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const inputProcess = spawn(input.command, input.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.input = inputProcess;
  session.output = outputProcess;
  inputProcess.stdout?.on("data", (chunk) => {
    const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    session.lastInputAt = new Date().toISOString();
    session.lastInputBytes += audio.byteLength;
    session.chunks.push(audio);
    if (session.chunks.length > 200) {
      session.chunks.splice(0, session.chunks.length - 200);
    }
    wake(session);
  });
  inputProcess.on("exit", () => stopSession(session));
  outputProcess.on("exit", () => stopSession(session));
  inputProcess.on("error", () => stopSession(session));
  outputProcess.on("error", () => stopSession(session));
  sessions.set(session.id, session);
  return session;
}

async function pullAudio(params: Record<string, unknown>) {
  const bridgeId = readString(params.bridgeId);
  if (!bridgeId) {
    throw new Error("bridgeId required");
  }
  const session = sessions.get(bridgeId);
  if (!session) {
    throw new Error(`unknown bridgeId: ${bridgeId}`);
  }
  const timeoutMs = Math.min(readNumber(params.timeoutMs, 250), 2_000);
  if (session.chunks.length === 0 && !session.closed) {
    await Promise.race([
      sleep(timeoutMs),
      new Promise<void>((resolve) => {
        session.waiters.push(resolve);
      }),
    ]);
  }
  const chunk = session.chunks.shift();
  return {
    bridgeId,
    closed: session.closed,
    base64: chunk ? chunk.toString("base64") : undefined,
  };
}

function pushAudio(params: Record<string, unknown>) {
  const bridgeId = readString(params.bridgeId);
  const base64 = readString(params.base64);
  if (!bridgeId || !base64) {
    throw new Error("bridgeId and base64 required");
  }
  const session = sessions.get(bridgeId);
  if (!session || session.closed) {
    throw new Error(`bridge is not open: ${bridgeId}`);
  }
  const audio = Buffer.from(base64, "base64");
  session.lastOutputAt = new Date().toISOString();
  session.lastOutputBytes += audio.byteLength;
  session.output?.stdin?.write(audio);
  return { bridgeId, ok: true };
}

function startChrome(params: Record<string, unknown>) {
  const url = readString(params.url);
  if (!url) {
    throw new Error("url required");
  }
  const timeoutMs = readNumber(params.joinTimeoutMs, 30_000);
  assertBlackHoleAvailable(Math.min(timeoutMs, 10_000));

  const healthCommand = readStringArray(params.audioBridgeHealthCommand);
  if (healthCommand) {
    const health = runCommandWithTimeout(healthCommand, timeoutMs);
    if (health.code !== 0) {
      throw new Error(
        `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
      );
    }
  }

  let bridgeId: string | undefined;
  let audioBridge: { type: "external-command" | "node-command-pair" } | undefined;
  const bridgeCommand = readStringArray(params.audioBridgeCommand);
  if (bridgeCommand) {
    const bridge = runCommandWithTimeout(bridgeCommand, timeoutMs);
    if (bridge.code !== 0) {
      throw new Error(
        `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
      );
    }
    audioBridge = { type: "external-command" };
  } else if (params.mode === "realtime") {
    const session = startCommandPair({
      inputCommand: readStringArray(params.audioInputCommand) ?? [
        ...DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND,
      ],
      outputCommand: readStringArray(params.audioOutputCommand) ?? [
        ...DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND,
      ],
    });
    bridgeId = session.id;
    audioBridge = { type: "node-command-pair" };
  }

  if (params.launch !== false) {
    const argv = ["open", "-a", "Google Chrome"];
    const browserProfile = readString(params.browserProfile);
    if (browserProfile) {
      argv.push("--args", `--profile-directory=${browserProfile}`);
    }
    const reused = readBoolean(params.reuseExistingTab, true)
      ? activateExistingMeetTab(url, Math.min(timeoutMs, 5_000))
      : false;
    if (!reused) {
      argv.push(url);
      const result = runCommandWithTimeout(argv, timeoutMs);
      if (result.code !== 0) {
        if (bridgeId) {
          const session = sessions.get(bridgeId);
          if (session) {
            stopSession(session);
          }
        }
        throw new Error(
          `failed to launch Chrome for Meet: ${result.stderr || result.stdout || result.code}`,
        );
      }
    }
  }

  const waitForInCallMs = readNumber(params.waitForInCallMs, 20_000);
  return Promise.resolve(
    params.launch !== false && waitForInCallMs > 0
      ? waitForInCall({
          url,
          guestName: readString(params.guestName) ?? "OpenClaw Agent",
          autoJoin: readBoolean(params.autoJoin, true),
          timeoutMs: waitForInCallMs,
        })
      : activeMeetTabStatus(2_000),
  ).then((browser) => ({ launched: params.launch !== false, bridgeId, audioBridge, browser }));
}

function bridgeStatus(params: Record<string, unknown>) {
  const bridgeId = readString(params.bridgeId);
  const session = bridgeId ? sessions.get(bridgeId) : undefined;
  return {
    browser: activeMeetTabStatus(2_000),
    bridge: session
      ? {
          bridgeId,
          closed: session.closed,
          createdAt: session.createdAt,
          lastInputAt: session.lastInputAt,
          lastOutputAt: session.lastOutputAt,
          lastInputBytes: session.lastInputBytes,
          lastOutputBytes: session.lastOutputBytes,
        }
      : bridgeId
        ? { bridgeId, closed: true }
        : undefined,
  };
}

function stopChrome(params: Record<string, unknown>) {
  const bridgeId = readString(params.bridgeId);
  if (!bridgeId) {
    return { ok: true, stopped: false };
  }
  const session = sessions.get(bridgeId);
  if (!session) {
    return { ok: true, stopped: false };
  }
  stopSession(session);
  sessions.delete(bridgeId);
  return { ok: true, stopped: true };
}

export async function handleGoogleMeetNodeHostCommand(paramsJSON?: string | null): Promise<string> {
  const raw = paramsJSON ? JSON.parse(paramsJSON) : {};
  const params = asRecord(raw);
  const action = readString(params.action);
  let result: unknown;
  switch (action) {
    case "setup":
      assertBlackHoleAvailable(10_000);
      result = { ok: true };
      break;
    case "start":
      result = await startChrome(params);
      break;
    case "status":
      result = bridgeStatus(params);
      break;
    case "pullAudio":
      result = await pullAudio(params);
      break;
    case "pushAudio":
      result = pushAudio(params);
      break;
    case "stop":
      result = stopChrome(params);
      break;
    default:
      throw new Error("unsupported googlemeet.chrome action");
  }
  return JSON.stringify(result);
}
