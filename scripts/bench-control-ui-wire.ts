import { spawn, execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { channel } from "node:diagnostics_channel";
// Real-Gateway wire benchmark. Run with node --import ./scripts/tsx.mjs.
// Example: --bundle-dir dist/control-ui --pairs 10 --profile remote --output /absolute/proof
// --compare-source-dir interleaves the frozen source and this checkout; same source is A/A.
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  rename,
  symlink,
  unlink,
  lstat,
  copyFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inflateRawSync, constants as zlibConstants } from "node:zlib";
import { chromium, type Page, type Response } from "playwright";
import {
  gatewayCredentialScope,
  gatewayOriginScope,
} from "../packages/gateway-client/src/gateway-origin-scope.ts";
import type { TranscriptEvent } from "../src/config/sessions/session-accessor.sqlite-contract.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { CONTROL_UI_TOKEN_SESSION_KEY_PREFIX } from "../src/shared/control-ui-storage.ts";
import { getControlUiContextHandle } from "../ui/src/test-helpers/control-ui-e2e-context.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/playwright-chromium.ts";
import { launchTalkObservationBrowser } from "./lib/control-ui-talk-fixture.ts";
import { createControlUiWireLink } from "./lib/control-ui-wire-link.ts";
import { stopChild } from "./lib/gateway-bench-child.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string" },
    "compare-bundle-dir": { type: "string" },
    "compare-source-dir": { type: "string" },
    output: { type: "string" },
    pairs: { type: "string", default: "1" },
    profile: { type: "string", default: "local" },
    auth: { type: "string", default: "none" },
    port: { type: "string" },
    worker: { type: "boolean", default: false },
    "controlled-worker": { type: "boolean", default: false },
    screenshots: { type: "boolean", default: false },
    "extended-flows": { type: "boolean", default: false },
    "reconnect-trigger": { type: "string", default: "silent" },
    timeline: { type: "boolean", default: false },
    "proxy-nagle": { type: "boolean", default: false },
  },
});
if (
  !values["bundle-dir"] ||
  !values.output ||
  !["local", "remote", "mobile"].includes(values.profile) ||
  !["none", "token"].includes(values.auth) ||
  !["silent", "online", "visible"].includes(values["reconnect-trigger"])
) {
  throw new Error(
    "Required: --bundle-dir <built UI> --output <directory> [--profile local|remote|mobile] [--auth none|token] [--pairs N] [--extended-flows] [--reconnect-trigger silent|online|visible] [--compare-source-dir <checkout>] [--compare-bundle-dir <base UI>]",
  );
}
if (values["compare-bundle-dir"] && !values["compare-source-dir"]) {
  throw new Error("--compare-bundle-dir requires --compare-source-dir (use . for the same source)");
}
if (values["controlled-worker"] && !values.worker) {
  throw new Error("--controlled-worker requires --worker");
}
const output = path.resolve(values.output);
const pairs = Number(values.pairs);
if (!Number.isInteger(pairs) || pairs < 1) {
  throw new Error("--pairs must be a positive integer");
}
await mkdir(output, { recursive: true });
let outputInsideRepository = false;
try {
  execFileSync("git", ["-C", output, "rev-parse", "--show-toplevel"], { stdio: "ignore" });
  outputInsideRepository = true;
} catch {
  /* A proof root must be outside repository discovery. */
}
if (outputInsideRepository) {
  throw new Error(
    "--output must be outside every Git repository so synthetic workspace discovery stays synthetic",
  );
}
const bundle = path.resolve(values["bundle-dir"]);
const remote = values.profile !== "local";
const networkProfile =
  values.profile === "local"
    ? { roundTripMs: 0, megabitsPerSecond: null, latencyMs: 0 }
    : values.profile === "mobile"
      ? { roundTripMs: 250, megabitsPerSecond: 3, latencyMs: 125 }
      : { roundTripMs: 100, megabitsPerSecond: 10, latencyMs: 50 };
const SYNTHETIC_GATEWAY_TOKEN = "synthetic-wire-benchmark-gateway-token";
const sessionKeys = ["agent:main:wire-fixture-a", "agent:main:wire-fixture-b"];
const workerMessagePrefix = "OPENCLAW_WIRE_WORKER ";
type WireFrame = {
  direction: "sent" | "received";
  connection: number;
  atMs: number;
  deliveredAtMs: number;
  opcode: number;
  compressed: boolean;
  payloadBytes: number;
  wireBytes: number;
  decodedBytes?: number;
  name?: string;
  requestId?: string;
  type?: string;
  ok?: boolean;
  digest?: string;
  streamStart: number;
  streamEnd: number;
};

// Observe RFC6455 bytes before forwarding. CDP exposes decompressed messages, so its
// payload length cannot establish whether permessage-deflate saves wire bytes.
function frameReader(
  direction: WireFrame["direction"],
  connection: number,
  frames: WireFrame[],
  methods: Map<string, string>,
  requests: Map<number, { method: string; pathname: string }>,
) {
  let pending = Buffer.alloc(0);
  let headers = true;
  let upgraded = false;
  let message: WireFrame | undefined;
  let parts: Buffer[] = [];
  let consumed = 0;
  return (chunk: Buffer, deliveredAtMs: number, receivedAtMs = performance.now()) => {
    pending = Buffer.concat([pending, chunk]);
    if (headers) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      const header = pending.subarray(0, end).toString("latin1");
      if (direction === "sent") {
        const [method, target] = header.split("\r\n", 1)[0]!.split(" ");
        if (method && target) {
          // Path only: authentication headers and query values never enter evidence.
          requests.set(connection, {
            method,
            pathname: new URL(target, "http://localhost").pathname,
          });
        }
      }
      upgraded = /upgrade:\s*websocket/iu.test(header);
      headers = false;
      if (!upgraded) {
        // Browser HTTP traffic here is GET-only; keep observing reused connections.
        headers = direction === "sent" && header.startsWith("GET ");
        pending = Buffer.alloc(0);
        return;
      }
      pending = pending.subarray(end + 4);
      consumed += end + 4;
    }
    if (!upgraded) {
      pending = Buffer.alloc(0);
      return;
    }
    while (pending.length >= 2) {
      const first = pending[0]!;
      const second = pending[1]!;
      let length = second & 127;
      let headerBytes = 2;
      if (length === 126) {
        if (pending.length < 4) {
          return;
        }
        length = pending.readUInt16BE(2);
        headerBytes = 4;
      } else if (length === 127) {
        if (pending.length < 10) {
          return;
        }
        length = Number(pending.readBigUInt64BE(2));
        headerBytes = 10;
      }
      if (second & 128) {
        headerBytes += 4;
      }
      if (pending.length < headerBytes + length) {
        return;
      }
      const opcode = first & 15;
      if (opcode !== 0) {
        parts = [];
        message = {
          direction,
          connection,
          atMs: receivedAtMs,
          deliveredAtMs,
          opcode,
          compressed: Boolean(first & 64),
          payloadBytes: 0,
          wireBytes: 0,
          streamStart: consumed,
          streamEnd: consumed,
        };
      }
      if (message) {
        const body = Buffer.from(pending.subarray(headerBytes, headerBytes + length));
        if (second & 128) {
          const mask = pending.subarray(headerBytes - 4, headerBytes);
          for (let i = 0; i < body.length; i++) {
            body[i] = body[i]! ^ mask[i % 4]!;
          }
        }
        parts.push(body);
        message.payloadBytes += length;
        message.wireBytes += headerBytes + length;
        message.streamEnd = consumed + headerBytes + length;
        message.deliveredAtMs = deliveredAtMs;
        if (first & 128) {
          if (message.opcode === 1 || message.opcode === 2) {
            let payload = Buffer.concat(parts);
            if (message.compressed) {
              payload = inflateRawSync(Buffer.concat([payload, Buffer.from([0, 0, 255, 255])]), {
                finishFlush: zlibConstants.Z_SYNC_FLUSH,
              });
            }
            const value = JSON.parse(payload.toString("utf8")) as {
              id?: string;
              method?: string;
              type?: string;
              event?: string;
              ok?: boolean;
            };
            if (value.id && value.method) {
              methods.set(value.id, value.method);
            }
            message.name =
              value.method ??
              value.event ??
              (value.id ? methods.get(value.id) : undefined) ??
              value.type;
            message.requestId = value.id;
            message.type = value.type;
            message.ok = value.ok;
            message.decodedBytes = payload.length;
            message.digest = createHash("sha256").update(payload).digest("hex");
          }
          frames.push(message);
          message = undefined;
        }
      }
      pending = pending.subarray(headerBytes + length);
      consumed += headerBytes + length;
    }
  };
}

async function startProxy(upstreamPort: number, listenPort: number) {
  const frames: WireFrame[] = [];
  const packets: Array<{
    direction: WireFrame["direction"];
    connection: number;
    streamStart: number;
    streamEnd: number;
    receivedAtMs: number;
    serialStartMs: number;
    scheduledWriteMs: number;
    actualWriteMs?: number;
    request?: { method: string; pathname: string };
  }> = [];
  const sockets = new Set<Socket>();
  const linkOptions = {
    latencyMs: networkProfile.latencyMs,
    megabitsPerSecond: networkProfile.megabitsPerSecond ?? 10,
  };
  const links = {
    sent: createControlUiWireLink(linkOptions),
    received: createControlUiWireLink(linkOptions),
  };
  let offline = false;
  let connection = 0;
  const methods = new Map<string, string>();
  const requests = new Map<number, { method: string; pathname: string }>();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (offline) {
      client.destroy();
      return;
    }
    const upstream = connect({ port: upstreamPort, host: "127.0.0.1", allowHalfOpen: true });
    // The profile supplies latency/bandwidth; loopback delayed ACKs must not add
    // a second, platform-dependent queue to interactive WebSocket traffic.
    client.setNoDelay(!values["proxy-nagle"]);
    upstream.setNoDelay(!values["proxy-nagle"]);
    sockets.add(client);
    sockets.add(upstream);
    client.on("close", () => sockets.delete(client));
    upstream.on("close", () => sockets.delete(upstream));
    const id = ++connection;
    for (const [source, target, direction] of [
      [client, upstream, "sent"],
      [upstream, client, "received"],
    ] as const) {
      const inspect = frameReader(direction, id, frames, methods, requests);
      if (remote) {
        let offset = 0;
        const pendingPackets = new WeakMap<Buffer, (typeof packets)[number]>();
        links[direction].connect(
          source,
          target,
          (chunk, deliveredAtMs, receivedAtMs) => {
            inspect(chunk, deliveredAtMs, receivedAtMs);
            const packet = {
              direction,
              connection: id,
              streamStart: offset,
              streamEnd: offset + chunk.length,
              receivedAtMs,
              serialStartMs:
                deliveredAtMs -
                networkProfile.latencyMs -
                (chunk.length * 8) / (networkProfile.megabitsPerSecond! * 1000),
              scheduledWriteMs: deliveredAtMs,
              request: requests.get(id),
            };
            offset += chunk.length;
            packets.push(packet);
            pendingPackets.set(chunk, packet);
          },
          (chunk, atMs) => {
            const packet = pendingPackets.get(chunk);
            if (packet) {
              packet.actualWriteMs = atMs;
            }
          },
        );
      } else {
        source.on("data", (chunk: Buffer) => inspect(chunk, performance.now()));
        source.pipe(target);
        source.on("error", () => target.destroy());
        source.on("close", () => {
          if (!source.readableEnded) {
            target.destroy();
          }
        });
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Proxy has no TCP address");
  }
  return {
    frames,
    packets,
    url: `http://127.0.0.1:${address.port}`,
    setOffline(value: boolean) {
      offline = value;
      if (offline) {
        for (const socket of sockets) {
          socket.destroy();
        }
      }
    },
    async close() {
      links.sent.close();
      links.received.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

type ReadinessKind = "chat" | "new-session" | "board" | "usage" | "settings" | "reconnect";

async function observeReconnect(page: Page) {
  await page.evaluate("globalThis.__name = (fn) => fn");
  const context = await getControlUiContextHandle(page);
  try {
    return await context.evaluateHandle(({ gateway }) => {
      type EventName =
        | "snapshot"
        | "outage-start"
        | "before-restore"
        | "link-restored"
        | "offline"
        | "online"
        | "visibilitychange";
      const entries: Array<{
        event: EventName;
        browserAtMs: number;
        epochMs: number;
        phase: string;
        reconnectAt: number | null;
        reconnectInMs: number | null;
        errorCode: string | null;
        online: boolean;
        visibility: DocumentVisibilityState;
        isTrusted?: boolean;
      }> = [];
      let droppedEvents = 0;
      const record = (event: EventName, isTrusted?: boolean) => {
        const { phase, reconnectAt, lastErrorCode } = gateway.snapshot;
        const epochMs = Date.now();
        if (entries.length >= 128) {
          droppedEvents++;
          return;
        }
        entries.push({
          event,
          browserAtMs: performance.now(),
          epochMs,
          phase,
          reconnectAt: reconnectAt ?? null,
          reconnectInMs: reconnectAt === undefined ? null : reconnectAt - epochMs,
          errorCode: lastErrorCode,
          online: navigator.onLine,
          visibility: document.visibilityState,
          isTrusted,
        });
      };
      let previous = gateway.snapshot;
      record("snapshot");
      const unsubscribe = gateway.subscribe((snapshot) => {
        if (
          snapshot.phase !== previous.phase ||
          snapshot.reconnectAt !== previous.reconnectAt ||
          snapshot.lastErrorCode !== previous.lastErrorCode
        ) {
          record("snapshot");
        }
        previous = snapshot;
      });
      const onOnline = (event: Event) => record("online", event.isTrusted);
      const onOffline = (event: Event) => record("offline", event.isTrusted);
      const onVisibility = (event: Event) => record("visibilitychange", event.isTrusted);
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
      document.addEventListener("visibilitychange", onVisibility);
      return {
        mark: (event: "outage-start" | "before-restore" | "link-restored") => record(event),
        read: (startMs: number) => ({
          droppedEvents,
          events: entries.map((entry) => ({
            event: entry.event,
            browserAtMs: entry.browserAtMs - startMs,
            epochMs: entry.epochMs,
            phase: entry.phase,
            reconnectAt: entry.reconnectAt,
            reconnectInMs: entry.reconnectInMs,
            errorCode: entry.errorCode,
            online: entry.online,
            visibility: entry.visibility,
            isTrusted: entry.isTrusted,
          })),
        }),
        dispose() {
          unsubscribe();
          window.removeEventListener("online", onOnline);
          window.removeEventListener("offline", onOffline);
          document.removeEventListener("visibilitychange", onVisibility);
        },
      };
    });
  } finally {
    await context.dispose();
  }
}

function installReadiness() {
  type Readiness = {
    startMs: number;
    transcriptMs: number | null;
    transcriptVisibleMs: number | null;
    composerMs: number | null;
    newSessionMs: number | null;
    pageMs: number | null;
  };
  const state: Readiness = {
    startMs: 0,
    transcriptMs: null,
    transcriptVisibleMs: null,
    composerMs: null,
    newSessionMs: null,
    pageMs: null,
  };
  const visible = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    return element?.checkVisibility() ? element : null;
  };
  let expectedKey: string | undefined = "agent:main:wire-fixture-a";
  let kind: ReadinessKind = "chat";
  const sample = () => {
    const snapshot =
      kind === "chat" || kind === "new-session" ? undefined : window.openclawControlUi?.snapshot();
    const recovered =
      kind !== "reconnect" || (snapshot?.gatewayPhase === "connected" && snapshot.rosterReady);
    const pane = visible(".chat-pane-cache__pane--active");
    const correctPane = pane && (!expectedKey || Reflect.get(pane, "sessionKey") === expectedKey);
    const transcript = correctPane && visible(".chat-pane-cache__pane--active .chat-virtual-row");
    if (transcript && transcript.textContent?.trim()) {
      state.transcriptVisibleMs ??= performance.now() - state.startMs;
    }
    if (recovered && correctPane && Reflect.get(pane, "transcriptReady") === true && transcript) {
      state.transcriptMs ??= performance.now() - state.startMs;
    }
    const composer =
      recovered &&
      correctPane &&
      visible(".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea");
    const model = Array.from(
      document.querySelectorAll<HTMLElement>("[data-chat-model-select]"),
    ).find((element) => element.checkVisibility());
    const modelReady = Boolean(model?.textContent?.includes("Synthetic fixture model"));
    if (composer && modelReady && !composer.matches(":disabled, [aria-disabled='true']")) {
      state.composerMs ??= performance.now() - state.startMs;
    }
    const newSession = visible(".new-session-page__message");
    if (newSession && modelReady && !newSession.matches(":disabled, [aria-disabled='true']")) {
      state.newSessionMs ??= performance.now() - state.startMs;
    }
    const route = kind === "board" ? "dashboard" : kind === "settings" ? "appearance" : kind;
    if (
      snapshot?.routeReady &&
      snapshot.route?.status === "success" &&
      snapshot.route.matches[0]?.routeId === route
    ) {
      const control =
        kind === "board"
          ? visible('.board-session-surface .board-view[aria-busy="false"] .board-empty')
          : kind === "usage"
            ? visible('openclaw-usage-page button[aria-label="Refresh"]:not(:disabled)')
            : kind === "settings"
              ? visible(".settings-theme-grid [data-theme-id]:not(:disabled)")
              : null;
      if (control) {
        state.pageMs ??= performance.now() - state.startMs;
      }
    }
    requestAnimationFrame(sample);
  };
  Reflect.set(window, "__wireReadiness", {
    state,
    reset(key?: string, nextKind: ReadinessKind = "chat") {
      expectedKey = key;
      kind = nextKind;
      state.startMs = performance.now();
      state.transcriptMs = null;
      state.transcriptVisibleMs = null;
      state.composerMs = null;
      state.newSessionMs = null;
      state.pageMs = null;
    },
  });
  requestAnimationFrame(sample);
}

async function runWorker() {
  console.log("Preparing isolated Gateway fixture");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  const stateRoot = path.join(output, "synthetic-state");
  await mkdir(stateRoot);
  for (const name of ["home", "workspace", "tmp"]) {
    await mkdir(path.join(stateRoot, name));
  }
  // Bind before runtime imports: resolvers must never discover the operator's state.
  process.env.OPENCLAW_STATE_DIR = stateRoot;
  process.env.OPENCLAW_HOME = path.join(stateRoot, "home");
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateRoot, "openclaw.json");
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_NO_RESPAWN = "1";
  process.env.NODE_DISABLE_COMPILE_CACHE = "1";
  process.env.TSX_TSCONFIG_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../tsconfig.json",
  );
  // Provider credentials and caller customization cannot affect this fixture.
  const inheritedPath = process.env.PATH;
  const inheritedBrowser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const inheritedBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      [
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_HOME",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_SKIP_CHANNELS",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_NO_RESPAWN",
        "PATH",
        "NODE_DISABLE_COMPILE_CACHE",
        "TSX_TSCONFIG_PATH",
        "SYSTEMROOT",
        "LANG",
        "TMPDIR",
        "XDG_CACHE_HOME",
      ].includes(name),
    ),
  );
  process.env.PATH = inheritedPath;
  if (inheritedBrowser) {
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = inheritedBrowser;
  }
  if (inheritedBrowsers) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = inheritedBrowsers;
  }
  process.env.HOME = path.join(stateRoot, "home");
  const { getFreePort } = await import("./lib/gateway-bench-probes.ts");
  const proxyPort = Number(values.port ?? (await getFreePort()));
  const config: OpenClawConfig = {
    browser: { enabled: false },
    update: { checkOnStart: false },
    discovery: { mdns: { mode: "off" } },
    gateway: {
      mode: "local",
      bind: "loopback",
      trustedProxies: ["127.0.0.1"],
      auth:
        values.auth === "token"
          ? { mode: "token", token: SYNTHETIC_GATEWAY_TOKEN }
          : { mode: "none" },
      tailscale: { mode: "off" },
      controlUi: { enabled: true, allowedOrigins: [`http://127.0.0.1:${proxyPort}`] },
    },
    agents: {
      entries: {
        main: {
          workspace: path.join(stateRoot, "workspace"),
          model: { primary: "openai/synthetic-wire-model" },
        },
      },
    },
    models: {
      mode: "replace",
      providers: {
        openai: {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "synthetic-unused-fixture-key",
          api: "openai-completions",
          models: [
            {
              id: "synthetic-wire-model",
              name: "Synthetic fixture model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    plugins: { enabled: false },
    logging: { file: path.join(output, "gateway.log") },
  };
  await writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
  const [
    { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync },
    { writeSessionEntry },
    { appendTranscriptEventsInTransaction },
  ] = await Promise.all([
    import("../src/state/openclaw-agent-db.js"),
    import("../src/config/sessions/session-accessor.sqlite-entry-store.js"),
    import("../src/config/sessions/session-accessor.sqlite-transcript-store.js"),
  ]);
  const fixtureNow = Date.now();
  // Exclusive offline seed uses the existing atomic owners; Gateway opens only after close.
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (const [index, sessionKey] of sessionKeys.entries()) {
        const sessionId = `synthetic-wire-${index}`;
        writeSessionEntry(database, sessionKey, {
          sessionId,
          updatedAt: fixtureNow,
          label: `Wire benchmark ${index + 1}`,
        });
        const events: TranscriptEvent[] = [
          {
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: new Date(fixtureNow).toISOString(),
          },
        ];
        for (let row = 0; row < 120; row++) {
          events.push({
            type: "message",
            id: `${sessionId}-${row}`,
            parentId: row ? `${sessionId}-${row - 1}` : null,
            timestamp: new Date(fixtureNow + row).toISOString(),
            message: {
              role: row % 2 ? "assistant" : "user",
              timestamp: fixtureNow + row,
              ...(row % 2
                ? {
                    openclawResponsesInputReplay: {
                      afterResponseId: `synthetic-response-${row}`,
                      before: Array.from({ length: 8 }, (_, fingerprintIndex) =>
                        createHash("sha256")
                          .update(`synthetic-input-${row}-${fingerprintIndex}`)
                          .digest("hex"),
                      ),
                      after: [],
                    },
                  }
                : {}),
              content: [
                {
                  type: "text",
                  text: `Synthetic session ${index + 1}, message ${row + 1}. ${"A reproducible transcript measures the real Gateway path and browser readiness. ".repeat(row % 2 ? 20 : 3)}`,
                },
              ],
            },
          });
        }
        appendTranscriptEventsInTransaction(
          database,
          { agentId: "main", sessionKey, sessionId },
          events,
        );
      }
    },
    { agentId: "main" },
  );
  await closeOpenClawAgentDatabasesAsync();
  const [{ startGatewayServer }, { controlUiSessionPath, controlUiSessionUrl }] = await Promise.all(
    [
      import("../src/gateway/server.js"),
      import("../ui/src/test-helpers/control-ui-e2e-session-urls.ts"),
    ],
  );
  const { ensureCanonicalGatewayOwnerProfile, setCanonicalUserProfileAvatar } =
    await import("../src/state/user-profile-writes.js");
  const owner = await ensureCanonicalGatewayOwnerProfile("Synthetic benchmark operator", {
    env: process.env,
  });
  // An explicit fixture avatar prevents the platform account-photo fallback.
  await setCanonicalUserProfileAvatar(
    owner.id,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/CfcAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
    { env: process.env },
  );
  const gatewayPort = await getFreePort();
  const gatewayTimeline: Array<Record<string, unknown> & { atMs: number }> = [];
  const rpcChannel = channel("openclaw.gateway.rpc");
  const stageChannel = channel("openclaw.gateway.request.stages");
  const observeGateway = (event: unknown) => {
    gatewayTimeline.push({ ...(event as Record<string, unknown>), atMs: performance.now() });
  };
  rpcChannel.subscribe(observeGateway);
  stageChannel.subscribe(observeGateway);
  process.chdir(path.join(stateRoot, "workspace"));
  const gateway = await startGatewayServer(gatewayPort, {
    bind: "loopback",
    sidecarStartup: "defer",
  });
  try {
    await gateway.startupSettled;
    const readyDeadline = performance.now() + 60_000;
    while ((await fetch(`http://127.0.0.1:${gatewayPort}/readyz`)).status !== 200) {
      if (performance.now() > readyDeadline) {
        throw new Error("Gateway did not become ready");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    console.log("Gateway ready");
    const proxy = await startProxy(gatewayPort, proxyPort);
    try {
      const gatewayUrl = new URL(proxy.url);
      gatewayUrl.protocol = "ws:";
      const tokenStorageKey = `${CONTROL_UI_TOKEN_SESSION_KEY_PREFIX}${gatewayOriginScope(gatewayUrl.href)}`;
      const bootRecordStorageKey =
        values.auth === "token"
          ? `openclaw.control.bootRecord.v1:${gatewayCredentialScope(gatewayUrl.href)}`
          : undefined;
      // A deterministic, task-only browser key proves the real pairing/signature path.
      const seed = createHash("sha256").update("openclaw-wire-benchmark-synthetic-device").digest();
      const privateKey = createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
        format: "der",
        type: "pkcs8",
      });
      const publicKey = createPublicKey(privateKey)
        .export({ format: "der", type: "spki" })
        .subarray(-32);
      const identity = {
        version: 1,
        deviceId: createHash("sha256").update(publicKey).digest("hex"),
        publicKey: publicKey.toString("base64url"),
        privateKey: seed.toString("base64url"),
        createdAtMs: fixtureNow,
      };
      const [{ requestDevicePairing }, { approveDevicePairing }] = await Promise.all([
        import("../src/infra/device-pairing.js"),
        import("../src/infra/device-pairing-approval.js"),
      ]);
      const scopes = [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.questions",
        "operator.pairing",
      ];
      const pairing = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        role: "operator",
        scopes,
      });
      const approval = await approveDevicePairing(pairing.request.requestId, {
        callerScopes: scopes,
      });
      if (approval?.status !== "approved") {
        throw new Error("Synthetic browser pairing was not approved");
      }
      const browser =
        values["reconnect-trigger"] === "visible"
          ? undefined
          : await chromium.launch({
              executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
              headless: true,
            });
      const commands = values["controlled-worker"]
        ? createInterface({ input: process.stdin, crlfDelay: Infinity })
        : undefined;
      const commandIterator = commands?.[Symbol.asyncIterator]();
      try {
        if (commandIterator) {
          console.log(`${workerMessagePrefix}${JSON.stringify({ type: "ready" })}`);
        }
        for (let pair = 0; pair < pairs; pair++) {
          if (commandIterator) {
            const next = await commandIterator.next();
            if (next.done) {
              break;
            }
            const command: unknown = JSON.parse(next.value);
            if (
              !command ||
              typeof command !== "object" ||
              !("type" in command) ||
              command.type !== "sample" ||
              !("sample" in command) ||
              command.sample !== pair + 1
            ) {
              throw new Error(`Expected sample command ${pair + 1}`);
            }
          }
          // A closed context has no remaining sample to attribute these frames to.
          proxy.frames.length = 0;
          proxy.packets.length = 0;
          gatewayTimeline.length = 0;
          const sampleOutput = path.join(output, String(pair + 1).padStart(2, "0"));
          await mkdir(sampleOutput, { recursive: true });
          // Native visibility requires a default context without Playwright's focus override.
          const observation = browser
            ? undefined
            : await launchTalkObservationBrowser(sampleOutput, false);
          const context = browser
            ? await browser.newContext({
                viewport: { width: 1440, height: 1000 },
                ...(remote ? { extraHTTPHeaders: { "x-forwarded-for": "198.51.100.10" } } : {}),
              })
            : observation!.context;
          if (observation && remote) {
            await context.setExtraHTTPHeaders({ "x-forwarded-for": "198.51.100.10" });
          }
          await context.addInitScript(
            ({ deviceIdentity, tokenKey, token }) => {
              localStorage.setItem("openclaw-device-identity-v1", JSON.stringify(deviceIdentity));
              if (token && sessionStorage.getItem(tokenKey) === null) {
                sessionStorage.setItem(tokenKey, token);
              }
            },
            {
              deviceIdentity: identity,
              tokenKey: tokenStorageKey,
              token: values.auth === "token" ? SYNTHETIC_GATEWAY_TOKEN : undefined,
            },
          );
          const page = await context.newPage();
          if (observation) {
            await page.setViewportSize({ width: 1440, height: 1000 });
          }
          await page.addInitScript({
            content: `const __name = (fn) => fn; (${installReadiness.toString()})();`,
          });
          if (values.timeline) {
            await page.addInitScript(() => {
              const parse = JSON.parse;
              const samples: Array<{ startedAtMs: number; durationMs: number; bytes: number }> = [];
              Reflect.set(window, "__wireJsonParses", samples);
              JSON.parse = (text, reviver) => {
                const startedAtMs = performance.now();
                const result = parse(text, reviver);
                const finishedAtMs = performance.now();
                if (typeof text === "string" && text.includes('"initialHistory"')) {
                  samples.push({
                    startedAtMs,
                    durationMs: finishedAtMs - startedAtMs,
                    bytes: new TextEncoder().encode(text).length,
                  });
                  performance.measure("wire.history.parse", {
                    start: startedAtMs,
                    end: finishedAtMs,
                  });
                }
                return result;
              };
            });
          }
          const cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          type HttpRecord = {
            id: string;
            url: string;
            type: string;
            startedAtMs: number;
            browserStartedAtMs: number;
            responseAtMs?: number;
            browserResponseAtMs?: number;
            finishedAtMs?: number;
            browserFinishedAtMs?: number;
            bytes: number;
            status?: number;
            cached?: boolean;
            fromServiceWorker?: boolean;
            failed?: boolean;
            headers?: Record<string, string>;
          };
          type Decoded = {
            direction: WireFrame["direction"];
            atMs: number;
            browserTimestampMs: number;
            bytes: number;
            name: string;
            requestId?: string;
            digest: string;
            shape?: unknown;
          };
          const requests = new Map<string, HttpRecord>();
          const decoded: Decoded[] = [];
          const methods = new Map<string, string>();
          const errors: string[] = [];
          const upgradeRequests = new Map<
            string,
            { startedAtMs: number; browserStartedAtMs: number }
          >();
          const websocketLifecycle: Array<{
            event: "created" | "handshake-request" | "handshake-response" | "error" | "closed";
            requestId: string;
            atMs: number;
            browserAtMs?: number;
            status?: number;
          }> = [];
          cdp.on("Network.webSocketCreated", (event) => {
            websocketLifecycle.push({
              event: "created",
              requestId: event.requestId,
              atMs: performance.now(),
            });
          });
          cdp.on("Network.webSocketFrameError", (event) => {
            websocketLifecycle.push({
              event: "error",
              requestId: event.requestId,
              atMs: performance.now(),
              browserAtMs: event.timestamp * 1000,
            });
          });
          cdp.on("Network.webSocketClosed", (event) => {
            websocketLifecycle.push({
              event: "closed",
              requestId: event.requestId,
              atMs: performance.now(),
              browserAtMs: event.timestamp * 1000,
            });
          });
          const negotiations: Array<{
            requestId: string;
            startedAtMs?: number;
            browserStartedAtMs?: number;
            atMs: number;
            browserResponseAtMs: number;
            status: number;
            extensions: string;
          }> = [];
          cdp.on("Network.webSocketWillSendHandshakeRequest", (event) => {
            websocketLifecycle.push({
              event: "handshake-request",
              requestId: event.requestId,
              atMs: performance.now(),
              browserAtMs: event.timestamp * 1000,
            });
            upgradeRequests.set(event.requestId, {
              startedAtMs: performance.now(),
              browserStartedAtMs: event.timestamp * 1000,
            });
          });
          cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
            websocketLifecycle.push({
              event: "handshake-response",
              requestId: event.requestId,
              atMs: performance.now(),
              browserAtMs: event.timestamp * 1000,
              status: event.response.status,
            });
            negotiations.push({
              requestId: event.requestId,
              ...upgradeRequests.get(event.requestId),
              atMs: performance.now(),
              browserResponseAtMs: event.timestamp * 1000,
              status: event.response.status,
              extensions:
                Object.entries(event.response.headers).find(
                  ([name]) => name.toLowerCase() === "sec-websocket-extensions",
                )?.[1] ?? "none",
            });
          });
          page.on("pageerror", (error) => errors.push(error.message));
          cdp.on("Network.requestWillBeSent", (event) =>
            requests.set(event.requestId, {
              id: event.requestId,
              url: event.request.url,
              type: event.type ?? "Other",
              startedAtMs: performance.now(),
              browserStartedAtMs: event.timestamp * 1000,
              bytes: 0,
            }),
          );
          cdp.on("Network.responseReceived", (event) => {
            const request = requests.get(event.requestId);
            if (request) {
              Object.assign(request, {
                responseAtMs: performance.now(),
                browserResponseAtMs: event.timestamp * 1000,
                status: event.response.status,
                cached: request.cached || event.response.fromDiskCache || false,
                fromServiceWorker: event.response.fromServiceWorker ?? false,
                headers: Object.fromEntries(
                  Object.entries(event.response.headers).filter(([name]) =>
                    [
                      "content-encoding",
                      "content-length",
                      "cache-control",
                      "content-type",
                      "etag",
                    ].includes(name.toLowerCase()),
                  ),
                ),
              });
            }
          });
          cdp.on("Network.requestServedFromCache", (event) => {
            const request = requests.get(event.requestId);
            if (request) {
              request.cached = true;
            }
          });
          cdp.on("Network.loadingFinished", (event) => {
            const request = requests.get(event.requestId);
            if (request) {
              Object.assign(request, {
                finishedAtMs: performance.now(),
                browserFinishedAtMs: event.timestamp * 1000,
                bytes: event.encodedDataLength,
              });
            }
          });
          cdp.on("Network.loadingFailed", (event) => {
            const request = requests.get(event.requestId);
            if (request) {
              request.finishedAtMs = performance.now();
              request.browserFinishedAtMs = event.timestamp * 1000;
              request.failed = true;
            }
          });
          for (const [eventName, direction] of [
            ["Network.webSocketFrameSent", "sent"],
            ["Network.webSocketFrameReceived", "received"],
          ] as const) {
            cdp.on(eventName, (event) => {
              if (![1, 2].includes(event.response.opcode)) {
                return;
              }
              const text = event.response.payloadData;
              let name = "non-json";
              let requestId: string | undefined;
              let shape: unknown;
              try {
                const message = JSON.parse(text) as {
                  id?: string;
                  type?: string;
                  method?: string;
                  event?: string;
                  params?: Record<string, unknown>;
                  payload?: Record<string, unknown>;
                };
                requestId = message.id;
                if (message.method && requestId) {
                  methods.set(requestId, message.method);
                }
                name =
                  message.method ??
                  message.event ??
                  (requestId ? methods.get(requestId) : undefined) ??
                  message.type ??
                  "unknown";
                if (name === "sessions.messages.subscribe" || name === "chat.history") {
                  const payload = message.params ?? message.payload ?? {};
                  shape = {
                    fields: Object.fromEntries(
                      Object.entries(payload).map(([key, value]) => [
                        key,
                        {
                          bytes: Buffer.byteLength(JSON.stringify(value) ?? ""),
                          count: Array.isArray(value) ? value.length : undefined,
                          keys:
                            value && typeof value === "object" && !Array.isArray(value)
                              ? Object.keys(value)
                              : undefined,
                        },
                      ]),
                    ),
                    sessionKey: message.params?.sessionKey ?? message.params?.key,
                    initialHistory: message.params?.initialHistory,
                    includeApprovals: message.params?.includeApprovals,
                    history: (() => {
                      const initial = message.payload?.initialHistory as
                        | { payload?: Record<string, unknown> }
                        | undefined;
                      const history =
                        initial?.payload ?? (name === "chat.history" ? message.payload : undefined);
                      if (!history) {
                        return undefined;
                      }
                      const rows = Array.isArray(history.messages) ? history.messages : [];
                      const messageFields: Record<string, number> = {};
                      for (const row of rows) {
                        if (!row || typeof row !== "object") {
                          continue;
                        }
                        for (const [key, value] of Object.entries(row)) {
                          messageFields[key] =
                            (messageFields[key] ?? 0) +
                            Buffer.byteLength(JSON.stringify(value) ?? "");
                        }
                      }
                      return {
                        kind: history.kind ?? "page",
                        bytes: Buffer.byteLength(JSON.stringify(history)),
                        fields: Object.fromEntries(
                          Object.entries(history).map(([key, value]) => [
                            key,
                            {
                              bytes: Buffer.byteLength(JSON.stringify(value) ?? ""),
                              count: Array.isArray(value) ? value.length : undefined,
                            },
                          ]),
                        ),
                        messageFields,
                        metadataFields:
                          history.metadata && typeof history.metadata === "object"
                            ? Object.fromEntries(
                                Object.entries(history.metadata).map(([key, value]) => [
                                  key,
                                  Buffer.byteLength(JSON.stringify(value) ?? ""),
                                ]),
                              )
                            : undefined,
                      };
                    })(),
                  };
                }
              } catch {
                /* Payload contents never enter the report. */
              }
              decoded.push({
                direction,
                atMs: performance.now(),
                browserTimestampMs: event.timestamp * 1000,
                bytes: Buffer.byteLength(text),
                name,
                requestId,
                digest: createHash("sha256").update(text).digest("hex"),
                shape,
              });
            });
          }
          const samples: unknown[] = [];
          async function capture(
            name: string,
            action: () => Promise<Response | null | void>,
            kind: ReadinessKind = "chat",
            readDetails?: () => Promise<Record<string, unknown>>,
          ) {
            // A fresh inspector agent owns counters for this action even when Chrome
            // keeps the renderer for a navigation; a retained agent accumulates them.
            const performanceSession = await context.newCDPSession(page);
            await performanceSession.send("Performance.enable", { timeDomain: "threadTicks" });
            const traceEvents: unknown[] = [];
            const trace = values.timeline && (name === "session-switch" || name === "reconnect");
            if (trace) {
              performanceSession.on("Tracing.dataCollected", ({ value }) =>
                traceEvents.push(...value),
              );
              await performanceSession.send("Tracing.start", {
                categories: "devtools.timeline,v8,blink.user_timing",
                transferMode: "ReportEvents",
              });
            }
            try {
              const gatewayCpuBefore = process.cpuUsage();
              const startedAtMs = performance.now();
              const decodedStart = decoded.length;
              const result = await action();
              if (result && result.status() >= 400) {
                throw new Error(`Navigation failed with HTTP ${result.status()}`);
              }
              await page.waitForFunction(
                (readinessKind) => {
                  const state = Reflect.get(window, "__wireReadiness")?.state;
                  return readinessKind === "new-session"
                    ? state?.newSessionMs !== null && state?.newSessionMs !== undefined
                    : ["board", "usage", "settings"].includes(readinessKind)
                      ? state?.pageMs !== null && state?.pageMs !== undefined
                      : state?.transcriptMs !== null &&
                        state?.composerMs !== null &&
                        state?.transcriptMs !== undefined;
                },
                kind,
                { timeout: 60_000 },
              );
              const driverReadyAtMs = performance.now();
              const gatewayCpu = process.cpuUsage(gatewayCpuBefore);
              const gatewayRssBytes = process.memoryUsage.rss();
              const readiness = await page.evaluate(() => {
                const state = Reflect.get(window, "__wireReadiness").state;
                return { ...state };
              });
              const readyElapsedMs =
                kind === "new-session"
                  ? readiness.newSessionMs
                  : ["board", "usage", "settings"].includes(kind)
                    ? readiness.pageMs
                    : Math.max(readiness.transcriptMs, readiness.composerMs);
              const cpuAfter = (await performanceSession.send("Performance.getMetrics")).metrics;
              const cpuMetrics = (metrics: typeof cpuAfter) =>
                Object.fromEntries(
                  metrics
                    .filter((metric) =>
                      [
                        "TaskDuration",
                        "ScriptDuration",
                        "LayoutDuration",
                        "RecalcStyleDuration",
                      ].includes(metric.name),
                    )
                    .map((metric) => [metric.name, metric.value * 1000]),
                );
              const navigationStart = cpuAfter.find((metric) => metric.name === "NavigationStart");
              if (!navigationStart) {
                throw new Error("Chrome did not report the navigation clock");
              }
              const actionBrowserStartMs = navigationStart.value * 1000 + readiness.startMs;
              const readyBrowserTimestampMs = actionBrowserStartMs + readyElapsedMs;
              const transcriptVisibleBrowserTimestampMs =
                readiness.transcriptVisibleMs === null
                  ? null
                  : actionBrowserStartMs + readiness.transcriptVisibleMs;
              // Retain a bounded post-ready tail so queued bytes are not mistaken for delivery.
              await page.waitForTimeout(750);
              const httpSettled = await page
                .waitForLoadState("networkidle", { timeout: 5_000 })
                .then(
                  () => true,
                  () => false,
                );
              const settledCpu = (await performanceSession.send("Performance.getMetrics")).metrics;
              const settledElapsedMs = performance.now() - startedAtMs;
              if (trace) {
                const completed = new Promise<void>((resolve) => {
                  performanceSession.once("Tracing.tracingComplete", () => resolve());
                });
                await performanceSession.send("Tracing.end");
                await completed;
                await writeFile(
                  path.join(sampleOutput, `${name}-trace.json`),
                  JSON.stringify({ traceEvents }),
                );
              }
              const observed = decoded.slice(decodedStart);
              const arrivals = new Map<WireFrame, (typeof observed)[number]>();
              for (const event of observed) {
                const frame = proxy.frames.findLast(
                  (candidate) =>
                    candidate.direction === event.direction &&
                    candidate.digest === event.digest &&
                    !arrivals.has(candidate),
                );
                if (!frame) {
                  throw new Error(`CDP ${event.name} message absent from the raw wire census`);
                }
                arrivals.set(frame, event);
              }
              // Include work requested before this action but delivered during its interval.
              const frames = proxy.frames
                .filter((frame) => frame.atMs >= startedAtMs || arrivals.has(frame))
                .map((frame) => {
                  const received = arrivals.get(frame);
                  return Object.assign({}, frame, {
                    atMs: frame.atMs - startedAtMs,
                    deliveredAtMs: frame.deliveredAtMs - startedAtMs,
                    decodedAtMs: received
                      ? received.browserTimestampMs - actionBrowserStartMs
                      : null,
                    carryIn: frame.atMs < startedAtMs,
                    criticalBeforeReady: received
                      ? received.browserTimestampMs <= readyBrowserTimestampMs
                      : false,
                    beforeTranscriptVisible:
                      received && transcriptVisibleBrowserTimestampMs !== null
                        ? received.browserTimestampMs <= transcriptVisibleBrowserTimestampMs
                        : false,
                    shape: received?.shape,
                    packets: proxy.packets
                      .filter(
                        (packet) =>
                          packet.direction === frame.direction &&
                          packet.connection === frame.connection &&
                          packet.streamEnd > frame.streamStart &&
                          packet.streamStart < frame.streamEnd,
                      )
                      .map((packet) => ({
                        direction: packet.direction,
                        connection: packet.connection,
                        request: packet.request,
                        streamStart: packet.streamStart,
                        streamEnd: packet.streamEnd,
                        receivedAtMs: packet.receivedAtMs - startedAtMs,
                        serialStartMs: packet.serialStartMs - startedAtMs,
                        scheduledWriteMs: packet.scheduledWriteMs - startedAtMs,
                        actualWriteMs:
                          packet.actualWriteMs === undefined
                            ? undefined
                            : packet.actualWriteMs - startedAtMs,
                      })),
                  });
                });
              if (name === "cold-chat" || name === "session-switch") {
                const sessionNumber = name === "session-switch" ? 2 : 1;
                await page
                  .locator(".chat-pane-cache__pane--active .chat-virtual-row")
                  .filter({ hasText: `Synthetic session ${sessionNumber}, message 120.` })
                  .first()
                  .waitFor({ state: "visible" });
              }
              const criticalFrames = frames.filter((frame) => frame.criticalBeforeReady);
              if (kind === "reconnect") {
                const connected = criticalFrames.find(
                  (frame) => frame.direction === "received" && frame.name === "connect" && frame.ok,
                );
                const freshRoster = criticalFrames.find(
                  (frame) =>
                    frame.direction === "received" &&
                    frame.name === "sessions.list" &&
                    frame.ok &&
                    frame.connection === connected?.connection,
                );
                if (
                  !connected ||
                  !freshRoster ||
                  !negotiations.some(
                    (upgrade) => upgrade.atMs >= startedAtMs && upgrade.status === 101,
                  )
                ) {
                  throw new Error(
                    "Reconnect did not deliver a new handshake and fresh session roster before readiness",
                  );
                }
              }
              const http = [...requests.values()]
                .filter((record) => record.startedAtMs >= startedAtMs)
                .map((record) =>
                  Object.assign({}, record, {
                    requestedBeforeReady: record.browserStartedAtMs <= readyBrowserTimestampMs,
                    finishedBeforeReady:
                      record.browserFinishedAtMs !== undefined &&
                      record.browserFinishedAtMs <= readyBrowserTimestampMs,
                    url: new URL(record.url).pathname,
                    startedAtMs: record.startedAtMs - startedAtMs,
                    browserStartedAtMs: record.browserStartedAtMs - actionBrowserStartMs,
                    responseAtMs:
                      record.responseAtMs === undefined
                        ? undefined
                        : record.responseAtMs - startedAtMs,
                    browserResponseAtMs:
                      record.browserResponseAtMs === undefined
                        ? undefined
                        : record.browserResponseAtMs - actionBrowserStartMs,
                    finishedAtMs:
                      record.finishedAtMs === undefined
                        ? undefined
                        : record.finishedAtMs - startedAtMs,
                    browserFinishedAtMs:
                      record.browserFinishedAtMs === undefined
                        ? undefined
                        : record.browserFinishedAtMs - actionBrowserStartMs,
                  }),
                );
              const details = await readDetails?.();
              samples.push({
                name,
                ...details,
                readiness,
                driverElapsedMs: driverReadyAtMs - startedAtMs,
                hostLoad: loadavg(),
                httpSettled,
                incompleteHttpRequests: http.filter((request) => request.finishedAtMs === undefined)
                  .length,
                http,
                ...(name === "reconnect"
                  ? {
                      websocketLifecycle: websocketLifecycle
                        .filter(
                          (event) =>
                            event.atMs >=
                            startedAtMs -
                              (typeof details?.outageMs === "number" ? details.outageMs : 0),
                        )
                        .map((event) => ({
                          event: event.event,
                          requestId: event.requestId,
                          status: event.status,
                          atMs: event.atMs - startedAtMs,
                          browserAtMs:
                            event.browserAtMs === undefined
                              ? undefined
                              : event.browserAtMs - actionBrowserStartMs,
                        })),
                    }
                  : {}),
                websocketUpgrades: negotiations
                  .filter((upgrade) => upgrade.atMs >= startedAtMs)
                  .map((upgrade) =>
                    Object.assign({}, upgrade, {
                      startedAtMs:
                        upgrade.startedAtMs === undefined
                          ? undefined
                          : upgrade.startedAtMs - startedAtMs,
                      atMs: upgrade.atMs - startedAtMs,
                      browserStartedAtMs:
                        upgrade.browserStartedAtMs === undefined
                          ? undefined
                          : upgrade.browserStartedAtMs - actionBrowserStartMs,
                      browserResponseAtMs: upgrade.browserResponseAtMs - actionBrowserStartMs,
                    }),
                  ),
                websocket: frames,
                transportPackets: proxy.packets
                  .filter((packet) => packet.scheduledWriteMs >= startedAtMs)
                  .map((packet) => ({
                    direction: packet.direction,
                    connection: packet.connection,
                    request: packet.request,
                    streamStart: packet.streamStart,
                    streamEnd: packet.streamEnd,
                    receivedAtMs: packet.receivedAtMs - startedAtMs,
                    serialStartMs: packet.serialStartMs - startedAtMs,
                    scheduledWriteMs: packet.scheduledWriteMs - startedAtMs,
                    actualWriteMs:
                      packet.actualWriteMs === undefined
                        ? undefined
                        : packet.actualWriteMs - startedAtMs,
                  })),
                gatewayTimeline: gatewayTimeline
                  .filter((event) => event.atMs >= startedAtMs)
                  .map((event) => Object.assign({}, event, { atMs: event.atMs - startedAtMs })),
                jsonParses: values.timeline
                  ? await page.evaluate((startMs) => {
                      const parseSamples = Reflect.get(window, "__wireJsonParses") as Array<{
                        startedAtMs: number;
                        durationMs: number;
                        bytes: number;
                      }>;
                      return parseSamples
                        .filter((sample) => sample.startedAtMs >= startMs)
                        .map((sample) => ({
                          durationMs: sample.durationMs,
                          bytes: sample.bytes,
                          startedAtMs: sample.startedAtMs - startMs,
                        }));
                    }, readiness.startMs)
                  : undefined,
                summary: {
                  ...Object.fromEntries(
                    ["Script", "Stylesheet"].flatMap((type) => {
                      const matching = http.filter((request) => request.type === type);
                      const prefix = type === "Script" ? "js" : "css";
                      return [
                        [`${prefix}Fetches`, matching.length],
                        [
                          `${prefix}WireRequests`,
                          matching.filter((request) => request.bytes > 0).length,
                        ],
                        [
                          `${prefix}CacheHits`,
                          matching.filter((request) => request.cached && request.bytes === 0)
                            .length,
                        ],
                        [
                          `${prefix}Bytes`,
                          matching.reduce((sum, request) => sum + request.bytes, 0),
                        ],
                      ];
                    }),
                  ),
                  httpFetches: http.length,
                  httpWireRequests: http.filter((request) => request.bytes > 0).length,
                  httpCacheHits: http.filter((request) => request.cached && request.bytes === 0)
                    .length,
                  serviceWorkerResponses: http.filter((request) => request.fromServiceWorker)
                    .length,
                  httpFailedFetches: http.filter((request) => request.failed).length,
                  httpBytes: http.reduce((sum, record) => sum + record.bytes, 0),
                  wsWireBytes: criticalFrames.reduce((sum, frame) => sum + frame.wireBytes, 0),
                  wsDecodedBytes: criticalFrames.reduce(
                    (sum, frame) => sum + (frame.decodedBytes ?? 0),
                    0,
                  ),
                  wsMessages: criticalFrames.filter(
                    (frame) => frame.opcode === 1 || frame.opcode === 2,
                  ).length,
                  wsAllMessages: frames.filter((frame) => frame.opcode === 1 || frame.opcode === 2)
                    .length,
                },
                gatewayCpuMs: { user: gatewayCpu.user / 1000, system: gatewayCpu.system / 1000 },
                gatewayRssBytes,
                cpuMs: cpuMetrics(cpuAfter),
                settledCpuMs: cpuMetrics(settledCpu),
                settledElapsedMs,
              });
              console.log(`Completed ${name}: ${JSON.stringify(readiness)}`);
              if (values.screenshots && pair === 0) {
                await page.screenshot({ path: path.join(sampleOutput, `${name}.png`) });
              }
            } finally {
              await performanceSession.detach();
            }
          }
          try {
            const { buildControlUiSessionEntryUrl } =
              await import("../src/gateway/control-ui-session-entry-path.js");
            const entryUrl = new URL(
              buildControlUiSessionEntryUrl(controlUiSessionPath(sessionKeys[0]!), ""),
              proxy.url,
            ).href;
            await capture("cold-chat", () =>
              page.goto(entryUrl, { waitUntil: "domcontentloaded" }),
            );
            // Persistence is deferred beyond paint; token auth also needs its real boot receipt.
            // Loaded hosts can delay the boot receipt behind catalog reads; setup is unmeasured.
            const snapshotDeadline = Date.now() + 60_000;
            for (;;) {
              const persisted = await page.evaluate(
                async ({ sessionKey, bootRecordKey }) => {
                  if (bootRecordKey && localStorage.getItem(bootRecordKey) === null) {
                    return false;
                  }
                  const databases = await indexedDB.databases();
                  if (!databases.some((entry) => entry.name === "openclaw-chat-snapshots")) {
                    return false;
                  }
                  const database = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open("openclaw-chat-snapshots");
                    request.addEventListener("success", () => resolve(request.result), {
                      once: true,
                    });
                    request.addEventListener(
                      "error",
                      () => reject(request.error ?? new Error("Snapshot database failed to open")),
                      { once: true },
                    );
                  });
                  try {
                    const request = database
                      .transaction("snapshots", "readonly")
                      .objectStore("snapshots")
                      .getAll(undefined, 8);
                    const records = await new Promise<
                      Array<{ sessionKey: string; snapshot?: Record<string, unknown> }>
                    >((resolve, reject) => {
                      request.addEventListener("success", () => resolve(request.result), {
                        once: true,
                      });
                      request.addEventListener(
                        "error",
                        () => reject(request.error ?? new Error("Snapshot read failed")),
                        { once: true },
                      );
                    });
                    return records.some(
                      ({ sessionKey: storedKey, snapshot }) =>
                        storedKey.endsWith(`\u0000${sessionKey}`) &&
                        typeof snapshot?.sessionId === "string" &&
                        typeof snapshot.deltaCursor === "string" &&
                        snapshot.historyState !== undefined,
                    );
                  } finally {
                    database.close();
                  }
                },
                { sessionKey: sessionKeys[0]!, bootRecordKey: bootRecordStorageKey },
              );
              if (persisted) {
                break;
              }
              if (Date.now() >= snapshotDeadline) {
                throw new Error(
                  values.auth === "token"
                    ? "The selected transcript did not persist its warm-reload cursor and auth boot record"
                    : "The selected transcript did not persist its warm-reload cursor",
                );
              }
              await new Promise((resolve) => {
                setTimeout(resolve, 250);
              });
            }
            const extensions = negotiations[0]?.extensions ?? "none";
            if (remote !== extensions.includes("permessage-deflate")) {
              throw new Error(`Unexpected WebSocket compression negotiation: ${extensions}`);
            }
            await capture("warm-chat", () =>
              page.goto(entryUrl, { waitUntil: "domcontentloaded" }),
            );
            await page.waitForFunction(() => window.openclawControlUi !== undefined);
            await capture(
              "new-session",
              async () => {
                await page.evaluate(() => {
                  Reflect.get(window, "__wireReadiness").reset();
                  window.openclawControlUi?.navigate("new-session");
                });
              },
              "new-session",
            );
            // Return to the cached first pane before measuring a first visit to session B.
            await page.evaluate(
              (pathname) => window.openclawControlUi?.navigate("chat", { pathname }),
              controlUiSessionPath(sessionKeys[0]!),
            );
            await page
              .locator(".chat-pane-cache__pane--active .chat-virtual-row")
              .first()
              .waitFor();
            await capture("session-switch", async () => {
              await page.evaluate(
                ({ key, pathname }) => {
                  Reflect.get(window, "__wireReadiness").reset(key);
                  window.openclawControlUi?.navigate("chat", { pathname });
                },
                { key: sessionKeys[1]!, pathname: controlUiSessionPath(sessionKeys[1]!) },
              );
            });
            if (values["extended-flows"]) {
              await capture(
                "first-board",
                async () => {
                  await page.evaluate(
                    (pathname) => {
                      Reflect.get(window, "__wireReadiness").reset(undefined, "board");
                      window.openclawControlUi?.navigate("dashboard", { pathname });
                    },
                    new URL(controlUiSessionUrl(proxy.url, sessionKeys[1]!, "dashboard")).pathname,
                  );
                },
                "board",
              );
              await capture(
                "first-usage",
                async () => {
                  await page.evaluate(() => {
                    Reflect.get(window, "__wireReadiness").reset(undefined, "usage");
                    window.openclawControlUi?.navigate("usage");
                  });
                },
                "usage",
              );
              await capture(
                "first-settings",
                async () => {
                  await page.evaluate(() => {
                    Reflect.get(window, "__wireReadiness").reset(undefined, "settings");
                    // Desktop /settings redirects to chat; Appearance is the default Settings page.
                    window.openclawControlUi?.navigate("appearance");
                  });
                },
                "settings",
              );
              await page.evaluate((pathname) => {
                Reflect.get(window, "__wireReadiness").reset("agent:main:wire-fixture-b");
                window.openclawControlUi?.navigate("chat", { pathname });
              }, controlUiSessionPath(sessionKeys[1]!));
              await page.waitForFunction(() => {
                const state = Reflect.get(window, "__wireReadiness").state;
                return state.transcriptMs !== null && state.composerMs !== null;
              });
              // Route visits may retain Dashboard; reconnect compares the same chat layout.
              const activePane = page.locator(".chat-pane-cache__pane--active");
              const closeDashboard = activePane.getByRole("button", {
                name: "Close Dashboard",
                exact: true,
              });
              if (await closeDashboard.isVisible()) {
                await closeDashboard.click();
              }
              const reconnectLayoutHandle = await page.waitForFunction(() => {
                const pane = document.querySelector(".chat-pane-cache__pane--active");
                const region = pane?.querySelector<HTMLElement>(".sidebar-region");
                const conversation = region?.querySelector<HTMLElement>(".sidebar-region__primary");
                const dashboard = region?.querySelector<HTMLElement>(
                  '[data-panel-slot="dashboard"]',
                );
                if (!region || !conversation?.checkVisibility() || dashboard?.checkVisibility()) {
                  return null;
                }
                const regionBounds = region.getBoundingClientRect();
                const conversationBounds = conversation.getBoundingClientRect();
                if (
                  regionBounds.width <= 0 ||
                  Math.abs(regionBounds.left - conversationBounds.left) > 1 ||
                  Math.abs(regionBounds.right - conversationBounds.right) > 1
                ) {
                  return null;
                }
                return {
                  regionWidth: regionBounds.width,
                  conversationWidth: conversationBounds.width,
                };
              });
              const reconnectLayout = await reconnectLayoutHandle.jsonValue();
              await reconnectLayoutHandle.dispose();
              const reconnectObserver = await observeReconnect(page);
              let reconnectWindowId: number | undefined;
              await reconnectObserver.evaluate((observer) => observer.mark("outage-start"));
              const outageStartedAtMs = performance.now();
              const outageStartedEpochMs = Date.now();
              proxy.setOffline(true);
              try {
                if (values["reconnect-trigger"] === "online") {
                  await context.setOffline(true);
                } else if (values["reconnect-trigger"] === "visible") {
                  // Disable Playwright's focus override; require an actual hidden document.
                  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
                  const { windowId } = await cdp.send("Browser.getWindowForTarget");
                  reconnectWindowId = windowId;
                  await cdp.send("Browser.setWindowBounds", {
                    windowId,
                    bounds: { windowState: "minimized" },
                  });
                  await page.waitForFunction(
                    () => document.visibilityState === "hidden",
                    undefined,
                    { timeout: 2_000, polling: 50 },
                  );
                }
                await page.waitForFunction(
                  () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
                  undefined,
                  {
                    timeout: 30_000,
                    ...(values["reconnect-trigger"] === "visible" ? { polling: 50 } : {}),
                  },
                );
                await page.waitForTimeout(
                  Math.max(0, 5_000 - (performance.now() - outageStartedAtMs)),
                );
                let outageMs = 0;
                let restoredEpochMs = 0;
                await capture(
                  "reconnect",
                  async () => {
                    await page.evaluate((key) => {
                      Reflect.get(window, "__wireReadiness").reset(key, "reconnect");
                    }, sessionKeys[1]!);
                    await reconnectObserver.evaluate((observer) => observer.mark("before-restore"));
                    outageMs = performance.now() - outageStartedAtMs;
                    restoredEpochMs = Date.now();
                    proxy.setOffline(false);
                    await reconnectObserver.evaluate((observer) => observer.mark("link-restored"));
                    if (values["reconnect-trigger"] === "online") {
                      await context.setOffline(false);
                    } else if (reconnectWindowId !== undefined) {
                      await cdp.send("Browser.setWindowBounds", {
                        windowId: reconnectWindowId,
                        bounds: { windowState: "normal" },
                      });
                      await page.waitForFunction(
                        () => document.visibilityState === "visible",
                        undefined,
                        { timeout: 2_000, polling: 50 },
                      );
                    }
                  },
                  "reconnect",
                  async () => {
                    const retrySchedule = await reconnectObserver.evaluate((observer) => {
                      return observer.read(Reflect.get(window, "__wireReadiness").state.startMs);
                    });
                    const saw = (event: string, state: boolean | string) =>
                      retrySchedule.events.some(
                        (entry) =>
                          entry.event === event &&
                          entry.isTrusted === true &&
                          (typeof state === "boolean"
                            ? entry.online === state
                            : entry.visibility === state),
                      );
                    if (
                      (values["reconnect-trigger"] === "online" &&
                        (!saw("offline", false) || !saw("online", true))) ||
                      (values["reconnect-trigger"] === "visible" &&
                        (!saw("visibilitychange", "hidden") || !saw("visibilitychange", "visible")))
                    ) {
                      throw new Error(
                        "Reconnect trigger did not produce the expected browser events",
                      );
                    }
                    return {
                      outageMs,
                      outageStartedEpochMs,
                      restoredEpochMs,
                      layout: reconnectLayout,
                      reconnectTrigger: values["reconnect-trigger"],
                      retrySchedule,
                    };
                  },
                );
              } finally {
                proxy.setOffline(false);
                if (values["reconnect-trigger"] === "online") {
                  await context.setOffline(false);
                } else if (reconnectWindowId !== undefined) {
                  await cdp.send("Browser.setWindowBounds", {
                    windowId: reconnectWindowId,
                    bounds: { windowState: "normal" },
                  });
                  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
                }
                await reconnectObserver.evaluate((observer) => observer.dispose());
                await reconnectObserver.dispose();
              }
            }
            await writeFile(
              path.join(sampleOutput, "sample.json"),
              JSON.stringify(
                {
                  format: "control-ui-real-wire-v1",
                  profile: values.profile,
                  networkProfile,
                  proxyNagle: values["proxy-nagle"],
                  timeline: values.timeline,
                  extendedFlows: values["extended-flows"],
                  reconnectTrigger: values["reconnect-trigger"],
                  revision,
                  dirty,
                  bundle,
                  fixture: { sessions: 2, messagesEach: 120, auth: values.auth },
                  measurement:
                    "Real Gateway. Synthetic offline-owned state. TCP proxy measures RFC6455 headers/payloads before delivery. HTTP bytes and wire-request counts are page-observed lower bounds: encodedDataLength includes response headers, but underlying service-worker fetches are not captured. Service-worker delivery is recorded separately and does not itself prove a cache hit. Network profile describes shared bandwidth per direction and one-way application-stream latency; no simulated packet loss/congestion or TCP handshake latency. Readiness is first animation frame with visible enabled selectors; reconnect additionally requires a fresh handshake and roster. Reconnect timing starts at link restoration, excluding the separately reported outage. Board is the session Dashboard face with an empty Board; Settings is Appearance. Screenshots are outside the timed interval.",
                  samples,
                  negotiations,
                  errors,
                },
                null,
                2,
              ),
            );
          } catch (error) {
            await page.screenshot({ path: path.join(sampleOutput, "failure.png") }).catch(() => {});
            await writeFile(
              path.join(sampleOutput, "failure.json"),
              JSON.stringify(
                {
                  error: String(error),
                  url: page.url(),
                  samples,
                  errors,
                  text: (await page.locator("body").textContent())?.slice(0, 6000),
                  websocket: decoded.map(({ name, bytes, direction }) => ({
                    name,
                    bytes,
                    direction,
                  })),
                },
                null,
                2,
              ),
            );
            throw error;
          } finally {
            if (observation) {
              await observation.close();
            } else {
              await context.close();
            }
          }
          if (commandIterator) {
            console.log(
              `${workerMessagePrefix}${JSON.stringify({ type: "sample", sample: pair + 1 })}`,
            );
          }
        }
        // Keep shutdown work out of the other source's final measured sample.
        if (commandIterator && !(await commandIterator.next()).done) {
          throw new Error("Expected end of controlled worker input after final sample");
        }
      } finally {
        commands?.close();
        await browser?.close();
      }
    } finally {
      await proxy.close();
    }
  } finally {
    rpcChannel.unsubscribe(observeGateway);
    stageChannel.unsubscribe(observeGateway);
    await gateway.close({ reason: "Wire benchmark complete", exitAfterClose: true });
  }
}

if (values.worker) {
  // Snapshot staging requires a private temp ancestor; proof/state can stay on an external disk.
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "openclaw-wire-cache-"));
  process.env.XDG_CACHE_HOME = cacheRoot;
  try {
    await runWorker();
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
  process.exit(0);
} else {
  const ownSource = await realpath(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const otherSource = values["compare-source-dir"]
    ? await realpath(values["compare-source-dir"])
    : undefined;
  const otherBundle = values["compare-bundle-dir"]
    ? path.resolve(values["compare-bundle-dir"])
    : bundle;
  if (otherSource) {
    for (const source of new Set([ownSource, otherSource])) {
      const branch = execFileSync("git", ["-C", source, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim();
      if (branch !== "HEAD") {
        throw new Error(
          "Source comparisons require detached checkouts: dev-branch badges load extra fonts",
        );
      }
    }
  }
  const reports: unknown[] = [];
  if (otherSource && otherSource !== ownSource) {
    // A task-owned baseline checkout runs identical instrumentation against its source.
    for (const relative of [
      "scripts/bench-control-ui-wire.ts",
      "scripts/lib/control-ui-wire-link.ts",
    ]) {
      await copyFile(path.join(ownSource, relative), path.join(otherSource, relative));
    }
  }
  const persistentComparison = Boolean(
    otherSource &&
    !values.port &&
    (otherSource !== ownSource || (await realpath(otherBundle)) === (await realpath(bundle))),
  );
  async function bindBundle(source: string, directory: string) {
    const resolvedDirectory = await realpath(directory);
    const defaultRoot = path.join(source, "dist/control-ui");
    const backup = `${defaultRoot}.wire-backup-${process.pid}`;
    const existing = await lstat(defaultRoot).catch(() => undefined);
    let displaced = false;
    let linked = false;
    try {
      if ((await realpath(defaultRoot).catch(() => "")) !== resolvedDirectory) {
        await mkdir(path.dirname(defaultRoot), { recursive: true });
        if (existing) {
          await rename(defaultRoot, backup);
          displaced = true;
        }
        await symlink(directory, defaultRoot, "dir");
        linked = true;
      }
    } catch (error) {
      if (displaced) {
        await rename(backup, defaultRoot);
      }
      throw error;
    }
    return async () => {
      if (linked) {
        await unlink(defaultRoot);
      }
      if (displaced) {
        await rename(backup, defaultRoot);
      }
    };
  }
  const ownedStops = new Set<() => void>();
  let interrupted = false;
  const stopWorkers = () => {
    interrupted = true;
    ownedStops.forEach((stop) => stop());
  };
  process.once("SIGINT", stopWorkers);
  process.once("SIGTERM", stopWorkers);
  async function startWorker(
    source: string,
    directory: string,
    workerOutput: string,
    workerPairs: number,
    controlled: boolean,
    screenshots: boolean,
  ) {
    await mkdir(workerOutput, { recursive: true });
    if (interrupted) {
      throw new Error("Wire benchmark interrupted");
    }
    const args = [
      "--import",
      path.join(source, "scripts/tsx.mjs"),
      path.join(source, "scripts/bench-control-ui-wire.ts"),
      "--worker",
      "--bundle-dir",
      directory,
      "--pairs",
      String(workerPairs),
      "--profile",
      values.profile,
      "--auth",
      values.auth,
      "--reconnect-trigger",
      values["reconnect-trigger"],
      "--output",
      workerOutput,
    ];
    if (values.port) {
      args.push("--port", values.port);
    }
    if (controlled) {
      args.push("--controlled-worker");
    }
    if (screenshots) {
      args.push("--screenshots");
    }
    if (values["extended-flows"]) {
      args.push("--extended-flows");
    }
    if (values.timeline) {
      args.push("--timeline");
    }
    if (values["proxy-nagle"]) {
      args.push("--proxy-nagle");
    }
    const child = spawn(process.execPath, args, {
      cwd: source,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(source, "tsconfig.json") },
      stdio: [controlled ? "pipe" : "ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const log = createWriteStream(path.join(workerOutput, "process.log"));
    child.stdout!.pipe(log, { end: false });
    child.stderr!.pipe(log, { end: false });
    let failure: Error | undefined;
    let exited = false;
    let closingRequested = false;
    let waiting:
      | {
          type: "ready" | "sample";
          sample?: number;
          resolve: () => void;
          reject: (error: Error) => void;
        }
      | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      waiting?.reject(failure);
      waiting = undefined;
    };
    const waitForNotice = (type: "ready" | "sample", sample?: number) => {
      if (failure || exited || waiting) {
        return Promise.reject(
          failure ?? new Error(exited ? "Wire worker already exited" : "Wire sample overlap"),
        );
      }
      return new Promise<void>((resolve, reject) => {
        waiting = { type, sample, resolve, reject };
      });
    };
    const ready = controlled ? waitForNotice("ready") : Promise.resolve();
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", (error) => {
        fail(error);
        reject(error);
      });
      child.once("close", (exitCode) => {
        exited = true;
        if (exitCode !== 0 || waiting || (controlled && !closingRequested)) {
          fail(new Error(`Wire worker exited (${exitCode}); inspect ${workerOutput}`));
        }
        resolve(exitCode);
      });
    });
    // Readiness can fail before the caller starts waiting for process completion.
    void completion.catch(() => {});
    child.stdin?.on("error", fail);
    const notices = controlled
      ? createInterface({ input: child.stdout!, crlfDelay: Infinity })
      : undefined;
    notices?.on("line", (line) => {
      if (!line.startsWith(workerMessagePrefix)) {
        return;
      }
      try {
        const notice: unknown = JSON.parse(line.slice(workerMessagePrefix.length));
        if (
          !notice ||
          typeof notice !== "object" ||
          !waiting ||
          !("type" in notice) ||
          notice.type !== waiting.type ||
          (waiting.type === "sample" && (!("sample" in notice) || notice.sample !== waiting.sample))
        ) {
          throw new Error(`Unexpected wire worker notice; inspect ${workerOutput}`);
        }
        const admitted = waiting;
        waiting = undefined;
        admitted.resolve();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    let stopping: Promise<unknown> | undefined;
    const stop = () => {
      fail(new Error(`Wire worker interrupted; inspect ${workerOutput}`));
      stopping ??= stopChild(child);
    };
    ownedStops.add(stop);
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        closingRequested = true;
        child.stdin?.end();
        if (failure) {
          stopping ??= stopChild(child);
        }
        await completion.catch(() => {});
        await (stopping ?? stopChild(child));
        ownedStops.delete(stop);
        notices?.close();
        await new Promise<void>((resolve) => {
          log.end(resolve);
        });
        if (failure) {
          throw failure;
        }
      })());
    try {
      await ready;
    } catch (error) {
      await close();
      throw error;
    }
    return {
      workerOutput,
      run: async (sample: number) => {
        const notice = waitForNotice("sample", sample);
        child.stdin!.write(`${JSON.stringify({ type: "sample", sample })}\n`, (error) => {
          if (error) {
            fail(error);
          }
        });
        await notice;
      },
      wait: async () => {
        const exitCode = await completion;
        if (failure || exitCode !== 0) {
          throw failure ?? new Error(`Wire sample failed (${exitCode}); inspect ${workerOutput}`);
        }
      },
      close,
    };
  }
  async function recordSample(workerOutput: string, label: string, sample: number, pair: number) {
    const report = JSON.parse(
      await readFile(
        path.join(workerOutput, String(sample).padStart(2, "0"), "sample.json"),
        "utf8",
      ),
    );
    reports.push({ pair, label, ...report });
    console.log(
      JSON.stringify({
        pair,
        label,
        summary: report.samples.map(
          (entry: { name: string; readiness: unknown; summary: object }) =>
            Object.assign({ name: entry.name, readiness: entry.readiness }, entry.summary),
        ),
      }),
    );
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(
        {
          comparisonOrder: otherSource
            ? "alternating base/candidate source pairs"
            : "single source repeated samples",
          workerLifecycle: persistentComparison
            ? "persistent-per-source"
            : otherSource
              ? "per-comparison-sample"
              : "single-source",
          reports,
        },
        null,
        2,
      ),
    );
  }
  async function collect(
    source: string,
    label: string,
    directory: string,
    workerPairs: number,
    pairOffset: number,
  ) {
    const restore = await bindBundle(source, directory);
    try {
      const worker = await startWorker(
        source,
        directory,
        path.join(output, `${String(pairOffset + 1).padStart(2, "0")}-${label}`),
        workerPairs,
        false,
        pairOffset === 0,
      );
      try {
        await worker.wait();
        for (let pair = 0; pair < workerPairs; pair++) {
          await recordSample(worker.workerOutput, label, pair + 1, pairOffset + pair + 1);
        }
      } finally {
        await worker.close();
      }
    } finally {
      await restore();
    }
  }
  if (otherSource && persistentComparison) {
    const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
    const restores: Array<() => Promise<void>> = [];
    let cleanupFailure: PromiseRejectedResult | undefined;
    try {
      restores.push(await bindBundle(otherSource, otherBundle));
      if (ownSource !== otherSource) {
        restores.push(await bindBundle(ownSource, bundle));
      }
      const base = await startWorker(
        otherSource,
        otherBundle,
        path.join(output, "base"),
        pairs,
        true,
        true,
      );
      workers.push(base);
      const candidate = await startWorker(
        ownSource,
        bundle,
        path.join(output, "candidate"),
        pairs,
        true,
        true,
      );
      workers.push(candidate);
      for (let pair = 0; pair < pairs; pair++) {
        const order = [
          [base, "base"],
          [candidate, "candidate"],
        ] as const;
        for (const [worker, label] of pair % 2 ? order.toReversed() : order) {
          await worker.run(pair + 1);
          await recordSample(worker.workerOutput, label, pair + 1, pair + 1);
        }
      }
    } finally {
      const closed = await Promise.allSettled(workers.map((worker) => worker.close()));
      const restored = await Promise.allSettled(restores.map((restore) => restore()));
      cleanupFailure = [...closed, ...restored].find((result) => result.status === "rejected");
    }
    if (cleanupFailure) {
      throw cleanupFailure.reason;
    }
  } else if (otherSource) {
    for (let pair = 0; pair < pairs; pair++) {
      const order = [
        [otherSource, "base"],
        [ownSource, "candidate"],
      ] as const;
      for (const [source, label] of pair % 2 ? order.toReversed() : order) {
        await collect(source, label, label === "base" ? otherBundle : bundle, 1, pair);
      }
    }
  } else {
    await collect(ownSource, "base", bundle, pairs, 0);
  }
  process.off("SIGINT", stopWorkers);
  process.off("SIGTERM", stopWorkers);
  if (interrupted) {
    throw new Error("Wire benchmark interrupted");
  }
}
