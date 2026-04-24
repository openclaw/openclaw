import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig } from "../config.js";
import {
  startNodeRealtimeAudioBridge,
  type ChromeNodeRealtimeAudioBridgeHandle,
} from "../realtime-node.js";
import {
  startCommandRealtimeAudioBridge,
  type ChromeRealtimeAudioBridgeHandle,
} from "../realtime.js";
import type { GoogleMeetChromeHealth } from "./types.js";

export const GOOGLE_MEET_SYSTEM_PROFILER_COMMAND = "/usr/sbin/system_profiler";

export function outputMentionsBlackHole2ch(output: string): boolean {
  return /\bBlackHole\s+2ch\b/i.test(output);
}

export async function assertBlackHole2chAvailable(params: {
  runtime: PluginRuntime;
  timeoutMs: number;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Chrome Meet transport with blackhole-2ch audio is currently macOS-only");
  }

  const result = await params.runtime.system.runCommandWithTimeout(
    [GOOGLE_MEET_SYSTEM_PROFILER_COMMAND, "SPAudioDataType"],
    { timeoutMs: params.timeoutMs },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.code !== 0 || !outputMentionsBlackHole2ch(output)) {
    const hint =
      params.runtime.system.formatNativeDependencyHint?.({
        packageName: "BlackHole 2ch",
        downloadCommand: "brew install blackhole-2ch",
      }) ?? "";
    throw new Error(
      [
        "BlackHole 2ch audio device not found.",
        "Install BlackHole 2ch and route Chrome input/output through the OpenClaw audio bridge.",
        hint,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

export async function launchChromeMeet(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  mode: "realtime" | "transcribe";
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle);
}> {
  await assertBlackHole2chAvailable({
    runtime: params.runtime,
    timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
  });

  if (params.config.chrome.audioBridgeHealthCommand) {
    const health = await params.runtime.system.runCommandWithTimeout(
      params.config.chrome.audioBridgeHealthCommand,
      { timeoutMs: params.config.chrome.joinTimeoutMs },
    );
    if (health.code !== 0) {
      throw new Error(
        `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
      );
    }
  }

  let audioBridge:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle)
    | undefined;

  if (params.config.chrome.audioBridgeCommand) {
    const bridge = await params.runtime.system.runCommandWithTimeout(
      params.config.chrome.audioBridgeCommand,
      { timeoutMs: params.config.chrome.joinTimeoutMs },
    );
    if (bridge.code !== 0) {
      throw new Error(
        `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
      );
    }
    audioBridge = { type: "external-command" };
  } else if (params.mode === "realtime") {
    if (!params.config.chrome.audioInputCommand || !params.config.chrome.audioOutputCommand) {
      throw new Error(
        "Chrome realtime mode requires chrome.audioInputCommand and chrome.audioOutputCommand, or chrome.audioBridgeCommand for an external bridge.",
      );
    }
    audioBridge = {
      type: "command-pair",
      ...(await startCommandRealtimeAudioBridge({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        meetingSessionId: params.meetingSessionId,
        inputCommand: params.config.chrome.audioInputCommand,
        outputCommand: params.config.chrome.audioOutputCommand,
        logger: params.logger,
      })),
    };
  }

  if (!params.config.chrome.launch) {
    return { launched: false, audioBridge };
  }

  const argv = ["open", "-a", "Google Chrome"];
  if (params.config.chrome.browserProfile) {
    argv.push("--args", `--profile-directory=${params.config.chrome.browserProfile}`);
  }
  argv.push(params.url);

  let commandPairBridgeStopped = false;
  const stopCommandPairBridge = async () => {
    if (commandPairBridgeStopped) {
      return;
    }
    commandPairBridgeStopped = true;
    if (audioBridge?.type === "command-pair") {
      await audioBridge.stop();
    }
  };

  try {
    const result = await params.runtime.system.runCommandWithTimeout(argv, {
      timeoutMs: params.config.chrome.joinTimeoutMs,
    });
    if (result.code === 0) {
      return { launched: true, audioBridge };
    }
    await stopCommandPairBridge();
    throw new Error(
      `failed to launch Chrome for Meet: ${result.stderr || result.stdout || result.code}`,
    );
  } catch (error) {
    await stopCommandPairBridge();
    throw error;
  }
}

function isGoogleMeetNode(node: {
  caps?: string[];
  commands?: string[];
  connected?: boolean;
  nodeId?: string;
  displayName?: string;
  remoteIp?: string;
}) {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  const caps = Array.isArray(node.caps) ? node.caps : [];
  return (
    node.connected === true &&
    commands.includes("googlemeet.chrome") &&
    (commands.includes("browser.proxy") || caps.includes("browser"))
  );
}

async function resolveChromeNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
}): Promise<string> {
  const list = await params.runtime.nodes.list({ connected: true });
  const nodes = list.nodes.filter(isGoogleMeetNode);
  if (nodes.length === 0) {
    throw new Error(
      "No connected Google Meet-capable node with browser proxy. Run `openclaw node run` on the Chrome host with browser proxy enabled, approve pairing, and allow googlemeet.chrome plus browser.proxy.",
    );
  }
  const requested = params.requestedNode?.trim();
  if (requested) {
    const matches = nodes.filter((node) =>
      [node.nodeId, node.displayName, node.remoteIp].some((value) => value === requested),
    );
    if (matches.length === 1) {
      return matches[0].nodeId;
    }
    throw new Error(`Google Meet node not found or ambiguous: ${requested}`);
  }
  if (nodes.length === 1) {
    return nodes[0].nodeId;
  }
  throw new Error(
    "Multiple Google Meet-capable nodes connected. Set plugins.entries.google-meet.config.chromeNode.node.",
  );
}

function parseNodeStartResult(raw: unknown): {
  launched?: boolean;
  bridgeId?: string;
  audioBridge?: { type?: string };
  browser?: GoogleMeetChromeHealth;
} {
  const value =
    raw && typeof raw === "object" && "payload" in raw
      ? (raw as { payload?: unknown }).payload
      : raw;
  if (!value || typeof value !== "object") {
    throw new Error("Google Meet node returned an invalid start result.");
  }
  return value as {
    launched?: boolean;
    bridgeId?: string;
    audioBridge?: { type?: string };
    browser?: GoogleMeetChromeHealth;
  };
}

type BrowserProxyResult = {
  result?: unknown;
};

type BrowserTab = {
  targetId?: string;
  title?: string;
  url?: string;
};

function unwrapNodeInvokePayload(raw: unknown): unknown {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof record.payloadJSON === "string" && record.payloadJSON.trim()) {
    return JSON.parse(record.payloadJSON);
  }
  if ("payload" in record) {
    return record.payload;
  }
  return raw;
}

function parseBrowserProxyResult(raw: unknown): unknown {
  const payload = unwrapNodeInvokePayload(raw);
  const proxy =
    payload && typeof payload === "object" ? (payload as BrowserProxyResult) : undefined;
  if (!proxy || !("result" in proxy)) {
    throw new Error("Google Meet browser proxy returned an invalid result.");
  }
  return proxy.result;
}

async function callBrowserProxyOnNode(params: {
  runtime: PluginRuntime;
  nodeId: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
}) {
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: "browser.proxy",
    params: {
      method: params.method,
      path: params.path,
      body: params.body,
      timeoutMs: params.timeoutMs,
    },
    timeoutMs: params.timeoutMs + 5_000,
  });
  return parseBrowserProxyResult(raw);
}

function asBrowserTabs(result: unknown): BrowserTab[] {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  return Array.isArray(record.tabs) ? (record.tabs as BrowserTab[]) : [];
}

function readBrowserTab(result: unknown): BrowserTab | undefined {
  return result && typeof result === "object" ? (result as BrowserTab) : undefined;
}

function parseMeetBrowserStatus(result: unknown): GoogleMeetChromeHealth | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const raw = record.result;
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as {
    inCall?: boolean;
    micMuted?: boolean;
    manualActionRequired?: boolean;
    manualActionReason?: GoogleMeetChromeHealth["manualActionReason"];
    manualActionMessage?: string;
    url?: string;
    title?: string;
  };
  return {
    inCall: parsed.inCall,
    micMuted: parsed.micMuted,
    manualActionRequired: parsed.manualActionRequired,
    manualActionReason: parsed.manualActionReason,
    manualActionMessage: parsed.manualActionMessage,
    browserUrl: parsed.url,
    browserTitle: parsed.title,
    status: "browser-control",
  };
}

function meetStatusScript(params: { guestName: string; autoJoin: boolean }) {
  return `() => {
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const input = [...document.querySelectorAll('input')].find((el) =>
    /your name/i.test(el.getAttribute('aria-label') || el.placeholder || '')
  );
  if (${JSON.stringify(params.autoJoin)} && input && !input.value) {
    input.focus();
    input.value = ${JSON.stringify(params.guestName)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const buttons = [...document.querySelectorAll('button')];
  const pageText = text(document.body).toLowerCase();
  const host = location.hostname.toLowerCase();
  const pageUrl = location.href;
  const join = ${JSON.stringify(params.autoJoin)}
    ? buttons.find((button) => /join now|ask to join/i.test(text(button)) && !button.disabled)
    : null;
  if (join) join.click();
  const mic = buttons.find((button) => /turn off microphone|turn on microphone|microphone/i.test(button.getAttribute('aria-label') || text(button)));
  const inCall = buttons.some((button) => /leave call/i.test(button.getAttribute('aria-label') || text(button)));
  let manualActionReason;
  let manualActionMessage;
  if (!inCall && (host === "accounts.google.com" || /use your google account|to continue to google meet|choose an account|sign in to (join|continue)/i.test(pageText))) {
    manualActionReason = "google-login-required";
    manualActionMessage = "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.";
  } else if (!inCall && /asking to be let in|you.?ll join when someone lets you in|waiting to be let in|ask to join/i.test(pageText)) {
    manualActionReason = "meet-admission-required";
    manualActionMessage = "Admit the OpenClaw browser participant in Google Meet, then retry speech.";
  } else if (!inCall && /allow.*(microphone|camera)|blocked.*(microphone|camera)|permission.*(microphone|camera)/i.test(pageText)) {
    manualActionReason = "meet-permission-required";
    manualActionMessage = "Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry.";
  }
  return JSON.stringify({
    clickedJoin: Boolean(join),
    inCall,
    micMuted: mic ? /turn on microphone/i.test(mic.getAttribute('aria-label') || text(mic)) : undefined,
    manualActionRequired: Boolean(manualActionReason),
    manualActionReason,
    manualActionMessage,
    title: document.title,
    url: pageUrl
  });
}`;
}

async function openMeetWithBrowserProxy(params: {
  runtime: PluginRuntime;
  nodeId: string;
  config: GoogleMeetConfig;
  url: string;
}): Promise<{ launched: boolean; browser?: GoogleMeetChromeHealth }> {
  if (!params.config.chrome.launch) {
    return { launched: false };
  }

  const timeoutMs = Math.max(1_000, params.config.chrome.joinTimeoutMs);
  let targetId: string | undefined;
  let tab: BrowserTab | undefined;
  if (params.config.chrome.reuseExistingTab) {
    const tabs = asBrowserTabs(
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId: params.nodeId,
        method: "GET",
        path: "/tabs",
        timeoutMs: Math.min(timeoutMs, 5_000),
      }),
    );
    tab = tabs.find((entry) => entry.url === params.url);
    targetId = tab?.targetId;
    if (targetId) {
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId: params.nodeId,
        method: "POST",
        path: "/tabs/focus",
        body: { targetId },
        timeoutMs: Math.min(timeoutMs, 5_000),
      });
    }
  }
  if (!targetId) {
    tab = readBrowserTab(
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId: params.nodeId,
        method: "POST",
        path: "/tabs/open",
        body: { url: params.url },
        timeoutMs,
      }),
    );
    targetId = tab?.targetId;
  }
  if (!targetId) {
    return {
      launched: true,
      browser: {
        status: "browser-control",
        notes: ["Browser proxy opened Meet but did not return a targetId."],
        browserUrl: tab?.url,
        browserTitle: tab?.title,
      },
    };
  }

  const deadline = Date.now() + Math.max(0, params.config.chrome.waitForInCallMs);
  let browser: GoogleMeetChromeHealth | undefined = {
    status: "browser-control",
    browserUrl: tab?.url,
    browserTitle: tab?.title,
  };
  do {
    try {
      const evaluated = await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId: params.nodeId,
        method: "POST",
        path: "/act",
        body: {
          kind: "evaluate",
          targetId,
          fn: meetStatusScript({
            guestName: params.config.chrome.guestName,
            autoJoin: params.config.chrome.autoJoin,
          }),
        },
        timeoutMs: Math.min(timeoutMs, 10_000),
      });
      browser = parseMeetBrowserStatus(evaluated) ?? browser;
      if (browser?.inCall === true) {
        return { launched: true, browser };
      }
      if (browser?.manualActionRequired === true) {
        return { launched: true, browser };
      }
    } catch (error) {
      browser = {
        ...browser,
        inCall: false,
        manualActionRequired: true,
        manualActionReason: "browser-control-unavailable",
        manualActionMessage:
          "Open the OpenClaw browser profile, finish Google Meet login, admission, or permission prompts, then retry.",
        notes: [
          `Browser control could not inspect or auto-join Meet: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
      break;
    }
    if (Date.now() <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  } while (Date.now() <= deadline);
  return { launched: true, browser };
}

export async function launchChromeMeetOnNode(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  mode: "realtime" | "transcribe";
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  nodeId: string;
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "node-command-pair" } & ChromeNodeRealtimeAudioBridgeHandle);
  browser?: GoogleMeetChromeHealth;
}> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  const browserControl = await openMeetWithBrowserProxy({
    runtime: params.runtime,
    nodeId,
    config: params.config,
    url: params.url,
  });
  const raw = await params.runtime.nodes.invoke({
    nodeId,
    command: "googlemeet.chrome",
    params: {
      action: "start",
      url: params.url,
      mode: params.mode,
      launch: false,
      browserProfile: params.config.chrome.browserProfile,
      joinTimeoutMs: params.config.chrome.joinTimeoutMs,
      audioInputCommand: params.config.chrome.audioInputCommand,
      audioOutputCommand: params.config.chrome.audioOutputCommand,
      audioBridgeCommand: params.config.chrome.audioBridgeCommand,
      audioBridgeHealthCommand: params.config.chrome.audioBridgeHealthCommand,
    },
    timeoutMs: params.config.chrome.joinTimeoutMs + 5_000,
  });
  const result = parseNodeStartResult(raw);
  if (result.audioBridge?.type === "node-command-pair") {
    if (!result.bridgeId) {
      throw new Error("Google Meet node did not return an audio bridge id.");
    }
    const bridge = await startNodeRealtimeAudioBridge({
      config: params.config,
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      meetingSessionId: params.meetingSessionId,
      nodeId,
      bridgeId: result.bridgeId,
      logger: params.logger,
    });
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBridge: bridge,
      browser: browserControl.browser ?? result.browser,
    };
  }
  if (result.audioBridge?.type === "external-command") {
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBridge: { type: "external-command" },
      browser: browserControl.browser ?? result.browser,
    };
  }
  return {
    nodeId,
    launched: browserControl.launched || result.launched === true,
    browser: browserControl.browser ?? result.browser,
  };
}
