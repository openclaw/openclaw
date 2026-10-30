import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { on, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLocalMeetingRealtimeAudioTransport,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
  type MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";

const tempDirs: string[] = [];
const spawnedChildren: ChildProcess[] = [];

type MeetRealtimeAudioSpawn = NonNullable<
  Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]["spawn"]
>;

const GOOGLE_MEET_ENGINE_BINDINGS = {
  platform: {
    displayName: "Google Meet",
    logScope: "[google-meet]",
    sessionIdPrefix: "google-meet",
  },
  consultAgent: async () => ({ text: "" }),
  tools: [],
  handleToolCall: async () => {},
};

const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function createTransport(
  script: string,
  overrides: Partial<Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]> = {},
) {
  return createLocalMeetingRealtimeAudioTransport({
    inputCommand: [process.execPath, script, "capture"],
    outputCommand: [process.execPath, script, "play"],
    bargeInRmsThreshold: 10,
    bargeInPeakThreshold: 10,
    bargeInCooldownMs: 1,
    logger: makeLogger(),
    logScope: "[google-meet]",
    spawn: recordingSpawn,
    ...overrides,
  });
}

function expectSignals(child: ChildProcess, signals: NodeJS.Signals[]) {
  for (const signal of signals) {
    expect(vi.mocked(child).kill.mock.calls.filter(([sent]) => sent === signal)).toHaveLength(1);
  }
}

const mockTransport = () =>
  ({
    onFatal: vi.fn(),
    startInput: vi.fn(),
    stop: vi.fn(async () => {}),
    writeOutput: vi.fn(async () => {}),
    clearOutput: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  }) satisfies MeetingRealtimeAudioTransport;

const mockTranscriptionSession = (connected = false) => ({
  connect: vi.fn(async () => {}),
  sendAudio: vi.fn(),
  close: vi.fn(),
  isConnected: vi.fn(() => connected),
});

const transcriptionProvider = (
  createSession: RealtimeTranscriptionProviderPlugin["createSession"],
): RealtimeTranscriptionProviderPlugin => ({
  id: "openai",
  label: "OpenAI",
  defaultModel: "gpt-4o-transcribe",
  autoSelectOrder: 1,
  resolveConfig: ({ rawConfig }) => rawConfig,
  isConfigured: () => true,
  createSession,
});

const mockVoiceBridge = () => ({
  ...mockTranscriptionSession(true),
  sendUserMessage: vi.fn(),
  setMediaTimestamp: vi.fn(),
  submitToolResult: vi.fn(),
  acknowledgeMark: vi.fn(),
  triggerGreeting: vi.fn(),
});

const engineOptions = (
  config: ReturnType<typeof resolveGoogleMeetConfig>,
  meetingSessionId: string,
) => ({
  config,
  fullConfig: {},
  runtime: {} as never,
  ...GOOGLE_MEET_ENGINE_BINDINGS,
  meetingSessionId,
  logger: makeLogger(),
});

function voiceFixture(
  realtime: { strategy?: "bidi" | "native"; provider?: string; agentId?: string } = {},
) {
  const config = resolveGoogleMeetConfig({
    realtime: { strategy: "bidi", provider: "openai", ...realtime },
  });
  const bridge = mockVoiceBridge();
  const transport = mockTransport();
  const provider = {
    id: config.realtime.provider,
    label: "Test voice provider",
    isConfigured: vi.fn<RealtimeVoiceProviderPlugin["isConfigured"]>(
      ({ agentId }) => !realtime.agentId || agentId === realtime.agentId,
    ),
    createBridge: vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>(() => bridge),
  } satisfies RealtimeVoiceProviderPlugin;
  const options = engineOptions(config, "meet-test");
  const close = () => provider.createBridge.mock.lastCall?.[0].onClose?.("completed");
  const start = (extra: Partial<Parameters<typeof startMeetingRealtimeEngine>[0]> = {}) =>
    startMeetingRealtimeEngine({ ...options, providers: [provider], transport, ...extra });
  return { bridge, transport, provider, logger: options.logger, close, start };
}

function writeCommand(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-bridge-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "bridge-command.mjs");
  writeFileSync(scriptPath, source, { mode: 0o755 });
  return scriptPath;
}

const BRIDGE_SCRIPT = `process.on('SIGTERM', () => {
  process.exit(0);
});
process.stdin.resume();
setInterval(() => {}, 1000);
`;

const SIGTERM_RESISTANT_SCRIPT = `process.stderr.write(\`starting:\${process.argv[2]}\\n\`);
process.stdin.resume();
setTimeout(() => {
  process.on('SIGTERM', () => {
    process.stderr.write('sigterm\\n');
  });
  process.stderr.write(\`ready:\${process.argv[2]}\\n\`);
}, 50);
setInterval(() => {}, 1000);
`;

async function waitForBridgeReady(
  stderr: NonNullable<ChildProcess["stderr"]>,
  role: "capture" | "play",
  signal: AbortSignal,
): Promise<void> {
  let pending = "";
  for await (const [chunk] of on(stderr, "data", { signal, close: ["end", "close"] })) {
    const lines = (pending + String(chunk)).split("\n");
    pending = lines.pop() ?? "";
    if (lines.includes(`ready:${role}`)) {
      return;
    }
  }
  throw new Error(`Bridge ${role} closed before readiness`);
}

const recordingSpawn: MeetRealtimeAudioSpawn = (command, args, options) => {
  const child = spawnChildProcess(command, args, options);
  spawnedChildren.push(child);
  return child as ReturnType<MeetRealtimeAudioSpawn>;
};

function agentFixture(inputFails = false) {
  const script = writeCommand(BRIDGE_SCRIPT);
  const sttSession = mockTranscriptionSession(!inputFails);
  const logger = makeLogger();
  const config = resolveGoogleMeetConfig({
    chrome: { audioFormat: "pcm16-24khz" },
    realtime: { provider: "openai", agentId: "jay", introMessage: "" },
  });
  const transport = createTransport(script, {
    logger,
    ...(inputFails
      ? { inputCommand: [path.join(path.dirname(script), "missing-capture")] }
      : {
          bargeInRmsThreshold: config.chrome.bargeInRmsThreshold,
          bargeInPeakThreshold: config.chrome.bargeInPeakThreshold,
          bargeInCooldownMs: config.chrome.bargeInCooldownMs,
        }),
  });
  const start = () =>
    startMeetingAgentRealtimeEngine({
      ...engineOptions(config, inputFails ? "meet-startup-failure" : "meet-1"),
      logger,
      transport,
      providers: [transcriptionProvider(() => sttSession)],
    });
  return { sttSession, logger, transport, start };
}

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

it("stops the engine when input fails during provider setup", async () => {
  const { sttSession, logger, transport, start } = agentFixture(true);
  const { promise: connecting, resolve: finishConnect } = Promise.withResolvers<void>();
  sttSession.connect.mockReturnValue(connecting);
  const engineResult = start().then(
    () => new Error("Expected Google Meet engine startup to fail"),
    (error: unknown) => error,
  );
  const inputProcess = spawnedChildren[1];
  if (!inputProcess) {
    throw new Error("Expected Google Meet transport to spawn an input child process");
  }

  await once(inputProcess, "error");
  await vi.waitFor(() => {
    expect(sttSession.close).toHaveBeenCalledTimes(1);
  });
  finishConnect();

  await expect(engineResult).resolves.toEqual(
    new Error("Google Meet audio transport stopped during transcription provider setup"),
  );
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining("[google-meet] audio input command failed:"),
  );
  await transport.dispose();
});

it("contains a forced local command-pair stdout stream error through bridge stop", async () => {
  const { sttSession, logger, start } = agentFixture();
  const handle = await start();
  const [outputProcess, inputProcess] = spawnedChildren;
  if (!inputProcess || !outputProcess) {
    throw new Error("Expected Google Meet bridge to spawn input and output child processes");
  }
  const inputClosed = once(inputProcess, "close");
  const outputClosed = once(outputProcess, "close");
  vi.spyOn(inputProcess, "kill");
  vi.spyOn(outputProcess, "kill");

  inputProcess.stdout?.destroy(new Error("EPIPE from real bridge input stdout"));
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  inputProcess.stderr?.destroy(new Error("duplicate stderr EPIPE"));

  await Promise.all([inputClosed, outputClosed]);
  expect(logger.warn).toHaveBeenCalledWith(
    "[google-meet] audio input command stdout failed: EPIPE from real bridge input stdout",
  );
  expect(handle.getHealth().bridgeClosed).toBe(true);
  expect(sttSession.close).toHaveBeenCalledTimes(1);
  expectSignals(inputProcess, ["SIGTERM"]);
  expectSignals(outputProcess, ["SIGTERM"]);
});

it.skipIf(process.platform === "win32")(
  "waits for SIGTERM-resistant bridge processes and shares the stop promise",
  async ({ signal: testSignal }) => {
    const bridgeScript = writeCommand(SIGTERM_RESISTANT_SCRIPT);
    const transport = createTransport(bridgeScript);
    const [outputProcess, inputProcess] = spawnedChildren;
    if (!inputProcess || !outputProcess || !inputProcess.stderr || !outputProcess.stderr) {
      throw new Error("Expected Google Meet bridge to spawn stderr-backed child processes");
    }
    await Promise.all([
      waitForBridgeReady(inputProcess.stderr, "capture", testSignal),
      waitForBridgeReady(outputProcess.stderr, "play", testSignal),
    ]);
    vi.spyOn(inputProcess, "kill");
    vi.spyOn(outputProcess, "kill");

    const startedAt = Date.now();
    const firstStop = transport.stop();
    const secondStop = transport.stop();

    expect(secondStop).toBe(firstStop);
    await firstStop;
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(5_000);
    expectSignals(inputProcess, ["SIGTERM", "SIGKILL"]);
    expectSignals(outputProcess, ["SIGTERM", "SIGKILL"]);
  },
);

it("preserves the configured realtime agent through provider startup", async () => {
  const fixture = voiceFixture({ agentId: "molty" });
  const handle = await fixture.start({
    meetingSessionId: "meet-routed-agent",
    fullConfig: { agents: { entries: { helper: {}, molty: {} } } } as never,
  });
  expect(fixture.provider.isConfigured).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "molty" }),
  );
  expect(fixture.provider.createBridge.mock.lastCall?.[0].agentId).toBe("molty");
  await handle.stop();
});

it("stops the audio transport when the provider bridge closes unexpectedly", async () => {
  const fixture = voiceFixture();
  const handle = await fixture.start({ meetingSessionId: "meet-unexpected-close" });
  fixture.close();
  await vi.waitFor(() => {
    expect(fixture.transport.stop).toHaveBeenCalledOnce();
    expect(fixture.transport.dispose).toHaveBeenCalledOnce();
  });
  expect(handle.getHealth().bridgeClosed).toBe(true);
});

it("retries only the unsettled transport teardown phase", async () => {
  const stopError = new Error("transport stop failed");
  const fixture = voiceFixture();
  fixture.bridge.close.mockImplementation(fixture.close);
  fixture.transport.stop.mockRejectedValueOnce(stopError).mockResolvedValueOnce(undefined);
  const handle = await fixture.start({ meetingSessionId: "meet-stop-retry" });
  await expect(handle.stop()).rejects.toBe(stopError);
  await expect(handle.stop()).resolves.toBeUndefined();
  expect(fixture.transport.stop).toHaveBeenCalledTimes(2);
  expect(fixture.transport.dispose).toHaveBeenCalledOnce();
  expect(fixture.bridge.close).toHaveBeenCalledOnce();
});

it("keeps a whole code point when a provider id crosses the log boundary", async () => {
  const prefix = "a".repeat(179);
  const fixture = voiceFixture({ strategy: "native", provider: prefix + "😀tail" });
  const handle = await fixture.start({ meetingSessionId: "long-provider-log" });
  expect(fixture.logger.info).toHaveBeenCalledWith(
    expect.stringContaining(`provider=${prefix} model=provider-default`),
  );
  await handle.stop();
});
