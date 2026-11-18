// Isolated source-Gateway scale proof. No heap/deadline overrides; fixed loopback model only.
// Run with the selected checkout's scripts/tsx.mjs preload and --root.
// Establish an oracle with --tag base, then require --compare-prefix on paired runs.
// Raw summaries must match; followups allow only recorded workspace/root/clock differences.
// Keep --worker-trace diagnostic runs separate from acceptance timing samples.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
const here = fileURLToPath(import.meta.url);
const mode = ["gateway", "doctor"].includes(process.argv[2]) ? process.argv[2] : "proof";
const { values } = parseArgs({
  args: mode === "proof" ? process.argv.slice(2) : [],
  options: {
    root: { type: "string", default: process.cwd() },
    sizes: { type: "string", default: "40,150,575" },
    route: { type: "string", default: "auto" },
    output: { type: "string", default: path.resolve(".local/compaction-throughput") },
    "compare-prefix": { type: "string" },
    turns: { type: "string", default: "1" },
    "worker-trace": { type: "boolean", default: false },
    tag: { type: "string" },
    "allow-dirty": { type: "boolean", default: false },
    seed: {
      type: "string",
      default: path.join(path.dirname(here), "compaction-throughput-seed.cjs"),
    },
    "native-owner": {
      type: "string",
      default: path.resolve("dist/process/supervisor/service-child-group-anchor.js"),
    },
  },
});
const root = path.resolve(process.env.COMPACTION_SCALE_ROOT ?? values.root);
const importSource = (file) => import(pathToFileURL(path.join(root, file)).href);
const nativeOwner = process.env.COMPACTION_SCALE_NATIVE_OWNER ?? values["native-owner"];
// Linux process containment requires its existing built, loader-free owner; task source stays pinned.
(
  await importSource("src/process/supervisor/inherited-process-lineage.ts")
).bindInheritedNativeProcessOwner(pathToFileURL(nativeOwner).href);
if (mode === "gateway") {
  const file = path.join(root, "src/config/sessions/session-compaction-prepared.ts");
  const hydrationFile = path.join(root, "src/config/sessions/session-transcript-hydration.ts");
  const executionFile = path.join(
    root,
    "src/agents/embedded-agent-runner/compaction-session-execution.ts",
  );
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      if (
        process.env.COMPACTION_SCALE_WORKER_TRACE &&
        url === pathToFileURL(path.join(root, "src/infra/worker-task-host.ts")).href
      ) {
        const source = readFileSync(path.join(root, "src/infra/worker-task-host.ts"), "utf8");
        const needle =
          "const workerOptions = { execArgv: resolveRuntimeWorkerThreadExecArgv(url), ...options };";
        assert(source.includes(needle));
        return {
          ...loaded,
          format: "module-typescript",
          source: source.replace(
            needle,
            needle +
              `
if (String(url).includes('session-transcript.worker')) workerOptions.execArgv = [...(workerOptions.execArgv ?? []), '--import', ${JSON.stringify(path.join(path.dirname(here), "compaction-worker-trace.mjs"))}];`,
          ),
        };
      }
      if (url === pathToFileURL(executionFile).href) {
        const source = readFileSync(executionFile, "utf8");
        const name = "export async function executePreparedCompactionSession(";
        assert.equal(source.split(name).length, 2);
        return {
          ...loaded,
          format: "module-typescript",
          source:
            source.replace(name, "async function scaleExecutePreparedCompactionSession(") +
            `
export async function executePreparedCompactionSession(...args: Parameters<typeof scaleExecutePreparedCompactionSession>) {
  const start = performance.now(); const cpu = process.cpuUsage();
  let result;
  try { result = await scaleExecutePreparedCompactionSession(...args); return result; }
  finally { const used = process.cpuUsage(cpu); console.log("SCALE_COMPACTION_END", JSON.stringify({wallMs:performance.now()-start,cpuMs:(used.user+used.system)/1000,ok:result?.ok,compacted:result?.compacted})); }
}
`,
        };
      }
      if (url === pathToFileURL(hydrationFile).href) {
        const source = readFileSync(hydrationFile, "utf8");
        const name = "export function prepareSessionTranscriptHydration(";
        assert.equal(source.split(name).length, 2);
        return {
          ...loaded,
          format: "module-typescript",
          source:
            source.replace(name, "function scalePrepareSessionTranscriptHydration(") +
            `
export function prepareSessionTranscriptHydration(...args: Parameters<typeof scalePrepareSessionTranscriptHydration>) {
  const reader = scalePrepareSessionTranscriptHydration(...args); const read = reader.read;
  return {...reader, read: async (...options: Parameters<typeof read>) => {
    const start=performance.now(); const cpu=process.cpuUsage();
    const result=await read(...options); const used=process.cpuUsage(cpu);
    console.log("SCALE_HYDRATE_END",JSON.stringify({wallMs:performance.now()-start,cpuMs:(used.user+used.system)/1000,compaction:Boolean(args[1]?.compaction||options[0]?.compaction),events:result.snapshot.events.length}));
    return result;
  }};
}
`,
        };
      }
      if (url !== pathToFileURL(file).href) {
        return loaded;
      }
      const text = readFileSync(file, "utf8");
      const start = "  return withSessionTranscriptReadSource(";
      const end = "\n  );\n}";
      assert.equal(text.split(start).length, 2);
      assert.equal(text.split(end).length, 2);
      return {
        ...loaded,
        format: "module-typescript",
        source: text
          .replace(
            start,
            '  const scaleStarted = performance.now(); const scaleCpu=process.cpuUsage(); const cpuMs=()=>{const used=process.cpuUsage(scaleCpu);return (used.user+used.system)/1000;}; console.log("SCALE_PREPARE_START", JSON.stringify({operation:operation.kind,at:Date.now()}));\n' +
              start,
          )
          .replace(
            end,
            `\n  ).then(result => { console.log("SCALE_PREPARE_END", JSON.stringify({operation:operation.kind,wallMs:performance.now()-scaleStarted,cpuMs:cpuMs(),status:result.status,reads:result.reads})); return result; }, error => { console.log("SCALE_PREPARE_END", JSON.stringify({operation:operation.kind,wallMs:performance.now()-scaleStarted,cpuMs:cpuMs(),error:String(error)})); throw error; });\n}`,
          ),
      };
    },
  });
  const { startGatewayServer } = await importSource("src/gateway/server.ts");
  const server = await startGatewayServer(
    Number(process.argv[process.argv.indexOf("--port") + 1]),
    { bind: "loopback", controlUiEnabled: false },
  );
  process.once("SIGTERM", () => {
    void server.close({ reason: "scale proof complete" });
  });
} else if (mode === "doctor") {
  const { runDoctorSessionSqlite } = await importSource("src/commands/doctor-session-sqlite.ts");
  const { withDoctorSqliteMaintenanceLock } = await importSource(
    "src/commands/doctor-sqlite-maintenance-lock.ts",
  );
  const cfg = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  const report = await withDoctorSqliteMaintenanceLock({
    env: process.env,
    operation: "isolated scale fixture import",
    run: (authority) =>
      runDoctorSessionSqlite({ cfg, env: process.env, allAgents: true, mode: "import" }, authority),
  });
  console.log("SCALE_DOCTOR", JSON.stringify(report));
  assert.equal(report.totals.importedEntries, Number(process.env.COMPACTION_SCALE_TURNS ?? 1));
  assert.equal(report.totals.issues, 0);
  await (await importSource("src/state/openclaw-agent-db.ts")).closeOpenClawAgentDatabasesAsync();
  await (
    await importSource("src/state/openclaw-state-db-cache.ts")
  ).closeOpenClawStateDatabaseAsync();
} else {
  const { createOpenClawTestInstance } = await importSource(
    "test/helpers/openclaw-test-instance.ts",
  );
  const { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } = await importSource(
    "scripts/lib/gateway-bench-runtime.ts",
  );
  const { connectProofClient, listenLoopback, closeHttpServer } = await importSource(
    "test/helpers/gateway-integration-fixtures.ts",
  );
  const { runQaGatewayFixture } = await importSource("test/helpers/qa-gateway-cleanup.ts");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const trackedDiff = () =>
    execFileSync("git", ["diff", "HEAD", "--", "src", "packages"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  const productionDiff = () =>
    trackedDiff() +
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src", "packages"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((file) => `\nUNTRACKED ${file}\n${readFileSync(path.join(root, file), "utf8")}`)
      .join("");
  const initialDiff = productionDiff();
  if (!values["allow-dirty"]) {
    assert.equal(
      initialDiff,
      "",
      "Pin clean source, or freeze edits and explicitly use --allow-dirty with --tag",
    );
  }
  const sourceFingerprint = createHash("sha256").update(sha).update(initialDiff).digest("hex");
  const tag = values.tag ?? sha.slice(0, 8);
  assert(/^[a-zA-Z0-9_-]+$/.test(tag));
  const turns = Number(values.turns);
  assert(Number.isInteger(turns) && turns > 0 && turns <= 2);
  const sizes = values.sizes.split(",").map(Number);
  assert(sizes.every((x) => x > 0 && Number.isFinite(x)));
  assert(["auto", "manual"].includes(values.route));
  mkdirSync(values.output, { recursive: true });
  const marker = (status) =>
    writeFileSync(
      path.join(values.output, "compaction-throughput-scale-status.json"),
      JSON.stringify({ pid: process.pid, sha, root, at: new Date().toISOString(), ...status }) +
        "\n",
    );
  const summary =
    "## Decisions\n- Historical fixture inspections complete.\n## Open TODOs\n- Answer the latest user ask.\n## Constraints/Rules\n- Synthetic fixture.\n## Pending user asks\n- Continue.\n## Exact identifiers\n- scale-proof";
  for (const size of sizes) {
    const prefix = path.join(
      values.output,
      `compaction-throughput-scale-${tag}-${values.route}-${size}`,
    );
    const requests = [];
    const provider = createServer((request, response) => {
      void (async () => {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          assert(bytes < 8 * 1024 * 1024);
          chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks);
        writeFileSync(prefix + `-request-${requests.length}.json`, rawBody);
        const body = JSON.parse(rawBody.toString());
        const isSummary = /context summarization assistant/i.test(JSON.stringify(body.messages));
        let canonical = rawBody.toString();
        const normalization = [];
        if (!isSummary) {
          for (const [kind, value] of [
            ["workspace", workspaceDir],
            ["source-root", root],
          ]) {
            assert(value);
            const count = canonical.split(value).length - 1;
            if (count) {
              normalization.push({ kind, value, count });
              canonical = canonical.replaceAll(value, `<${kind}>`);
            }
          }
          canonical = canonical.replace(
            /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:PST|PDT)\] Conversation info: ⟦openclaw:ctx⟧/g,
            (value) => {
              normalization.push({ kind: "received-envelope-clock", value, count: 1 });
              return "<received-envelope-clock> Conversation info: ⟦openclaw:ctx⟧";
            },
          );
        }
        const canonicalFile = prefix + `-request-${requests.length}.canonical.json`;
        writeFileSync(canonicalFile, canonical);
        requests.push({
          bytes,
          isSummary,
          at: Date.now(),
          normalization,
          canonicalFile,
          rawSha256: createHash("sha256").update(rawBody).digest("hex"),
          canonicalSha256: createHash("sha256").update(canonical).digest("hex"),
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const choice of [
          {
            delta: { role: "assistant", content: isSummary ? summary : "Scale proof completed." },
            finish_reason: null,
          },
          { delta: {}, finish_reason: "stop" },
        ]) {
          response.write(
            `data: ${JSON.stringify({ id: "scale-proof", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      })().catch(
        /** @param {unknown} error */ (error) => {
          console.error(error);
          response.destroy();
        },
      );
    });
    const baseUrl = await listenLoopback(provider);
    const instance = await createOpenClawTestInstance({
      name: `compaction-throughput-${size}`,
      cwd: root,
      gatewayCommandPrefix: [process.execPath],
      entrypoint: ["--import", path.join(root, "scripts/tsx.mjs"), here],
      gracefulShutdownTimeoutMs: 5000,
      startTimeoutMs: 120000,
      config: {
        ...BASE_GATEWAY_BENCH_CONFIG,
        gateway: { ...BASE_GATEWAY_BENCH_CONFIG.gateway, auth: { mode: "token" } },
        plugins: { slots: { memory: "none" } },
        cron: { enabled: false },
        tools: { profile: "minimal" },
        agents: {
          defaults: {
            model: { primary: "scale/fixture" },
            models: { "scale/fixture": { agentRuntime: { id: "openclaw" } } },
            skipBootstrap: true,
            skills: [],
            contextPruning: { mode: "off" },
            compaction: {
              mode: "safeguard",
              model: "scale/fixture",
              keepRecentTokens: 2048,
              recentTurnsPreserve: 0,
              identifierPolicy: "off",
              qualityGuard: { enabled: false },
              postIndexSync: "off",
              memoryFlush: { enabled: false },
              maxActiveTranscriptBytes: 1024 * 1024,
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            scale: {
              baseUrl: `${baseUrl}/v1`,
              apiKey: "synthetic-no-secret",
              api: "openai-completions",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: "fixture",
                  name: "Synthetic fixture",
                  api: "openai-completions",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 2048,
                },
              ],
            },
          },
        },
      },
    });
    const workspaceDir = path.join(instance.homeDir, ".openclaw/workspace");
    const savedEnv = process.env;
    const safeEnv = createGatewayBenchEnv(instance.homeDir, instance.configPath, {
      startupTrace: false,
      caseEnv: {
        COMPACTION_SCALE_TURNS: String(turns),
        ...(values["worker-trace"]
          ? { COMPACTION_SCALE_WORKER_TRACE: prefix + "-worker-trace" }
          : {}),
        OPENCLAW_STATE_DIR: instance.stateDir,
        COMPACTION_SCALE_ROOT: root,
        COMPACTION_SCALE_NATIVE_OWNER: nativeOwner,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      },
    });
    for (const name of Object.keys(instance.env)) {
      delete instance.env[name];
    }
    Object.assign(instance.env, safeEnv);
    process.env = safeEnv;
    let client;
    try {
      marker({ status: "seeding", size });
      const seed = JSON.parse(
        execFileSync(
          process.execPath,
          [
            values.seed,
            instance.state.sessionsDir(),
            "agent:main:scale-proof",
            String(size),
            instance.state.workspaceDir,
          ],
          {
            env: { ...safeEnv, SEED: `compaction-throughput-${size}` },
            encoding: "utf8",
            timeout: 180000,
          },
        ),
      );
      const seeds = [seed];
      for (let turn = 1; turn < turns; turn++) {
        seeds.push(
          JSON.parse(
            execFileSync(
              process.execPath,
              [
                values.seed,
                instance.state.sessionsDir(),
                `agent:main:scale-proof-${turn + 1}`,
                String(size),
                instance.state.workspaceDir,
              ],
              {
                env: { ...safeEnv, SEED: `compaction-throughput-${size}-${turn + 1}` },
                encoding: "utf8",
                timeout: 180000,
              },
            ),
          ),
        );
      }
      const seedBytes = statSync(seed.file).size;
      console.log("SCALE_SEEDED", JSON.stringify({ size, seed, seedBytes }));
      marker({ status: "doctor-import", size });
      const importedAt = performance.now();
      const doctor = execFileSync(
        process.execPath,
        ["--import", path.join(root, "scripts/tsx.mjs"), here, "doctor"],
        { cwd: root, env: safeEnv, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
      );
      writeFileSync(prefix + "-doctor.log", doctor);
      const importMs = performance.now() - importedAt;
      marker({ status: "gateway-starting", size });
      const startupAt = performance.now();
      await instance.startGateway();
      client = await connectProofClient(instance, {
        scopes: ["operator.admin", "operator.read", "operator.write"],
        requestTimeoutMs: 120000,
      });
      const startupMs = performance.now() - startupAt;
      marker({ status: "timed-running", size, gatewayPid: instance.child?.pid });
      const hostLoad = () => ({
        at: new Date().toISOString(),
        loadavg: os.loadavg(),
        cpus: os.availableParallelism(),
        freeMemory: os.freemem(),
        totalMemory: os.totalmem(),
      });
      const loadBefore = hostLoad();
      const startAt = Date.now();
      let result;
      const results = [];
      for (let turn = 0; turn < turns; turn++) {
        const key = turn === 0 ? "agent:main:scale-proof" : `agent:main:scale-proof-${turn + 1}`;
        if (turn > 0) {
          await client.request("sessions.patch", {
            key,
            expectedSessionId: seeds[turn].sid,
            archived: false,
          });
        }
        if (values.route === "auto") {
          const accepted = await client.request("chat.send", {
            sessionKey: key,
            message: "Continue the synthetic task. Do not call tools.",
            idempotencyKey: randomUUID(),
          });
          result = await client.request(
            "agent.wait",
            { runId: accepted.runId, timeoutMs: 120000 },
            { timeoutMs: 125000 },
          );
        } else {
          result = await client.request("sessions.compact", { key }, { timeoutMs: 120000 });
        }
        results.push(result);
      }
      const routeMs = Date.now() - startAt;
      marker({ status: "timed-complete", size });
      const loadAfter = hostLoad();
      const logs = instance.logs();
      const preparation = [...logs.matchAll(/SCALE_PREPARE_END (\{[^\n]+\})/g)].map((m) =>
        JSON.parse(m[1]),
      );
      assert.equal(
        productionDiff(),
        initialDiff,
        "Production source changed during proof; discard timing",
      );
      assert.equal(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        sha,
      );
      const hydration = [...logs.matchAll(/SCALE_HYDRATE_END (\{[^\n]+\})/g)].map((m) =>
        JSON.parse(m[1]),
      );
      const compaction = [...logs.matchAll(/SCALE_COMPACTION_END (\{[^\n]+\})/g)].map((m) =>
        JSON.parse(m[1]),
      );
      assert.equal(compaction.length, turns);
      assert(
        compaction.every((outcome) => outcome.ok === true && outcome.compacted === true),
        "Compaction failed despite a successful foreground reply",
      );
      assert(preparation.every((operation) => !operation.error));
      assert.equal(requests.filter((request) => request.isSummary).length, turns * 2);
      if (values.route === "auto") {
        assert.equal(requests.filter((request) => !request.isSummary).length, turns);
      }
      const record = {
        harnessSha256: createHash("sha256").update(readFileSync(here)).digest("hex"),
        seedSha256: createHash("sha256").update(readFileSync(values.seed)).digest("hex"),
        loadBefore,
        loadAfter,
        sha,
        sourceFingerprint,
        hydration,
        compaction,
        root,
        nativeOwner,
        node: process.version,
        route: values.route,
        sizeMiB: size,
        seed,
        seeds,
        turns,
        seedBytes,
        importMs,
        startupMs,
        routeMs,
        preparation,
        requests: requests.map((r) => ({ ...r, fromRequestMs: r.at - startAt })),
        result,
        results,
      };
      writeFileSync(prefix + "-result.json", JSON.stringify(record, null, 2) + "\n");
      if (values["compare-prefix"]) {
        const expectedPrefix = values["compare-prefix"].replaceAll("{size}", String(size));
        const expected = JSON.parse(readFileSync(expectedPrefix + "-result.json", "utf8"));
        assert.equal(requests.length, expected.requests.length, "Request count changed");
        for (let index = 0; index < requests.length; index++) {
          assert.equal(
            requests[index].isSummary,
            expected.requests[index].isSummary,
            `Request ${index} kind changed`,
          );
          const suffix = `-request-${index}${requests[index].isSummary ? "" : ".canonical"}.json`;
          assert.deepEqual(
            readFileSync(prefix + suffix),
            readFileSync(expectedPrefix + suffix),
            `Request ${index} bytes differ (only explicit workspace/source-root/received-clock substitution allowed on followup)`,
          );
        }
        record.requestParity = {
          expectedPrefix,
          count: requests.length,
          summary: "raw-byte-equal",
          followup: "byte-equal-after-recorded-environment-substitutions",
        };
      }
      writeFileSync(prefix + "-result.json", JSON.stringify(record, null, 2) + "\n");
      console.log("SCALE_RESULT", JSON.stringify(record));
    } catch (error) {
      writeFileSync(prefix + "-failure.txt", String(error.stack ?? error) + "\n");
      console.error(instance.logs());
      throw error;
    } finally {
      writeFileSync(prefix + "-gateway.log", instance.logs());
      try {
        await runQaGatewayFixture(
          async () => {},
          () => client?.stopAndWait(),
          () => instance.cleanup(),
          () => closeHttpServer(provider),
        );
      } finally {
        process.env = savedEnv;
        marker({ status: "idle", size });
      }
    }
  }
}
