/**
 * Synthetic built-product request proof. No external provider/channel calls.
 * Usage: node scripts/perf/message-tool-availability.mjs --build <installed-build>
 *   --state <fresh-state-path> --out <fresh-evidence-path> --route internal|none|external-webchat|configured
 * Stage BASE and FIX at the same installation path and reuse the same fresh
 * state path between editions; installation paths appear in provider prompts.
 * Recovery means process reentry with persisted session facts, not a Gateway restart.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const self = fileURLToPath(import.meta.url);
const { values: args } = parseArgs({
  options: {
    build: { type: "string" },
    state: { type: "string" },
    out: { type: "string" },
    route: { type: "string", default: "internal" },
    "unbound-sender": { type: "boolean" },
    stage: { type: "string" },
    worker: { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (args.help) {
  console.log(
    "Usage: node scripts/perf/message-tool-availability.mjs --build <build> --state <fresh-path> --out <fresh-path> --route internal|none|external-webchat|configured",
  );
  process.exit(0);
}
assert(args.build && args.state && args.out, "--build, --state and --out are required; see --help");
const stages = [
  "normal",
  "source-only",
  "normal-again",
  "internal-wake",
  "recovery",
  "normal-after-recovery",
];
const model = "fixture-model";
const prompt = "Reply SYNTHETIC_DONE without using tools.";

async function built(root, name) {
  for (const file of await fs.readdir(path.join(root, "dist"))) {
    if (!file.endsWith(".mjs")) {
      continue;
    }
    const source = await fs.readFile(path.join(root, "dist", file), "utf8");
    if (!source.includes(name)) {
      continue;
    }
    const exports = [...source.matchAll(/export \{([^}]+)\}/g)].at(-1)?.[1];
    const field = exports
      ?.split(",")
      .map((value) => value.trim())
      .find((value) => value === name || value.startsWith(name + " as "));
    if (field) {
      return (await import(pathToFileURL(path.join(root, "dist", file)).href))[
        field === name ? name : field.slice(name.length + 4)
      ];
    }
  }
  throw new Error("Built export unavailable: " + name);
}

async function worker() {
  const { build, state, stage, route } = args;
  const config = JSON.parse(await fs.readFile(path.join(state, "openclaw.json"), "utf8"));
  const Scheduler = await built(build, "GatewayScheduler");
  const scheduler = new Scheduler();
  await (
    await built(build, "setSessionMcpRuntimeScheduler")
  )(scheduler);
  (await built(build, "setRuntimeConfigSnapshot"))(config);
  const internal = route !== "none";
  const sessionKey = internal ? "agent:main:dashboard:matrix" : "agent:main:isolated:matrix";
  const sessionId = "synthetic-matrix-session";
  const child = "agent:main:subagent:matrix-child";
  const storePath = path.join(state, "agents/main/sessions/sessions.json");
  // Host ingress loads its session writer before taking runtime capabilities.
  // Keep that boot surface identical for operator, completion and recovery inputs.
  const replace = await built(build, "replaceSessionEntry");
  if (stage === "normal") {
    const external = route === "external-webchat";
    const delivery = external
      ? (await built(build, "normalizeSessionDeliveryState"))({
          context: { channel: "telegram", to: "telegram:owner" },
          origin: { provider: "telegram", to: "telegram:owner", chatType: "direct" },
        })
      : { kind: internal ? "internal" : "none" };
    const entry = { sessionId, updatedAt: 1, delivery };
    const metadata = internal
      ? (await built(build, "deriveSessionMetaPatch"))({
          sessionKey,
          existing: entry,
          ctx: {
            Provider: "webchat",
            Surface: "webchat",
            OriginatingChannel: external ? "telegram" : "webchat",
            GatewayClientCaps: [],
          },
        })
      : {};
    await replace({ agentId: "main", sessionKey, storePath }, { ...entry, ...metadata });
    await replace(
      { agentId: "main", sessionKey: child, storePath },
      {
        sessionId: "synthetic-child",
        updatedAt: 1,
        spawnedBy: sessionKey,
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["*"],
        inheritedToolDeny: [],
      },
    );
  }
  const recorded = await (
    await built(build, "readSessionEntryReadOnlyInWorker")
  )({ agentId: "main", sessionKey, storePath, projection: "list" });
  assert(recorded?.delivery, "The fixture lost its session-owned presentation facts");
  const admission = (await built(build, "prepareSystemAgentRunAdmission"))(
    config,
    "synthetic-" + stage,
    "main",
    "synthetic-message-matrix",
  );
  const outcomes = [];
  const params = {
    config,
    agentId: "main",
    agentDir: path.join(state, "agents/main/agent"),
    sessionKey,
    sessionId,
    workspaceDir: config.agents.defaults.workspace,
    provider: "anthropic",
    model,
    prompt,
    runId: "synthetic-" + stage,
    timeoutMs: 60000,
    preparedRunAdmission: admission,
    sessionPromptDelivery: recorded.delivery,
    messageProvider: internal ? "webchat" : undefined,
    messageChannel: internal ? "webchat" : undefined,
    currentChannelId: sessionKey,
    currentMessagingTarget: sessionKey,
    senderIsOwner: false,
    sourceReplyDeliveryMode: "automatic",
    oneShotCliRun: true,
    cleanupBundleMcpOnRunEnd: true,
    onAgentToolResult: (event) => outcomes.push(event),
  };
  if (stage === "source-only") {
    const registration = {
      sourceSessionKey: child,
      sourceSessionId: "synthetic-child",
      targetSessionKey: sessionKey,
      targetSessionId: sessionId,
      idempotencyKey: "synthetic-handoff",
    };
    const handoffId = (await built(build, "registerSubagentCompletionToolHandoff"))(registration);
    params.trustedInternalHandoff = (await built(build, "consumeSubagentCompletionToolHandoff"))({
      ...registration,
      handoffId,
      sourceTool: "subagent_announce",
      provider: "anthropic",
      model,
    });
    assert(params.trustedInternalHandoff);
    params.inputProvenance = {
      kind: "inter_session",
      sourceChannel: "internal",
      sourceSessionKey: child,
      sourceTool: "subagent_announce",
    };
    params.sourceReplyDeliveryMode = "message_tool_only";
    params.forceMessageTool = true;
  } else if (stage === "internal-wake" || stage === "recovery") {
    params.inputProvenance =
      stage === "recovery"
        ? { kind: "internal_system", sourceTool: "main_session_restart_recovery" }
        : {
            kind: "inter_session",
            sourceChannel: "internal",
            sourceSessionKey: child,
            sourceTool: "subagent_settle",
          };
    params.trigger = "event";
    params.messageProvider = params.messageChannel = "webchat";
  }
  try {
    const result = await (await built(build, "runEmbeddedAgent"))(params);
    await fs.writeFile(
      path.join(args.out, "result.json"),
      JSON.stringify({ result, outcomes }, null, 2),
    );
  } finally {
    admission.close();
    await (
      await built(build, "disposeAllSessionMcpRuntimes")
    )();
    scheduler.beginClose();
    await scheduler.stop();
    await (
      await built(build, "closeOpenClawAgentDatabasesAsync")
    )();
  }
}

async function runChild(argv, env, output) {
  const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [],
    stderr = [];
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await fs.writeFile(path.join(output, "stdout.log"), Buffer.concat(stdout));
  await fs.writeFile(path.join(output, "stderr.log"), Buffer.concat(stderr));
  assert.equal(code, 0, "Product child failed; inspect stderr.log");
}

const digest = (value) => createHash("sha256").update(value).digest("hex");

// Count the received JSON spans, not JSON.stringify projections of parsed data.
function rawArraySpan(raw, key) {
  const text = raw.toString("utf8");
  const match = new RegExp('"' + key + '"\\s*:\\s*').exec(text);
  assert(match, "Missing provider field " + key);
  const start = match.index + match[0].length;
  assert.equal(text[start], "[");
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === "[" || char === "{") {
      depth++;
    } else if ((char === "]" || char === "}") && --depth === 0) {
      return Buffer.from(text.slice(start, index + 1));
    }
  }
  throw new Error("Incomplete provider field " + key);
}

async function summarize(output, stage, requests) {
  const raw = await fs.readFile(path.join(output, "request-1.json"));
  const request = JSON.parse(raw);
  const follow = JSON.parse(await fs.readFile(path.join(output, "request-2.json"), "utf8"));
  const current = follow.messages.findLast(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_result"),
  );
  assert(current, "Current provider continuation lost its tool results");
  const results = current.content.filter((block) => block.type === "tool_result");
  const decoded = results.map((block) => {
    const text =
      typeof block.content === "string"
        ? block.content
        : block.content.map((part) => part.text || "").join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  });
  const inventory = decoded.find((value) => value?.value?.listing)?.value;
  assert(inventory, "The actual Code Mode result did not contain its catalog");
  const catalog = inventory.listing.files.map((file) => file.path.slice(6, -5));
  const direct = request.tools.map((tool) => tool.name);
  const message = request.tools.find((tool) => tool.name === "message");
  const doc = inventory.message?.content || "";
  const union = /action\??:\s*((?:"[^"]+"\s*\|?\s*)+)/.exec(doc);
  const system = rawArraySpan(raw, "system"),
    tools = rawArraySpan(raw, "tools");
  return {
    stage,
    requests,
    rawBytes: raw.length,
    rawHash: digest(raw),
    systemBytes: system.length,
    toolsBytes: tools.length,
    toolsHash: digest(tools),
    systemTextHash: digest(JSON.stringify(request.system.map((block) => block.text))),
    direct,
    catalog,
    deferred: catalog.filter((name) => name !== "message" || !direct.includes(name)),
    messageActions: message?.input_schema.properties.action.enum || [],
    catalogMessageActions: union
      ? [...union[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
      : [],
    toolCalls: results.length,
    rejected: results.filter((block) => block.is_error).map((block) => block.content),
  };
}

async function main() {
  const build = path.resolve(args.build),
    state = path.resolve(args.state),
    out = path.resolve(args.out);
  const route = args.route || "internal";
  assert(["internal", "none", "external-webchat", "configured"].includes(route));
  for (const dir of [state, out]) {
    await assert.rejects(fs.access(dir));
    await fs.mkdir(dir, { recursive: true });
  }
  const workspace = path.join(state, "workspace");
  await fs.mkdir(workspace);
  const config = {
    models: {
      mode: "replace",
      providers: {
        anthropic: {
          baseUrl: "http://127.0.0.1:19691",
          apiKey: "synthetic-fixture",
          api: "anthropic-messages",
          models: [
            {
              id: model,
              name: "Synthetic fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    agents: {
      defaults: { model: { primary: "anthropic/" + model }, workspace, skipBootstrap: true },
      entries: { main: {} },
    },
    plugins: { slots: { memory: "none" } },
    browser: { enabled: false },
    cron: { enabled: false },
    tools: { codeMode: true, toolSearch: false },
  };
  if (route === "configured") {
    const plugin = path.join(state, "plugin");
    await fs.mkdir(plugin);
    await fs.writeFile(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "synthetic-outbound-fixture",
        version: "0.0.0",
        type: "module",
        openclaw: { extensions: ["./index.mjs"] },
      }),
    );
    await fs.writeFile(
      path.join(plugin, "openclaw.plugin.json"),
      JSON.stringify({
        id: "fixture-message",
        channels: ["fixture-message"],
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    await fs.writeFile(
      path.join(plugin, "index.mjs"),
      'import fs from "node:fs";export default {id:"fixture-message",register(api){api.registerChannel({plugin:{id:"fixture-message",meta:{id:"fixture-message",label:"Synthetic outbound",selectionLabel:"Synthetic outbound",docsPath:"/channels/fixture",blurb:"Synthetic fixture"},capabilities:{chatTypes:["direct"]},config:{listAccountIds:()=>["default"],resolveAccount:()=>({enabled:true}),isConfigured:()=>true},messaging:{normalizeTarget:x=>x==="synthetic-recipient"?x:undefined,targetResolver:{looksLikeId:x=>x==="synthetic-recipient"}},outbound:{deliveryMode:"direct",resolveTarget:({to})=>({ok:true,to}),sendText:async()=>{fs.appendFileSync(process.env.MATRIX_RECEIPT_PATH,JSON.stringify({messageId:"synthetic-receipt"})+String.fromCharCode(10));return{channel:"fixture-message",messageId:"synthetic-receipt"}}}}})}};',
    );
    config.channels = { "fixture-message": { enabled: true } };
    if (args["unbound-sender"]) {
      config.bindings = [{ agentId: "main", match: { channel: "telegram" } }];
      config.channels.telegram = { enabled: false };
    }
    config.plugins = {
      allow: ["fixture-message"],
      slots: { memory: "none" },
      load: { paths: [plugin] },
      entries: { "fixture-message": { enabled: true } },
    };
  }
  const configPath = path.join(state, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.writeFile(path.join(out, "config.json"), JSON.stringify(config));
  const selected = route === "configured" ? ["normal"] : stages;
  const rows = [];
  for (const stage of selected) {
    const output = path.join(out, stage);
    await fs.mkdir(output);
    let requests = 0;
    let requestError;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (data) => chunks.push(data));
      const respond = async () => {
        const raw = Buffer.concat(chunks);
        const n = ++requests;
        await fs.writeFile(path.join(output, "request-" + n + ".json"), raw);
        const request = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (name, data) =>
          res.write("event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n");
        event("message_start", {
          type: "message_start",
          message: {
            id: "msg_fixture_" + stage.replaceAll("-", "") + "_" + n,
            type: "message",
            role: "assistant",
            model: request.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        const calls =
          n === 1
            ? [
                {
                  name: "exec",
                  input: {
                    code: 'const listing=await API.list("tools/"); return {listing,message:listing.files.some(f=>f.path==="tools/message.d.ts")?await API.read("tools/message.d.ts"):null};',
                    title: "Inspect synthetic catalog",
                    awaitResults: true,
                  },
                },
              ]
            : [];
        if (n === 1 && stage === "source-only" && route !== "none") {
          for (const input of [
            {
              action: "send",
              channel: "webchat",
              target: "wrong-target",
              message: "Synthetic negative",
            },
            { action: "broadcast", targets: ["wrong-target"], message: "Synthetic negative" },
            { action: "react", emoji: "✅" },
          ]) {
            calls.push({ name: "message", input });
          }
        }
        if (
          n === 1 &&
          route === "configured" &&
          request.tools.some((tool) => tool.name === "message")
        ) {
          calls.push({
            name: "message",
            input: {
              action: "send",
              channel: "fixture-message",
              target: "synthetic-recipient",
              message: "Synthetic outbound receipt",
              final: false,
            },
          });
        }
        const blocks = calls.length ? calls : [{ text: "SYNTHETIC_DONE" }];
        blocks.forEach((block, index) => {
          event("content_block_start", {
            type: "content_block_start",
            index,
            content_block: block.name
              ? {
                  type: "tool_use",
                  id: "toolu_fixture_" + stage.replaceAll("-", "") + "_" + index,
                  name: block.name,
                  input: {},
                }
              : { type: "text", text: "" },
          });
          event("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: block.name
              ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
              : { type: "text_delta", text: block.text },
          });
          event("content_block_stop", { type: "content_block_stop", index });
        });
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        event("message_stop", { type: "message_stop" });
        res.end();
      };
      req.on("end", () => {
        void respond().catch((/** @type {unknown} */ error) => {
          requestError = error;
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(19691, "127.0.0.1", resolve);
    });
    const env = {
      PATH: process.env.PATH,
      HOME: path.join(state, "home"),
      LANG: "C.UTF-8",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      MATRIX_RECEIPT_PATH: path.join(out, "adapter-receipts.log"),
      CI: "1",
    };
    for (const key of ["TMPDIR", "TMP", "TEMP"]) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    try {
      await runChild(
        route === "configured"
          ? [
              path.join(build, "openclaw.mjs"),
              "agent",
              "--local",
              "--session-key",
              "agent:main:isolated:matrix",
              "--message",
              prompt,
              "--model",
              "anthropic/" + model,
              "--timeout",
              "90",
              "--json",
            ]
          : [
              self,
              "--worker",
              "--build",
              build,
              "--state",
              state,
              "--out",
              output,
              "--stage",
              stage,
              "--route",
              route,
            ],
        env,
        output,
      );
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
    assert.equal(requestError, undefined, "Synthetic provider response failed");
    assert.equal(requests, 2, "Expected inventory/controls, then final response");
    rows.push(await summarize(output, stage, requests));
  }
  await fs.writeFile(path.join(out, "summary.json"), JSON.stringify(rows, null, 2));
  assert(
    rows.every((row) => row.toolsHash === rows[0].toolsHash),
    "Tool definitions changed across internal turns",
  );
  assert(
    rows.every((row) => row.systemTextHash === rows[0].systemTextHash),
    "System text changed across internal turns",
  );
  if (route === "configured") {
    assert.equal(
      (await fs.readFile(path.join(out, "adapter-receipts.log"), "utf8")).trim().split("\n").length,
      1,
    );
  }
  await fs.writeFile(
    path.join(out, "workload.json"),
    JSON.stringify(
      {
        build,
        state,
        route,
        stages: selected,
        fixture: true,
        realDelivery: false,
        workloadSha256: digest(await fs.readFile(self)),
      },
      null,
      2,
    ),
  );
}

await (args.worker ? worker() : main());
if (args.worker) {
  process.exit(0);
}
