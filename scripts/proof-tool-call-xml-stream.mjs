// Run after pnpm build. Uses only a task-owned Gateway and loopback providers.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const label = option("--label", "candidate");
assert.match(label, /^[a-z0-9-]+$/);
const output = path.resolve(option("--output", `.artifacts/xml-stream-${label}`));
const scratch = path.resolve(option("--scratch", `/private/tmp/oc-lm-xml-stream/${label}`));
const port = Number(option("--port", "19900"));
const portClaim = createServer();
await new Promise((resolve, reject) => {
  portClaim.once("error", reject);
  portClaim.listen(port, "127.0.0.1", resolve);
});
await new Promise((resolve) => {
  portClaim.close(resolve);
});
const samples = Number(option("--samples", "5"));
const sourceChars = Number(option("--chars", "32768"));
const model = option("--model", "qwen2.5:7b");
const loadBefore = loadavg();
const withModel = process.argv.includes("--with-model");
const state = path.join(scratch, "state");
const workspace = path.join(scratch, "workspace");
for (const dir of [output, state, workspace, path.join(scratch, "tmp")]) {
  await mkdir(dir, { recursive: true });
}
const hash = (text) => createHash("sha256").update(text).digest("hex");
const toolCall =
  '<function_calls><invoke name="read_file"><parameter name="path">docs/readme.md</parameter></invoke></function_calls>';
const start = `Here is the call I made:\n${toolCall}\n\n`;
const control = '\n\n```xml\n<tool_call>{"name":"literal"}</tool_call>\n```';
const prose = Array.from(
  { length: 2000 },
  (_, n) =>
    `Synthetic paragraph ${n}: ordinary visible prose remains after a removed tool call.\n\n`,
).join("");
assert(sourceChars > start.length + control.length);
const source = start + prose.slice(0, sourceChars - start.length - control.length) + control;
const expected = source.replace(toolCall, "").trim();
const deltas = Array.from({ length: Math.ceil(source.length / 4) }, (_, n) =>
  source.slice(n * 4, n * 4 + 4),
);
const requests = [];
const localModelRequests = [];
const ollamaProxy = withModel
  ? createServer(async (request, response) => {
      let raw = "";
      for await (const bytes of request) {
        raw += bytes;
      }
      const body = raw ? JSON.parse(raw) : {};
      const record = {
        path: request.url,
        model: body.model,
        stream: body.stream,
        responseModels: [],
      };
      localModelRequests.push(record);
      try {
        const upstream = await fetch(`http://127.0.0.1:11434${request.url}`, {
          method: request.method,
          headers: { "content-type": "application/json" },
          ...(raw ? { body: raw } : {}),
          signal: AbortSignal.timeout(240000),
        });
        record.status = upstream.status;
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        let pending = "";
        for await (const bytes of upstream.body) {
          response.write(bytes);
          pending += Buffer.from(bytes).toString();
          const lines = pending.split("\n");
          pending = lines.pop();
          for (const line of lines) {
            try {
              const id = JSON.parse(line).model;
              if (typeof id === "string" && !record.responseModels.includes(id)) {
                record.responseModels.push(id);
              }
            } catch {}
          }
        }
        response.end();
      } catch (error) {
        record.error = String(error);
        response.writeHead(502).end("Local model proxy failed");
      }
    })
  : undefined;
if (ollamaProxy) {
  await new Promise((resolve, reject) => {
    ollamaProxy.once("error", reject);
    ollamaProxy.listen(0, "127.0.0.1", resolve);
  });
}
const provider = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        object: "list",
        data: [{ id: "xml-fixture", object: "model" }],
      }),
    );
    return;
  }
  let raw = "";
  for await (const bytes of request) {
    raw += bytes;
  }
  const body = raw ? JSON.parse(raw) : {};
  requests.push({
    path: request.url,
    stream: body.stream,
    model: body.model,
    chunks: deltas.length,
  });
  assert.equal(body.stream, true);
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: "xml-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "xml-fixture",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  emit({ role: "assistant", content: "" });
  for (const delta of deltas) {
    emit({ content: delta });
    await new Promise(setImmediate);
  }
  emit({}, "stop");
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(0, "127.0.0.1", resolve);
});
const modelRow = {
  id: "xml-fixture",
  name: "XML fixture",
  reasoning: false,
  input: ["text"],
  contextWindow: 32768,
  maxTokens: 24000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const configPath = path.join(state, "openclaw.json");
await writeFile(
  configPath,
  JSON.stringify(
    {
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "none" },
        controlUi: { enabled: false },
        http: { endpoints: { chatCompletions: { enabled: true } } },
      },
      agents: {
        ownership: "explicit",
        defaults: {
          workspace,
          skipBootstrap: true,
          contextInjection: "never",
          model: { primary: "fixture/xml-fixture" },
          thinkingDefault: "off",
          systemAgent: { agentId: "main" },
        },
        entries: { main: {} },
      },
      models: {
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
            api: "openai-completions",
            auth: "none",
            agentRuntime: { id: "openclaw" },
            models: [modelRow],
          },
          ...(withModel
            ? {
                ollama: {
                  baseUrl: `http://127.0.0.1:${ollamaProxy.address().port}`,
                  api: "ollama",
                  apiKey: "local-proof-placeholder",
                  agentRuntime: { id: "openclaw" },
                  models: [{ ...modelRow, id: model, name: model, maxTokens: 512 }],
                },
              }
            : {}),
        },
      },
      tools: { profile: "minimal", deny: ["*"], codeMode: false, toolSearch: false },
      plugins: { allow: [], slots: { memory: "none" } },
    },
    null,
    2,
  ),
);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const sourceDiffHash = hash(execFileSync("git", ["diff", "--", "src/shared/text"], { cwd: repo }));
const build = JSON.parse(await readFile(path.join(repo, "dist/build-info.json"), "utf8"));
const stamp = JSON.parse(await readFile(path.join(repo, "dist/.buildstamp"), "utf8"));
assert.equal(build.commit, head, "build must match the measured head");
assert.equal(stamp.head, head);
await writeFile(path.join(output, "buildstamp.json"), JSON.stringify(stamp, null, 2));
await writeFile(path.join(output, "source.txt"), source);
await writeFile(path.join(output, "expected.txt"), expected);
const command = [
  "pnpm",
  "openclaw",
  "--profile",
  "xml-stream",
  "gateway",
  "run",
  "--bind",
  "loopback",
  "--port",
  String(port),
];
const gateway = spawn(command[0], command.slice(1), {
  cwd: repo,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: "en_US.UTF-8",
    TMPDIR: path.join(scratch, "tmp"),
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_VITEST_RUNTIME: "node",
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    NO_COLOR: "1",
    npm_config_manage_package_manager_versions: "false",
    NODE_OPTIONS: `--import=${path.join(repo, "scripts/lib/tool-call-xml-proof-metrics.mjs")}`,
    OPENCLAW_XML_PROOF_METRICS: path.join(output, "metrics"),
  },
});
const log = (bytes) => appendFileSync(path.join(output, "gateway.log"), bytes);
gateway.stdout.on("data", log);
gateway.stderr.on("data", log);
let runtimePid;
const results = [];
const snapshot = async () => {
  const file = path.join(output, `metrics.${runtimePid}.json`);
  await rm(file, { force: true });
  process.kill(runtimePid, "SIGURG");
  for (let n = 0; n < 500; n++) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {}
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("Gateway metrics snapshot did not arrive");
};
const send = async (index, live = false) => {
  const before = await snapshot();
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(live ? { "x-openclaw-model": `ollama/${model}` } : {}),
    },
    body: JSON.stringify({
      model: "openclaw/default",
      user: `xml-proof-${label}-${index}`,
      stream: true,
      messages: [
        {
          role: "user",
          content: live
            ? "Reply with exactly LOCAL_MODEL_CONTROL_OK. Do not call tools or add explanation."
            : "Return the provided synthetic response exactly.",
        },
      ],
    }),
    signal: AbortSignal.timeout(240000),
  });
  const wire = await response.text();
  const elapsedMs = performance.now() - started;
  const after = await snapshot();
  await writeFile(path.join(output, `${index}-wire.txt`), wire);
  assert.equal(response.status, 200, wire.slice(0, 1000));
  let text = "";
  let frames = 0;
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") {
      continue;
    }
    const frame = JSON.parse(line.slice(6));
    assert(!frame.error, JSON.stringify(frame));
    text += frame.choices?.[0]?.delta?.content ?? "";
    frames++;
  }
  assert(wire.includes("data: [DONE]"));
  const functions = Object.fromEntries(
    Object.entries(after.functions).map(([name, value]) => [
      name,
      {
        calls: value.calls - before.functions[name].calls,
        inputChars: value.inputChars - before.functions[name].inputChars,
        maxInputChars: value.maxInputChars,
      },
    ]),
  );
  const result = {
    index,
    live,
    elapsedMs,
    cpuMs: (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000,
    frames,
    chars: text.length,
    hash: hash(text),
    matchesExpected: text === (live ? "LOCAL_MODEL_CONTROL_OK" : expected),
    functions,
  };
  results.push(result);
  await writeFile(path.join(output, `${index}-delivered.txt`), text);
  assert.equal(result.matchesExpected, true, `unexpected delivered text; see ${output}`);
  console.log(JSON.stringify(result));
};
try {
  const started = performance.now();
  while (true) {
    assert.equal(gateway.exitCode, null, `Gateway exited; see ${output}/gateway.log`);
    assert.equal(gateway.signalCode, null, `Gateway stopped; see ${output}/gateway.log`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
        break;
      }
    } catch {}
    assert(performance.now() - started < 600000, "Gateway startup exceeded 10 minutes");
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  runtimePid = Number(
    execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim(),
  );
  const initial = await snapshot();
  assert.equal(initial.node, "26.12.1");
  console.log(JSON.stringify({ gatewayReady: true, runtimePid, head }));
  await send("warmup");
  const warmed = await snapshot();
  assert(warmed.instrumentedModuleCount > 0, "built functions were not instrumented");
  assert(warmed.functions.stripToolCallXmlTagsInternal.calls > 0, "XML work was not observed");
  for (let i = 0; i < samples; i++) {
    await send(String(i));
  }
  if (withModel) {
    await send("local-model", true);
    assert(
      localModelRequests.some(
        (request) =>
          request.path === "/api/chat" &&
          request.model === model &&
          request.stream === true &&
          request.status === 200 &&
          request.responseModels.includes(model),
      ),
      "native Ollama model response was not observed",
    );
  }
} finally {
  try {
    process.kill(-gateway.pid, "SIGTERM");
  } catch {}
  if (gateway.exitCode === null && gateway.signalCode === null) {
    let exitTimer;
    await Promise.race([
      new Promise((resolve) => {
        gateway.once("exit", resolve);
      }),
      new Promise((resolve) => {
        exitTimer = setTimeout(resolve, 10000);
      }),
    ]);
    clearTimeout(exitTimer);
  }
  await new Promise((resolve) => {
    provider.close(resolve);
  });
  if (ollamaProxy) {
    await new Promise((resolve) => {
      ollamaProxy.close(resolve);
    });
  }
  const measured = results.filter((row) => row.index !== "warmup" && !row.live);
  const quantile = (key, q) =>
    measured.map((row) => row[key]).toSorted((a, b) => a - b)[Math.ceil(measured.length * q) - 1];
  const result = {
    label,
    head,
    sourceDiffHash,
    build,
    platform: process.platform,
    node: process.version,
    command,
    sourceChars,
    sourceHash: hash(source),
    providerDeltaChars: 4,
    providerDeltaCount: deltas.length,
    loadBefore,
    loadAfter: loadavg(),
    requests,
    localModelRequests,
    results,
    summary: {
      samples: measured.length,
      medianCpuMs: quantile("cpuMs", 0.5),
      p95CpuMs: quantile("cpuMs", 0.95),
      medianElapsedMs: quantile("elapsedMs", 0.5),
      p95ElapsedMs: quantile("elapsedMs", 0.95),
    },
    limitation:
      "Sequential baseline/candidate builds on macOS; full Gateway CPU includes incidental background work. Deterministic parser work counts are the primary performance evidence.",
  };
  await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
}
