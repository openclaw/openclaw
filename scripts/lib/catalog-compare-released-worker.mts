// One released OpenClaw reader over one catalog bundle, inside a throwaway sandbox.
// Spawned by scripts/catalog-compare-released.mts; never run against real state.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import type { ReleaseRun, RowObservation, CapturedCall } from "./catalog-compare-released-diff.mts";

type Args = {
  releaseDir: string;
  bundle: string;
  /** Both sides of the comparison, so both runs enable the same plugins. */
  comparedBundles: string[];
  sandbox: string;
  cert: string;
  key: string;
  out: string;
  filter?: string;
};

const args = JSON.parse(process.argv[2] ?? "{}") as Args;
const configPath = assertSandboxed(args.sandbox);

const SYNTHETIC_KEY = "synthetic-catalog-compare";
const SESSION_ID = "catalog-compare";
const REQUEST_TIMEOUT_MS = 10_000;
const packageDir = path.join(args.releaseDir, "node_modules/openclaw");
const dist = path.join(packageDir, "dist");
const pluginScope = path.join(args.releaseDir, "node_modules/@openclaw");

// The release must see only this process's sandbox. A real HOME would expose
// ~/.openclaw state, credentials and a running Gateway.
function assertSandboxed(sandbox: string): string {
  // userInfo reads the account database, so it still names the real home under a fake HOME.
  const realHome = fs.realpathSync(os.userInfo().homedir);
  const root = fs.realpathSync(sandbox);
  if (
    root === realHome ||
    root.startsWith(realHome + path.sep) ||
    realHome.startsWith(root + path.sep)
  ) {
    throw new Error(`sandbox must not contain or sit inside the real home: ${root}`);
  }
  if (!process.cwd().startsWith(sandbox + path.sep)) {
    throw new Error(
      `working directory must be inside the sandbox ${sandbox}, got ${process.cwd()}`,
    );
  }
  const insideSandbox = (name: string): string => {
    const value = process.env[name];
    if (!value || !path.resolve(value).startsWith(sandbox + path.sep)) {
      throw new Error(
        `${name} must point inside the sandbox ${sandbox}, got ${value ?? "(unset)"}`,
      );
    }
    return value;
  };
  for (const name of ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]) {
    insideSandbox(name);
  }
  return insideSandbox("OPENCLAW_CONFIG_PATH");
}

// Released chunk names are hashed and export aliases minified; function
// declarations keep source names. Find the chunk that declares and exports one.
const chunks = fs
  .readdirSync(dist)
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => path.join(dist, file));
async function releasedExport(name: string, marker?: string): Promise<unknown> {
  const declaration = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`);
  const exported = new RegExp(`export \\{[^}]*\\b${name}(?: as (\\w+))?\\s*[,}]`);
  for (const file of chunks) {
    const source = fs.readFileSync(file, "utf8");
    if (!declaration.test(source) || (marker && !source.includes(marker))) {
      continue;
    }
    const match = exported.exec(source);
    if (!match) {
      continue;
    }
    const value = (await import(pathToFileURL(file).href))[match[1] ?? name];
    if (typeof value === "function") {
      return value;
    }
  }
  throw new Error(
    `released reader entry point not found in ${dist}: ${name}${marker ? ` (chunk marker ${marker})` : ""}`,
  );
}

// Every socket except this process's own fake upstream goes to the fake upstream:
// the release builds requests for its real base URLs, nothing leaves the machine,
// and no local service (such as a running Gateway) is reachable.
const captured: CapturedCall[] = [];
const ports = { http: 0, https: 0 };
type ConnectOptions = {
  host?: string;
  port?: number | string;
  servername?: string;
  socket?: unknown;
};
const connectOptions = (input: unknown[]): ConnectOptions =>
  typeof input[0] === "object" && input[0] !== null
    ? (input[0] as ConnectOptions)
    : { port: input[0] as number, host: typeof input[1] === "string" ? input[1] : undefined };
const isFakeUpstream = ({ host, port }: ConnectOptions) =>
  host === "127.0.0.1" && (Number(port) === ports.http || Number(port) === ports.https);
// Redirected TLS trusts only the fake upstream's self-signed certificate, pinned by
// fingerprint because the redirected socket keeps the vendor host name.
const fakeUpstreamCert = fs.readFileSync(args.cert);
const fakeUpstreamFingerprint = new crypto.X509Certificate(fakeUpstreamCert).fingerprint256;
const realNetConnect = net.connect;
const realTlsConnect = tls.connect;
const redirectNet = (...input: unknown[]) =>
  isFakeUpstream(connectOptions(input))
    ? Reflect.apply(realNetConnect, net, input)
    : realNetConnect({ host: "127.0.0.1", port: ports.http });
net.connect = redirectNet as typeof net.connect;
net.createConnection = redirectNet as typeof net.createConnection;
tls.connect = ((...input: unknown[]) => {
  const options = connectOptions(input);
  if (isFakeUpstream(options)) {
    return Reflect.apply(realTlsConnect, tls, input);
  }
  const { socket: _socket, ...rest } = options;
  const callback = input.find((value) => typeof value === "function") as (() => void) | undefined;
  return realTlsConnect(
    {
      ...rest,
      host: "127.0.0.1",
      port: ports.https,
      servername: options.servername ?? options.host,
      ca: fakeUpstreamCert,
      checkServerIdentity: (_host: string, peer: tls.PeerCertificate) =>
        peer.fingerprint256 === fakeUpstreamFingerprint
          ? undefined
          : new Error("redirected TLS reached a server other than the fake upstream"),
      ALPNProtocols: ["http/1.1"],
    },
    callback,
  );
}) as typeof tls.connect;

// Request and turn IDs come from randomUUID; number them per cell so the same
// request shape gives the same bytes in the baseline and candidate runs.
let uuidSequence = 0;
const sequentialUuid = () =>
  `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
crypto.randomUUID = sequentialUuid;
globalThis.crypto.randomUUID = sequentialUuid;
syncBuiltinESMExports();

function sse(res: http.ServerResponse, events: Array<[string | undefined, unknown]>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) {
    res.write(
      `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    );
  }
  res.end();
}

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const message = {
  type: "message",
  id: "msg_fake",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "ok", annotations: [] }],
};
function respond(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? "/";
  if (url.includes("/chat/completions")) {
    const chunk = {
      id: "chatcmpl_fake",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake",
    };
    return sse(res, [
      [
        undefined,
        {
          ...chunk,
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        },
      ],
      [
        undefined,
        {
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ],
      [undefined, "[DONE]"],
    ]);
  }
  if (url.includes("/responses")) {
    const response = { id: "resp_fake", object: "response", created_at: 0, model: "fake" };
    return sse(res, [
      [
        "response.created",
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      ],
      [
        "response.output_item.added",
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        },
      ],
      [
        "response.content_part.added",
        {
          type: "response.content_part.added",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
      ],
      [
        "response.output_text.delta",
        {
          type: "response.output_text.delta",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: "ok",
        },
      ],
      [
        "response.output_text.done",
        {
          type: "response.output_text.done",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          text: "ok",
        },
      ],
      [
        "response.output_item.done",
        { type: "response.output_item.done", output_index: 0, item: message },
      ],
      [
        "response.completed",
        {
          type: "response.completed",
          response: { ...response, status: "completed", output: [message], usage },
        },
      ],
    ]);
  }
  if (url.includes("/messages")) {
    return sse(res, [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model: "fake",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ],
      ["message_stop", { type: "message_stop" }],
    ]);
  }
  if (url.includes(":streamGenerateContent")) {
    return sse(res, [
      [
        undefined,
        {
          candidates: [
            { index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        },
      ],
    ]);
  }
  if (url.includes("/api/chat")) {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(
      `${JSON.stringify({ model: "fake", created_at: "1970-01-01T00:00:00Z", message: { role: "assistant", content: "ok" }, done: false })}\n`,
    );
    res.end(
      `${JSON.stringify({ model: "fake", created_at: "1970-01-01T00:00:00Z", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 })}\n`,
    );
    return;
  }
  if (req.method === "GET") {
    // Empty model listing; also an empty models.dev-style provider feed.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [] }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: { message: `catalog-compare fake upstream has no fake for ${req.method} ${url}` },
    }),
  );
}

function upstream(scheme: "http" | "https") {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      if (req.url === "/catalog.json" && req.headers.host === `127.0.0.1:${ports.http}`) {
        res.writeHead(200, { "content-type": "application/json" });
        fs.createReadStream(args.bundle).pipe(res);
        return;
      }
      const { "content-length": _length, host, ...headers } = req.headers;
      const text = Buffer.concat(parts).toString("utf8");
      let body: unknown = text || undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {}
      captured.push({
        method: req.method ?? "GET",
        url: `${scheme}://${host}${req.url}`,
        headers,
        body,
      });
      respond(req, res);
    });
  };
}

const plainServer = http.createServer(upstream("http"));
const tlsServer = https.createServer(
  { key: fs.readFileSync(args.key), cert: fs.readFileSync(args.cert) },
  upstream("https"),
);
for (const server of [plainServer, tlsServer]) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}
ports.http = (plainServer.address() as net.AddressInfo).port;
ports.https = (tlsServer.address() as net.AddressInfo).port;

type PluginManifest = {
  id: string;
  providers?: string[];
  setup?: { providers?: Array<{ envVars?: string[] }> };
};
const readManifests = (root: string) =>
  (fs.existsSync(root) ? fs.readdirSync(root) : []).flatMap((name) => {
    const file = path.join(root, name, "openclaw.plugin.json");
    return fs.existsSync(file)
      ? [
          {
            dir: path.join(root, name),
            ...(JSON.parse(fs.readFileSync(file, "utf8")) as PluginManifest),
          },
        ]
      : [];
  });
const externalManifests = readManifests(pluginScope);

// Synthetic keys make every provider count as signed in, as a user with its env var would.
for (const manifest of [...readManifests(path.join(dist, "extensions")), ...externalManifests]) {
  for (const provider of manifest.setup?.providers ?? []) {
    if (provider.envVars?.[0]) {
      process.env[provider.envVars[0]] = SYNTHETIC_KEY;
    }
  }
}

// Enable the installed external provider plugins that own a catalog provider, as
// `openclaw plugins install` would. Plugins for providers the catalog never names
// cannot change behavior, and some probe cloud credentials for minutes at load.
const catalogProviders = new Set(
  args.comparedBundles.flatMap((file) =>
    Object.keys(
      (JSON.parse(fs.readFileSync(file, "utf8")) as { providers?: object }).providers ?? {},
    ),
  ),
);
const externalPlugins = externalManifests.filter((manifest) =>
  manifest.providers?.some((provider) => catalogProviders.has(provider)),
);
const config = {
  models: { catalogRefresh: { url: `http://127.0.0.1:${ports.http}/catalog.json` } },
  plugins: {
    load: { paths: externalPlugins.map((plugin) => plugin.dir) },
    entries: Object.fromEntries(externalPlugins.map((plugin) => [plugin.id, { enabled: true }])),
  },
};

// The released readers this tool drives, typed as far as it uses them.
type Entry = { provider: string; id: string; cost?: unknown };
type ThinkingParams = {
  provider: string;
  model: string;
  catalog: Entry[];
  agentRuntime: string;
  providerPolicySource: "active";
};
type StreamResult = { stopReason?: string; errorMessage?: string };
type StreamFn = (
  model: Entry,
  context: unknown,
  options: unknown,
) => { result(): Promise<StreamResult> } | Promise<{ result(): Promise<StreamResult> }>;
type Readers = {
  refreshRemoteModelCatalog(params: {
    config: object;
    force: true;
  }): Promise<Record<string, unknown>>;
  prepareRemoteModelCatalogStartupSnapshot(): Promise<unknown>;
  loadManifestModelCatalog(params: { config: object }): Entry[];
  ensurePluginRegistryLoaded(params: { config: object; scope: "all" }): Promise<void>;
  captureRuntimeConfigAsyncReader(): () => Promise<unknown>;
  resolveThinkingProfile(params: ThinkingParams): { levels: Array<{ id: string }> };
  resolveThinkingDefaultForModel(params: ThinkingParams): string | undefined;
  resolveModelAsync(
    provider: string,
    modelId: string,
    agentDir: undefined,
    config: object,
    options: object,
  ): Promise<{ model?: Entry }>;
  registerProviderStreamForModel(params: object): StreamFn | undefined;
  applyExtraParamsToAgent(agent: { streamFn: StreamFn }, ...params: unknown[]): unknown;
  mapThinkingLevelForProvider(level: string, model: Entry): string;
  mapThinkingLevel(level: string): string | undefined;
};
const READERS: Array<[keyof Readers, string?]> = [
  ["refreshRemoteModelCatalog"],
  ["prepareRemoteModelCatalogStartupSnapshot"],
  ["loadManifestModelCatalog"],
  ["ensurePluginRegistryLoaded"],
  ["captureRuntimeConfigAsyncReader"],
  // Provider policy chunks declare their own resolveThinkingProfile.
  ["resolveThinkingProfile", "function resolveModelThinkingProfile("],
  ["resolveThinkingDefaultForModel"],
  ["resolveModelAsync"],
  ["registerProviderStreamForModel"],
  ["applyExtraParamsToAgent"],
  ["mapThinkingLevelForProvider"],
  ["mapThinkingLevel"],
];
const found: Partial<Record<keyof Readers, unknown>> = {};
for (const [name, marker] of READERS) {
  found[name] = await releasedExport(name, marker);
}
// SAFETY: each entry is the release's own function of that source name; released dist ships no types.
const reader = found as Readers;
const llm = (await import(pathToFileURL(path.join(dist, "plugin-sdk/llm.js")).href)) as {
  streamSimple: StreamFn;
};

// Load config the way a started process does; some request paths read the prepared snapshot.
fs.writeFileSync(configPath, JSON.stringify(config));
await reader.captureRuntimeConfigAsyncReader()();
// The release's own fetch, parse, minVersion and freshness rules decide what it accepts.
const refresh = await reader.refreshRemoteModelCatalog({ config, force: true });
await reader.prepareRemoteModelCatalogStartupSnapshot();
await reader.ensurePluginRegistryLoaded({ config, scope: "all" });
const [filterProvider, ...filterModel] = (args.filter ?? "").split("/");
const catalog = reader
  .loadManifestModelCatalog({ config })
  .filter(
    (entry) =>
      (!filterProvider || entry.provider === filterProvider) &&
      (filterModel.length === 0 || entry.id === filterModel.join("/")),
  );

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timed out")), REQUEST_TIMEOUT_MS).unref();
    }),
  ]);
}

// Bundled providers resolve through the release's model resolver. External
// provider plugins only resolve through live discovery, so their runtime model
// is the release's merged catalog row (the same row the resolver would enrich).
async function runtimeModel(entry: Entry): Promise<{ source: string; model: Entry }> {
  const resolved = await reader.resolveModelAsync(entry.provider, entry.id, undefined, config, {
    skipAgentDiscovery: true,
    allowBundledStaticCatalogFallback: true,
  });
  return resolved.model
    ? { source: "resolver", model: resolved.model }
    : {
        source: "catalog-row",
        model: {
          ...entry,
          cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      };
}

async function captureRequest(model: Entry, level: string) {
  const providerThinkingLevel = reader.mapThinkingLevelForProvider(level, model);
  const agent = {
    streamFn:
      reader.registerProviderStreamForModel({
        model,
        cfg: config,
        env: process.env,
        wrapProviderStream: true,
      }) ?? llm.streamSimple,
  };
  reader.applyExtraParamsToAgent(
    agent,
    config,
    model.provider,
    model.id,
    undefined,
    providerThinkingLevel,
    undefined,
    undefined,
    model,
    undefined,
    undefined,
    {},
  );
  uuidSequence = 0;
  const first = captured.length;
  let outcome: string;
  try {
    const stream = await agent.streamFn(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      {
        apiKey: SYNTHETIC_KEY,
        reasoning: reader.mapThinkingLevel(providerThinkingLevel),
        sessionId: SESSION_ID,
      },
    );
    const result = await withTimeout(stream.result());
    outcome = result.errorMessage
      ? `${result.stopReason}: ${result.errorMessage}`
      : String(result.stopReason);
  } catch (error) {
    outcome = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { calls: captured.slice(first), outcome };
}

const rows: RowObservation[] = [];
for (const entry of catalog) {
  const ref = `${entry.provider}/${entry.id}`;
  const profile = (runtime: "openclaw" | "codex") => {
    const params = {
      provider: entry.provider,
      model: entry.id,
      catalog: [entry],
      agentRuntime: runtime,
      providerPolicySource: "active" as const,
    };
    return {
      offered: reader.resolveThinkingProfile(params).levels.map((level) => level.id),
      default: reader.resolveThinkingDefaultForModel(params) ?? null,
    };
  };
  const row: RowObservation = {
    model: ref,
    profiles: { openclaw: profile("openclaw"), codex: profile("codex") },
    requests: {},
  };
  try {
    const { source, model } = await runtimeModel(entry);
    row.source = source;
    // Serialized with the run: the JSON projection drops runtime handles and functions.
    row.runtimeModel = model;
    // Codex builds its own upstream requests; only the OpenClaw runtime has a released request path.
    for (const level of row.profiles.openclaw.offered) {
      row.requests[level] = await captureRequest(model, level);
    }
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  }
  rows.push(row);
}

const version = (
  JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as { version: string }
).version;
const run: ReleaseRun = { version, refresh, rows };
fs.writeFileSync(args.out, JSON.stringify(run));
plainServer.close();
tlsServer.close();
// Released modules keep timers and workers alive; the result is already written.
process.exit(0);
