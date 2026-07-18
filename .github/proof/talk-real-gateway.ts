import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from "playwright";
import { WebSocket, WebSocketServer } from "ws";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
} from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { startGatewayServer } from "../../src/gateway/server.js";
import { getFreeGatewayPort } from "../../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../../src/test-utils/env.js";
import { normalizeGatewayTokenScope } from "../../ui/src/app/gateway-scope.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";

const PR_HEAD_SHA = "18ba59e3248be12e5d0e96afd632c5e425078869";
const PROOF_TIMEOUT_MS = 30_000;
const ARTIFACT_DIR = path.join(process.cwd(), ".artifacts", "proof-110302");

type JsonRecord = Record<string, unknown>;

type ProviderConnection = {
  closeCount: number;
  closed: boolean;
  receivedTypes: string[];
  sentAudio: boolean;
  socket: WebSocket;
};

type GatewayRequest = {
  id: string;
  method: string;
  params: JsonRecord;
};

function frameText(frame: string | Buffer): string {
  return typeof frame === "string" ? frame : frame.toString("utf8");
}

function parseRecord(frame: string | Buffer): JsonRecord | undefined {
  try {
    const value = JSON.parse(frameText(frame));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = PROOF_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function browserPageGatewayUrl(appBaseUrl: string): string {
  const parsed = new URL(appBaseUrl);
  const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${parsed.host}`;
}

async function selectGatewayOnNextLoad(
  page: Page,
  appBaseUrl: string,
  gatewayUrl: string,
): Promise<void> {
  const settingsKey = `openclaw.control.settings.v1:${normalizeGatewayTokenScope(gatewayUrl)}`;
  const selectionKey =
    `openclaw.control.currentGateway.v1:` +
    normalizeGatewayTokenScope(browserPageGatewayUrl(appBaseUrl));
  await page.addInitScript(
    ({ nextGatewayUrl, nextSelectionKey, nextSettingsKey }) => {
      localStorage.setItem(nextSettingsKey, JSON.stringify({ gatewayUrl: nextGatewayUrl }));
      localStorage.setItem(nextSelectionKey, nextGatewayUrl);
    },
    {
      nextGatewayUrl: gatewayUrl,
      nextSelectionKey: selectionKey,
      nextSettingsKey: settingsKey,
    },
  );
}

async function installTalkBrowserFixtures(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type InputProcessor = {
      onaudioprocess:
        | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
        | null;
    };
    const state = {
      constraints: [] as unknown[],
      initError: null as string | null,
      inputProcessor: null as InputProcessor | null,
      outputStarts: 0,
    };
    Reflect.set(window, "openclawTalkRealGatewayProof", state);
    const track = { stop() {} };

    class ProofAudioBufferSource extends EventTarget {
      buffer: { duration: number } | null = null;
      connect() {}
      start() {
        state.outputStarts += 1;
        window.setTimeout(() => this.dispatchEvent(new Event("ended")), 10);
      }
      stop() {
        this.dispatchEvent(new Event("ended"));
      }
    }

    class ProofAudioContext {
      readonly destination = {};
      readonly sampleRate: number;
      private readonly startedAt = performance.now();

      constructor(options?: { sampleRate?: number }) {
        this.sampleRate = options?.sampleRate ?? 24_000;
      }

      get currentTime() {
        return (performance.now() - this.startedAt) / 1000;
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }

      createScriptProcessor() {
        const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        state.inputProcessor = processor;
        return processor;
      }

      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          connect() {},
          disconnect() {},
          getFloatTimeDomainData(samples: Float32Array) {
            samples.fill(0);
          },
        };
      }

      createBuffer(_channels: number, length: number, sampleRate: number) {
        const samples = new Float32Array(length);
        return {
          duration: length / sampleRate,
          getChannelData: () => samples,
        };
      }

      createBufferSource() {
        return new ProofAudioBufferSource();
      }

      async close() {}
    }

    try {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          enumerateDevices: async () => [
            { kind: "audioinput", deviceId: "fixture", label: "Proof microphone" },
          ],
          getUserMedia: async (constraints: unknown) => {
            state.constraints.push(constraints);
            return { getTracks: () => [track] };
          },
        },
      });
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        value: ProofAudioContext,
      });
    } catch (error) {
      state.initError =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    }
  });
}

async function triggerMicrophoneFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = Reflect.get(window, "openclawTalkRealGatewayProof") as
      | {
          inputProcessor?: {
            onaudioprocess?: (event: {
              inputBuffer: { getChannelData: () => Float32Array };
            }) => void;
          };
        }
      | undefined;
    state?.inputProcessor?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.01) },
    });
  });
}

async function main(): Promise<void> {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  assert.equal(
    canRunPlaywrightChromium(chromiumExecutablePath),
    true,
    `Playwright Chromium unavailable at ${chromiumExecutablePath}`,
  );

  const envSnapshot = captureEnv([
    "HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_CRON",
    "OPENCLAW_SKIP_PROVIDERS",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
  ]);
  let tempRoot = "";
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let controlUiServer: ControlUiE2eServer | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let providerServer: WebSocketServer | undefined;

  try {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-real-gateway-proof-"));
    const stateDir = path.join(tempRoot, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });

    providerServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(providerServer, "listening");
    const providerAddress = providerServer.address();
    assert(providerAddress && typeof providerAddress !== "string");
    const providerConnections: ProviderConnection[] = [];
    providerServer.on("connection", (socket) => {
      const connection: ProviderConnection = {
        closeCount: 0,
        closed: false,
        receivedTypes: [],
        sentAudio: false,
        socket,
      };
      providerConnections.push(connection);
      socket.on("message", (raw) => {
        const event = parseRecord(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
        const type = typeof event?.type === "string" ? event.type : "unknown";
        connection.receivedTypes.push(type);
        if (type === "session.update") {
          // The Gateway returns session.create before provider readiness. The
          // proof acknowledges the current relay only after the browser has
          // installed its transport listener, avoiding a synthetic ready race.
          return;
        }
        if (type === "input_audio_buffer.append" && !connection.sentAudio) {
          connection.sentAudio = true;
          socket.send(
            JSON.stringify({
              type: "response.audio.delta",
              response_id: "response-proof",
              item_id: "item-proof",
              delta: Buffer.alloc(480).toString("base64"),
            }),
          );
        }
      });
      socket.on("close", () => {
        connection.closeCount += 1;
        connection.closed = true;
      });
    });

    controlUiServer = await startControlUiE2eServer();
    const controlUiOrigin = new URL(controlUiServer.baseUrl).origin;
    const gatewayPort = await getFreeGatewayPort();
    const token = "test-token";
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "token", token },
        controlUi: { allowedOrigins: [controlUiOrigin] },
      },
      agents: {
        defaults: {
          voiceModel: { primary: "openai/gpt-realtime-2.1" },
        },
      },
      talk: {
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2.1",
          transport: "gateway-relay",
          providers: {
            openai: {
              apiKey: "test-api-key",
              azureEndpoint: `http://127.0.0.1:${providerAddress.port}`,
            },
          },
        },
      },
    };
    await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    setTestEnvValue("HOME", tempRoot);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
    setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
    setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
    setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    const startupConfigSnapshotRead = await readConfigFileSnapshotWithPluginMetadata({
      observe: false,
    });
    gateway = await startGatewayServer(gatewayPort, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      startupConfigSnapshotRead,
    });

    browser = await chromium.launch({
      executablePath: chromiumExecutablePath,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    });
    context = await browser.newContext({
      locale: "en-US",
      permissions: ["microphone", "local-network-access"],
    });
    // Register before the first page so every document installs the media fixture
    // before application code can observe native browser media APIs.
    await installTalkBrowserFixtures(context);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const browserConsoleErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserConsoleErrors.push(message.text());
      }
    });
    const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`;
    await selectGatewayOnNextLoad(page, controlUiServer.baseUrl, gatewayUrl);

    const requests = new Map<string, GatewayRequest>();
    const closeRequests: string[] = [];
    const closeAcks = new Map<string, boolean>();
    const appendRequests: string[] = [];
    const appendAcks = new Map<string, boolean>();
    const audioEvents: string[] = [];
    const trace: string[] = [];
    let staleSessionId: string | undefined;
    let currentSessionId: string | undefined;
    let staleCreateRequestId: string | undefined;
    let currentCreateRequestId: string | undefined;
    let heldFirstCreateResponse: string | undefined;
    let gatewayRoute: WebSocketRoute | undefined;

    await page.routeWebSocket((url) => url.origin === new URL(gatewayUrl).origin, (route) => {
      gatewayRoute = route;
      const upstream = route.connectToServer();
      route.onMessage((frame) => {
        const text = frameText(frame);
        const parsed = parseRecord(text);
        if (
          parsed?.type === "req" &&
          typeof parsed.id === "string" &&
          typeof parsed.method === "string"
        ) {
          const params =
            parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
              ? (parsed.params as JsonRecord)
              : {};
          requests.set(parsed.id, { id: parsed.id, method: parsed.method, params });
          if (parsed.method === "talk.session.close" && typeof params.sessionId === "string") {
            closeRequests.push(params.sessionId);
          }
          if (
            parsed.method === "talk.session.appendAudio" &&
            typeof params.sessionId === "string"
          ) {
            appendRequests.push(params.sessionId);
          }
        }
        upstream.send(text);
      });
      upstream.onMessage((frame) => {
        const text = frameText(frame);
        const parsed = parseRecord(text);
        if (parsed?.type === "event" && parsed.event === "talk.event") {
          const payload =
            parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
              ? (parsed.payload as JsonRecord)
              : undefined;
          if (
            payload?.type === "audio" &&
            typeof payload.relaySessionId === "string"
          ) {
            audioEvents.push(payload.relaySessionId);
          }
        }
        if (parsed?.type === "res" && typeof parsed.id === "string") {
          const request = requests.get(parsed.id);
          if (request?.method === "talk.session.create" && parsed.ok === true) {
            const payload =
              parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
                ? (parsed.payload as JsonRecord)
                : {};
            const sessionId =
              typeof payload.sessionId === "string" ? payload.sessionId : undefined;
            assert(sessionId, "real talk.session.create response omitted sessionId");
            assert.equal(payload.relaySessionId, sessionId);
            assert.equal(payload.transport, "gateway-relay");
            const audio = payload.audio;
            assert(audio && typeof audio === "object" && !Array.isArray(audio));
            const audioContract = audio as JsonRecord;
            assert.equal(audioContract.inputEncoding, "pcm16");
            assert.equal(audioContract.outputEncoding, "pcm16");
            if (!staleSessionId) {
              staleSessionId = sessionId;
              staleCreateRequestId = parsed.id;
              heldFirstCreateResponse = text;
              return;
            }
            if (!currentSessionId) {
              currentSessionId = sessionId;
              currentCreateRequestId = parsed.id;
            }
          }
          if (request?.method === "talk.session.close") {
            const sessionId = request.params.sessionId;
            if (typeof sessionId === "string") {
              closeAcks.set(sessionId, parsed.ok === true);
            }
          }
          if (request?.method === "talk.session.appendAudio") {
            const sessionId = request.params.sessionId;
            if (typeof sessionId === "string") {
              appendAcks.set(sessionId, parsed.ok === true);
            }
          }
        }
        route.send(text);
      });
    });

    const response = await page.goto(
      `${controlUiServer.baseUrl}chat#token=${encodeURIComponent(token)}`,
    );
    assert.equal(response?.status(), 200);
    await page.locator("openclaw-app-shell").waitFor();
    const readFixture = () =>
      page.evaluate(() => {
        const state = Reflect.get(window, "openclawTalkRealGatewayProof") as
          | {
              constraints?: unknown[];
              initError?: string | null;
              inputProcessor?: unknown;
            }
          | undefined;
        return {
          exists: Boolean(state),
          constraintCount: state?.constraints?.length ?? -1,
          hasInputProcessor: Boolean(state?.inputProcessor),
          initError: state?.initError ?? null,
        };
      });
    try {
      await waitFor(async () => (await readFixture()).exists, "browser fixture initialization");
      assert.deepEqual(await readFixture(), {
        exists: true,
        constraintCount: 0,
        hasInputProcessor: false,
        initError: null,
      });
    } catch (error) {
      const fixture = await readFixture();
      throw new Error(
        `browser fixture initialization failed: ${JSON.stringify({ fixture, pageErrors, browserConsoleErrors })}`,
        { cause: error },
      );
    }
    const startButton = page.getByRole("button", { name: "Start voice input" });
    await startButton.waitFor();
    await startButton.click();

    await waitFor(() => Boolean(staleSessionId && heldFirstCreateResponse), "held stale create");
    trace.push("create(stale):held");
    await waitFor(
      () => providerConnections[0]?.receivedTypes.includes("session.update") === true,
      "stale provider session.update",
    );

    const stopButton = page.getByRole("button", { name: "Stop voice input" });
    await stopButton.click();
    await startButton.click();

    await waitFor(() => Boolean(currentSessionId), "current create response");
    assert.notEqual(staleSessionId, currentSessionId);
    assert.notEqual(staleCreateRequestId, currentCreateRequestId);
    trace.push("create(current):forwarded");
    try {
      await waitFor(
        async () =>
          await page.evaluate(() => {
            const state = Reflect.get(window, "openclawTalkRealGatewayProof") as
              | { constraints?: unknown[]; inputProcessor?: unknown }
              | undefined;
            return (
              (state?.constraints?.length ?? 0) >= 1 && Boolean(state?.inputProcessor)
            );
          }),
        "current microphone setup",
      );
    } catch (error) {
      const fixture = await page.evaluate(() => {
          const state = Reflect.get(window, "openclawTalkRealGatewayProof") as
            | { constraints?: unknown[]; inputProcessor?: unknown }
            | undefined;
          return {
            exists: Boolean(state),
            constraintCount: state?.constraints?.length ?? -1,
            hasInputProcessor: Boolean(state?.inputProcessor),
          };
        });
      const voiceStates = await page.locator(".agent-chat__voice-activity").evaluateAll((nodes) =>
        nodes.map((node) => ({
          status: node.getAttribute("data-status"),
          text: node.textContent?.trim() ?? "",
        })),
      );
      throw new Error(
        `current microphone setup failed: ${JSON.stringify({ fixture, voiceStates, pageErrors, browserConsoleErrors })}`,
        { cause: error },
      );
    }
    const currentFixture = await page.evaluate(() => {
      const state = Reflect.get(window, "openclawTalkRealGatewayProof") as
        | { constraints?: unknown[]; inputProcessor?: unknown }
        | undefined;
      return {
        constraintCount: state?.constraints?.length ?? -1,
        hasInputProcessor: Boolean(state?.inputProcessor),
      };
    });
    assert.deepEqual(currentFixture, { constraintCount: 1, hasInputProcessor: true });
    await waitFor(
      () => providerConnections[1]?.receivedTypes.includes("session.update") === true,
      "current provider session.update",
    );
    providerConnections[1]?.socket.send(JSON.stringify({ type: "session.updated" }));
    await page.locator('.agent-chat__voice-activity[data-status="listening"]').waitFor();

    assert(gatewayRoute && heldFirstCreateResponse, "Gateway route did not retain stale response");
    gatewayRoute.send(heldFirstCreateResponse);
    await waitFor(
      () => closeRequests.filter((sessionId) => sessionId === staleSessionId).length === 1,
      "one stale close request",
    );
    await waitFor(() => closeAcks.get(staleSessionId ?? "") === true, "stale close ack");
    await waitFor(() => providerConnections[0]?.closed === true, "stale provider close");
    assert.equal(providerConnections[1]?.closed, false);
    assert.equal(
      await page.locator('.agent-chat__voice-activity[data-status="listening"]').count(),
      1,
    );
    trace.push("close(stale):rpc=1 ack=ok provider=closed");

    await triggerMicrophoneFrame(page);
    await waitFor(
      () => appendRequests.filter((sessionId) => sessionId === currentSessionId).length >= 1,
      "current append request",
    );
    await waitFor(() => appendAcks.get(currentSessionId ?? "") === true, "current append ack");
    await waitFor(
      () => providerConnections[1]?.receivedTypes.includes("input_audio_buffer.append") === true,
      "provider audio append",
    );
    await waitFor(
      () => audioEvents.filter((sessionId) => sessionId === currentSessionId).length >= 1,
      "provider audio relayed to Control UI",
    );
    await waitFor(
      async () =>
        (await page.evaluate(() => {
          const state = Reflect.get(window, "openclawTalkRealGatewayProof") as
            | { outputStarts?: number }
            | undefined;
          return state?.outputStarts ?? 0;
        })) >= 1,
      "Control UI audio playback",
    );
    const currentAppendCount = appendRequests.filter(
      (sessionId) => sessionId === currentSessionId,
    ).length;
    const currentAudioEventCount = audioEvents.filter(
      (sessionId) => sessionId === currentSessionId,
    ).length;
    const currentProviderInputCount = providerConnections[1]?.receivedTypes.filter(
      (type) => type === "input_audio_buffer.append",
    ).length;
    const currentPlaybackCount = await page.evaluate(() => {
      const state = Reflect.get(window, "openclawTalkRealGatewayProof") as
        | { outputStarts?: number }
        | undefined;
      return state?.outputStarts ?? 0;
    });
    assert.equal(currentAppendCount, 1);
    assert.equal(currentAudioEventCount, 1);
    assert.equal(currentProviderInputCount, 1);
    assert.equal(currentPlaybackCount, 1);
    assert.equal(providerConnections[1]?.closed, false);
    assert.equal(
      appendRequests.filter((sessionId) => sessionId === staleSessionId).length,
      0,
    );
    trace.push("append(current):rpc=1 ack=ok provider_input=1");
    trace.push("audio(current):gateway_event=1 browser_playback=1 socket=open");
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "current-relay-active.png"),
      fullPage: true,
    });

    await stopButton.click();
    await waitFor(
      () => closeRequests.filter((sessionId) => sessionId === currentSessionId).length === 1,
      "one current close request",
    );
    await waitFor(() => closeAcks.get(currentSessionId ?? "") === true, "current close ack");
    await waitFor(() => providerConnections[1]?.closed === true, "current provider close");
    trace.push("close(current):rpc=1 ack=ok provider=closed");

    assert.equal(providerConnections[0]?.closeCount, 1);
    assert.equal(providerConnections[1]?.closeCount, 1);
    assert.equal(closeRequests.length, 2);
    assert.deepEqual(closeRequests, [staleSessionId, currentSessionId]);
    assert.deepEqual(trace, [
      "create(stale):held",
      "create(current):forwarded",
      "close(stale):rpc=1 ack=ok provider=closed",
      "append(current):rpc=1 ack=ok provider_input=1",
      "audio(current):gateway_event=1 browser_playback=1 socket=open",
      "close(current):rpc=1 ack=ok provider=closed",
    ]);
    console.info(
      `[talk-real-gateway] pr_head=${PR_HEAD_SHA.slice(0, 12)} ui=chromium gateway=real relay=real provider_endpoint=loopback-openai-protocol-fixture`,
    );
    for (const event of trace) {
      console.info(`[talk-real-gateway][trace] ${event}`);
    }
    console.info(
      `[talk-real-gateway] counts stale_close=1 current_append=${String(currentAppendCount)} provider_input=${String(currentProviderInputCount)} current_audio_event=${String(currentAudioEventCount)} browser_playback=${String(currentPlaybackCount)} current_close=1`,
    );
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await gateway?.close({ reason: "Talk real Gateway proof complete" }).catch(() => undefined);
    for (const socket of providerServer?.clients ?? []) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      if (!providerServer) {
        resolve();
        return;
      }
      providerServer.close(() => resolve());
    });
    await controlUiServer?.close().catch(() => undefined);
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    envSnapshot.restore();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

await main();
