import { spawn, execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
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
} from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inflateRawSync, constants as zlibConstants } from "node:zlib";
import { chromium, type Response } from "playwright";
import {
  gatewayCredentialScope,
  gatewayOriginScope,
} from "../packages/gateway-client/src/gateway-origin-scope.ts";
import type { TranscriptEvent } from "../src/config/sessions/session-accessor.sqlite-contract.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { CONTROL_UI_TOKEN_SESSION_KEY_PREFIX } from "../src/shared/control-ui-storage.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/playwright-chromium.ts";
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
    screenshots: { type: "boolean", default: false },
  },
});
if (
  !values["bundle-dir"] ||
  !values.output ||
  !["local", "remote"].includes(values.profile) ||
  !["none", "token"].includes(values.auth)
) {
  throw new Error(
    "Required: --bundle-dir <built UI> --output <directory> [--profile local|remote] [--auth none|token] [--pairs N] [--compare-source-dir <checkout>] [--compare-bundle-dir <base UI>]",
  );
}
if (values["compare-bundle-dir"] && !values["compare-source-dir"]) {
  throw new Error("--compare-bundle-dir requires --compare-source-dir (use . for the same source)");
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
const remote = values.profile === "remote";
const SYNTHETIC_GATEWAY_TOKEN = "synthetic-wire-benchmark-gateway-token";
const sessionKeys = ["agent:main:wire-fixture-a", "agent:main:wire-fixture-b"];
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
  digest?: string;
};

// Observe RFC6455 bytes before forwarding. CDP exposes decompressed messages, so its
// payload length cannot establish whether permessage-deflate saves wire bytes.
function frameReader(
  direction: WireFrame["direction"],
  connection: number,
  frames: WireFrame[],
  methods: Map<string, string>,
) {
  let pending = Buffer.alloc(0);
  let headers = true;
  let upgraded = false;
  let message: WireFrame | undefined;
  let parts: Buffer[] = [];
  return (chunk: Buffer, deliveredAtMs: number, receivedAtMs = performance.now()) => {
    pending = Buffer.concat([pending, chunk]);
    if (headers) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      const header = pending.subarray(0, end).toString("latin1");
      upgraded = /upgrade:\s*websocket/iu.test(header);
      headers = false;
      if (!upgraded) {
        pending = Buffer.alloc(0);
        return;
      }
      pending = pending.subarray(end + 4);
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
            message.decodedBytes = payload.length;
            message.digest = createHash("sha256").update(payload).digest("hex");
          }
          frames.push(message);
          message = undefined;
        }
      }
      pending = pending.subarray(headerBytes + length);
    }
  };
}

async function startProxy(upstreamPort: number, listenPort: number) {
  const frames: WireFrame[] = [];
  const sockets = new Set<Socket>();
  const links = { sent: createControlUiWireLink(), received: createControlUiWireLink() };
  let connection = 0;
  const methods = new Map<string, string>();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ port: upstreamPort, host: "127.0.0.1", allowHalfOpen: true });
    sockets.add(client);
    sockets.add(upstream);
    client.on("close", () => sockets.delete(client));
    upstream.on("close", () => sockets.delete(upstream));
    const id = ++connection;
    for (const [source, target, direction] of [
      [client, upstream, "sent"],
      [upstream, client, "received"],
    ] as const) {
      const inspect = frameReader(direction, id, frames, methods);
      if (remote) {
        links[direction].connect(source, target, inspect);
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
    url: `http://127.0.0.1:${address.port}`,
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

function installReadiness() {
  type Readiness = {
    startMs: number;
    transcriptMs: number | null;
    composerMs: number | null;
    newSessionMs: number | null;
  };
  const state: Readiness = { startMs: 0, transcriptMs: null, composerMs: null, newSessionMs: null };
  const visible = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    return element?.checkVisibility() ? element : null;
  };
  let expectedKey: string | undefined = "agent:main:wire-fixture-a";
  const sample = () => {
    const pane = visible(".chat-pane-cache__pane--active");
    const correctPane = pane && (!expectedKey || Reflect.get(pane, "sessionKey") === expectedKey);
    if (
      correctPane &&
      Reflect.get(pane, "transcriptReady") === true &&
      visible(".chat-pane-cache__pane--active .chat-virtual-row")
    ) {
      state.transcriptMs ??= performance.now() - state.startMs;
    }
    const composer =
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
    requestAnimationFrame(sample);
  };
  Reflect.set(window, "__wireReadiness", {
    state,
    reset(key?: string) {
      expectedKey = key;
      state.startMs = performance.now();
      state.transcriptMs = null;
      state.composerMs = null;
      state.newSessionMs = null;
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
  const [{ startGatewayServer }, { controlUiSessionPath }] = await Promise.all([
    import("../src/gateway/server.js"),
    import("../ui/src/test-helpers/control-ui-e2e-session-urls.ts"),
  ]);
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
      const browser = await chromium.launch({
        executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
        headless: true,
      });
      try {
        for (let pair = 0; pair < pairs; pair++) {
          const sampleOutput = path.join(output, String(pair + 1).padStart(2, "0"));
          await mkdir(sampleOutput, { recursive: true });
          const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
            ...(remote
              ? {
                  extraHTTPHeaders: {
                    "x-forwarded-for": "198.51.100.10",
                  },
                }
              : {}),
          });
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
          await page.addInitScript({
            content: `const __name = (fn) => fn; (${installReadiness.toString()})();`,
          });
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
          };
          const requests = new Map<string, HttpRecord>();
          const decoded: Decoded[] = [];
          const methods = new Map<string, string>();
          const errors: string[] = [];
          const upgradeRequests = new Map<
            string,
            { startedAtMs: number; browserStartedAtMs: number }
          >();
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
            upgradeRequests.set(event.requestId, {
              startedAtMs: performance.now(),
              browserStartedAtMs: event.timestamp * 1000,
            });
          });
          cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
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
                cached:
                  request.cached ||
                  event.response.fromDiskCache ||
                  event.response.fromServiceWorker ||
                  false,
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
              try {
                const message = JSON.parse(text) as {
                  id?: string;
                  type?: string;
                  method?: string;
                  event?: string;
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
              });
            });
          }
          const samples: unknown[] = [];
          async function capture(
            name: string,
            action: () => Promise<Response | null | void>,
            newSession = false,
          ) {
            // A fresh inspector agent owns counters for this action even when Chrome
            // keeps the renderer for a navigation; a retained agent accumulates them.
            const performanceSession = await context.newCDPSession(page);
            await performanceSession.send("Performance.enable", { timeDomain: "threadTicks" });
            try {
              const gatewayCpuBefore = process.cpuUsage();
              const startedAtMs = performance.now();
              const decodedStart = decoded.length;
              const result = await action();
              if (result && result.status() >= 400) {
                throw new Error(`Navigation failed with HTTP ${result.status()}`);
              }
              await page.waitForFunction(
                (isNew) => {
                  const state = Reflect.get(window, "__wireReadiness")?.state;
                  return isNew
                    ? state?.newSessionMs !== null && state?.newSessionMs !== undefined
                    : state?.transcriptMs !== null &&
                        state?.composerMs !== null &&
                        state?.transcriptMs !== undefined;
                },
                newSession,
                { timeout: 60_000 },
              );
              const driverReadyAtMs = performance.now();
              const gatewayCpu = process.cpuUsage(gatewayCpuBefore);
              const gatewayRssBytes = process.memoryUsage.rss();
              const readiness = await page.evaluate(() => {
                const state = Reflect.get(window, "__wireReadiness").state;
                return { ...state };
              });
              const readyElapsedMs = newSession
                ? readiness.newSessionMs
                : Math.max(readiness.transcriptMs, readiness.composerMs);
              const cpuAfter = (await performanceSession.send("Performance.getMetrics")).metrics;
              const navigationStart = cpuAfter.find((metric) => metric.name === "NavigationStart");
              if (!navigationStart) {
                throw new Error("Chrome did not report the navigation clock");
              }
              const actionBrowserStartMs = navigationStart.value * 1000 + readiness.startMs;
              const readyBrowserTimestampMs = actionBrowserStartMs + readyElapsedMs;
              // Retain a bounded post-ready tail so queued bytes are not mistaken for delivery.
              await page.waitForTimeout(750);
              const httpSettled = await page
                .waitForLoadState("networkidle", { timeout: 5_000 })
                .then(
                  () => true,
                  () => false,
                );
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
              samples.push({
                name,
                readiness,
                driverElapsedMs: driverReadyAtMs - startedAtMs,
                hostLoad: loadavg(),
                httpSettled,
                incompleteHttpRequests: http.filter((request) => request.finishedAtMs === undefined)
                  .length,
                http,
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
                cpuMs: Object.fromEntries(
                  cpuAfter
                    .filter((m) =>
                      [
                        "TaskDuration",
                        "ScriptDuration",
                        "LayoutDuration",
                        "RecalcStyleDuration",
                      ].includes(m.name),
                    )
                    .map((m) => [m.name, m.value * 1000]),
                ),
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
            const snapshotDeadline = Date.now() + 10_000;
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
              true,
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
            await writeFile(
              path.join(sampleOutput, "sample.json"),
              JSON.stringify(
                {
                  format: "control-ui-real-wire-v1",
                  profile: values.profile,
                  revision,
                  dirty,
                  bundle,
                  fixture: { sessions: 2, messagesEach: 120, auth: values.auth },
                  measurement:
                    "Real Gateway. Synthetic offline-owned state. TCP proxy measures RFC6455 headers/payloads before delivery. HTTP encodedDataLength includes headers. Remote: shared 10 Mbps link per direction, 50 ms one-way application-stream latency, no simulated packet loss/congestion or TCP handshake latency. Readiness is first animation frame with visible enabled selectors; screenshots outside timed interval.",
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
            await context.close();
          }
        }
      } finally {
        await browser.close();
      }
    } finally {
      await proxy.close();
    }
  } finally {
    await gateway.close({ reason: "Wire benchmark complete", exitAfterClose: true });
  }
}

if (values.worker) {
  await runWorker();
  process.exit(0);
} else {
  const ownSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const otherSource = values["compare-source-dir"]
    ? path.resolve(values["compare-source-dir"])
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
  async function collect(
    source: string,
    label: string,
    directory: string,
    workerPairs: number,
    pairOffset: number,
  ) {
    const defaultRoot = path.join(source, "dist/control-ui");
    const backup = `${defaultRoot}.wire-backup-${process.pid}`;
    const existing = await lstat(defaultRoot).catch(() => undefined);
    let displaced = false;
    let linked = false;
    const workerOutput = path.join(output, `${String(pairOffset + 1).padStart(2, "0")}-${label}`);
    await mkdir(workerOutput, { recursive: true });
    try {
      if ((await realpath(defaultRoot).catch(() => "")) !== (await realpath(directory))) {
        await mkdir(path.dirname(defaultRoot), { recursive: true });
        if (existing) {
          await rename(defaultRoot, backup);
          displaced = true;
        }
        await symlink(directory, defaultRoot, "dir");
        linked = true;
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
        "--output",
        workerOutput,
      ];
      if (values.port) {
        args.push("--port", values.port);
      }
      if (pairOffset === 0) {
        args.push("--screenshots");
      }
      const child = spawn(process.execPath, args, {
        cwd: source,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(source, "tsconfig.json") },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const log = createWriteStream(path.join(workerOutput, "process.log"));
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      let stopping: Promise<unknown> | undefined;
      const stop = () => {
        stopping ??= stopChild(child);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      await (stopping ?? stopChild(child));
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await new Promise<void>((resolve) => {
        log.end(resolve);
      });
      if (code !== 0) {
        throw new Error(`Wire sample failed (${code}); inspect ${workerOutput}`);
      }
      for (let pair = 0; pair < workerPairs; pair++) {
        const report = JSON.parse(
          await readFile(
            path.join(workerOutput, String(pair + 1).padStart(2, "0"), "sample.json"),
            "utf8",
          ),
        );
        reports.push({ pair: pairOffset + pair + 1, label, ...report });
        console.log(
          JSON.stringify({
            pair: pairOffset + pair + 1,
            label,
            summary: report.samples.map(
              (sample: { name: string; readiness: unknown; summary: object }) =>
                Object.assign({ name: sample.name, readiness: sample.readiness }, sample.summary),
            ),
          }),
        );
      }
      await writeFile(
        path.join(output, "report.json"),
        JSON.stringify(
          {
            comparisonOrder: otherSource
              ? "alternating base/candidate source pairs"
              : "single source repeated samples",
            reports,
          },
          null,
          2,
        ),
      );
    } finally {
      if (linked) {
        await unlink(defaultRoot);
      }
      if (displaced) {
        await rename(backup, defaultRoot);
      }
    }
  }
  if (otherSource) {
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
}
