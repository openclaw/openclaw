/**
 * Synthetic attempt preparation through the real skills, tool-base, bootstrap,
 * bundle and system-prompt owners; no provider requests or live Gateway state.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/turn-preparation-measure.mjs \
 *   --root .local/turn-preparation-2128 --iterations 20 --files 62000 --plugins 64
 * Use the identical fixture and command on both heads; alternate at least five
 * pairs, with same-head A/A controls. Acceptance: exact bytes; no metric
 * regression over 20%, and owner CPU/allocation gains exceed A/A variation. Run --allocation separately from timing.
 * Setup is excluded. Each cohort's first turn is reported separately from warm.
 * This is owner composition, not Gateway end-to-end or a btrfs/35-GiB database claim.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    iterations: { type: "string", default: "20" },
    files: { type: "string", default: "62000" },
    plugins: { type: "string", default: "64" },
    sessions: { type: "string", default: "5000" },
    history: { type: "string", default: "2000" },
    "fixture-only": { type: "boolean" },
    allocation: { type: "boolean" },
    keep: { type: "boolean" },
  },
});
assert(values.root && global.gc, "--root and --expose-gc are required");
const root = path.resolve(values.root);
const iterations = Number(values.iterations),
  fileCount = Number(values.files),
  pluginCount = Number(values.plugins);
const sessionCount = Number(values.sessions),
  historyCount = Number(values.history);
for (const count of [iterations, fileCount, pluginCount, sessionCount, historyCount]) {
  assert(Number.isSafeInteger(count) && count > 0);
}
const fixtureReceipt = path.join(root, "fixture-ready.json");
let existingFixture;
try {
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(
    fixtureReceipt,
    JSON.stringify({
      kind: "openclaw-turn-preparation-fixture",
      version: 1,
      fileCount,
      ready: false,
    }),
  );
} catch (error) {
  if (error.code !== "EEXIST") {
    throw error;
  }
  existingFixture = JSON.parse(await fs.readFile(fixtureReceipt, "utf8"));
  assert.equal(
    existingFixture.kind,
    "openclaw-turn-preparation-fixture",
    "Refusing an unowned root",
  );
  assert.equal(existingFixture.version, 1);
  assert.equal(existingFixture.fileCount, fileCount);
}
const stateDir = path.join(root, "state"),
  workspace = path.join(root, "workspace");
// A failed setup must not carry a prior transcript into the next comparison arm.
await fs.rm(stateDir, { recursive: true, force: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(workspace, { recursive: true });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
process.env.OPENCLAW_LOG_LEVEL = "trace";
const payload = "Synthetic workspace payload; no private source or user data.\n".repeat(320);
if (!existingFixture?.ready) {
  for (let offset = 0; offset < fileCount; offset += 16) {
    await Promise.all(
      Array.from({ length: Math.min(16, fileCount - offset) }, async (_, n) => {
        const index = offset + n;
        const directory = path.join(workspace, "synthetic", String(Math.floor(index / 1000)));
        await fs.mkdir(directory, { recursive: true });
        const target = path.join(directory, `file-${index}.txt`);
        try {
          await fs.writeFile(target, payload, { flag: "wx" });
        } catch (error) {
          if (error.code !== "EEXIST") {
            throw error;
          }
        }
      }),
    );
  }
}
for (const name of ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md"]) {
  await fs.writeFile(
    path.join(workspace, name),
    `# Synthetic ${name}\n${"Preserve exact fixture instructions.\n".repeat(200)}`,
  );
}
for (let i = 0; i < 100; i++) {
  const directory = path.join(workspace, "skills", `synthetic-${i}`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: synthetic-${i}\ndescription: Read synthetic fixture evidence ${i}.\n---\nRead and report the synthetic evidence.\n`,
  );
}
const ids = Array.from(
  { length: pluginCount },
  (_, i) => `synthetic-${String(i).padStart(3, "0")}`,
);
const pluginPaths = [];
for (const id of ids) {
  const directory = path.join(root, "plugins", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { tools: [`${id}_read`] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const filename = path.join(directory, "index.cjs");
  await fs.writeFile(
    filename,
    `module.exports = { id: ${JSON.stringify(id)}, register(api) {
    api.registerTool({ contextVersion: 2, create(ctx) { return {
      name: ${JSON.stringify(`${id}_read`)}, label: 'Synthetic read', description: 'Read synthetic fixture evidence.',
      parameters: { type:'object', properties: { query: {type:'string'} } },
      async execute() { ctx.assertInvocationCurrent(); return {content:[{type:'text',text:'Synthetic evidence.'}],details:{}}; }
    }; } }, {names:[${JSON.stringify(`${id}_read`)}],workspaceAccess:false});
  } };`,
  );
  pluginPaths.push(filename);
}
const serverPath = path.join(root, "mcp-server.mjs");
const mcpTools = Array.from({ length: 80 }, (_, i) => ({
  name: `probe_${i}`,
  description: "Read synthetic evidence.",
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 20 }, (_field, n) => [
        `field_${n}`,
        { type: "object", properties: { value: { type: "string" }, enabled: { type: "boolean" } } },
      ]),
    ),
  },
}));
await fs.writeFile(
  serverPath,
  `import { createInterface } from 'node:readline';
const tools = ${JSON.stringify(mcpTools)};
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 const message=JSON.parse(line); let result;
 if(message.method==='initialize') result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}};
 if(message.method==='tools/list') result={tools};
 if(message.method==='tools/call') result={content:[{type:'text',text:'Synthetic evidence.'}]};
 if(result) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
}); process.stdin.on('end',()=>process.exit(0));`,
);
await fs.writeFile(
  fixtureReceipt,
  JSON.stringify({ kind: "openclaw-turn-preparation-fixture", version: 1, fileCount, ready: true }),
);
const { createSandboxFsBridge } = await import("../../src/agents/sandbox/fs-bridge.js");
const config = {
  agents: {
    ownership: "explicit",
    defaults: { workspace, model: { primary: "openai/synthetic-model" } },
    entries: { main: { workspace } },
  },
  plugins: {
    allow: ids,
    load: { paths: pluginPaths },
    entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
    slots: { memory: "none" },
  },
  skills: { allowBundled: [], load: { watch: false } },
  mcp: { servers: { synthetic: { command: process.execPath, args: [serverPath] } } },
  tools: { profile: "full" },
  gateway: { publicOrigin: "https://synthetic.invalid" },
};
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
console.error(`Fixture ready: ${workspace}`);
if (values["fixture-only"]) {
  process.exit(0);
}
const [
  { setRuntimeConfigSnapshot },
  { loadPreparedModelRuntimeSnapshot },
  { prepareSystemAgentRunAdmission },
  { prepareEmbeddedSkills },
  { prepareEmbeddedAttemptToolBase },
  { prepareEmbeddedAttemptBootstrap },
  { prepareEmbeddedAttemptBundleTools },
  { prepareEmbeddedAttemptSystemPrompt },
  { createAttemptSetupFixture },
  { createSandboxTestContext },
  { withDiagnosticsTimelineObserver },
  { cleanupSessionStateForTest },
  { getPreparedModelRuntimeAuthStore },
  { clearAgentRunContext },
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/agents/prepared-model-runtime.js"),
  import("../../src/agents/admitted-run-context.js"),
  import("../../src/agents/embedded-agent-runner/skill-runtime.js"),
  import("../../src/agents/embedded-agent-runner/run/attempt-tool-prepare.js"),
  import("../../src/agents/embedded-agent-runner/run/attempt-bootstrap-prepare.js"),
  import("../../src/agents/embedded-agent-runner/run/attempt-bundle-tools.js"),
  import("../../src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.js"),
  import("../../src/agents/embedded-agent-runner/run/attempt-setup.test-support.js"),
  import("../../src/agents/sandbox/test-fixtures.js"),
  import("../../src/infra/diagnostics-timeline.js"),
  import("../../src/test-utils/session-state-cleanup.js"),
  import("../../src/agents/prepared-model-runtime-auth.js"),
  import("../../src/infra/agent-run-registry.js"),
]);
const schemaOwnerUrl = new URL(
  "../../packages/ai/src/providers/agent-tools-parameter-schema.ts",
  import.meta.url,
);
const schemaOwner = await import(schemaOwnerUrl.href);
const schemaAlias = await import("@openclaw/ai/internal/tool-schema");
assert.equal(
  schemaAlias.normalizeToolParameterSchema,
  schemaOwner.normalizeToolParameterSchema,
  "Tool schema package must resolve this measured checkout's source",
);
const schemaOwnerSha256 = createHash("sha256")
  .update(await fs.readFile(schemaOwnerUrl))
  .digest("hex");
setRuntimeConfigSnapshot(config);
const agentDir = path.join(stateDir, "agents", "main", "agent");
console.error("Preparation imports ready");
const preparedModelRuntime = await loadPreparedModelRuntimeSnapshot({
  config,
  agentId: "main",
  agentDir,
  workspaceDir: workspace,
  loadRuntimePlugins: true,
  skipCredentials: true,
});
console.error("Prepared runtime ready");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { setSessionMcpRuntimeScheduler, disposeAllSessionMcpRuntimes } =
  await import("../../src/agents/agent-bundle-mcp-manager-api.js");
const scheduler = new GatewayScheduler();
await setSessionMcpRuntimeScheduler(scheduler);
const model = {
  id: "synthetic-model",
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const { runOpenClawAgentWriteTransaction } = await import("../../src/state/openclaw-agent-db.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const { loadSessionEntryForAdmission } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-admission.js");
const { createReplyOperation } = await import("../../src/sessions/session-controller.operation.js");
const { bindReplyAdmissionRelease } =
  await import("../../src/auto-reply/reply/reply-turn-admission-lifecycle.js");
let storePath;
runOpenClawAgentWriteTransaction(
  (database) => {
    storePath = database.path;
    for (let i = 0; i < sessionCount; i++) {
      writeSessionEntry(database, `agent:main:synthetic-archived-${i}`, {
        sessionId: `archived-${i}`,
        updatedAt: 1,
        status: "done",
      });
    }
    for (const sessionId of ["host", "sandboxed"]) {
      writeSessionEntry(database, `agent:main:synthetic-${sessionId}`, {
        sessionId,
        updatedAt: 1,
        lifecycleRevision: `fixture-${sessionId}`,
      });
    }
  },
  { agentId: "main", env: process.env },
);
const managers = [];
for (const sessionId of ["host", "sandboxed"]) {
  const manager = await SessionManager.openAsync(
    { agentId: "main", sessionId, sessionKey: `agent:main:synthetic-${sessionId}`, storePath },
    workspace,
  );
  for (let i = 0; i < historyCount; i++) {
    await manager.appendMessageAsync({
      role: "user",
      content: `Synthetic history ${i}. ${"History context. ".repeat(128)}`,
      timestamp: i + 1,
    });
  }
  managers.push(manager);
}
console.error("Session fixture ready");
const inspector = new Session();
const output = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
try {
  for (const sandboxed of [false, true]) {
    const sessionId = sandboxed ? "sandboxed" : "host";
    const sessionKey = `agent:main:synthetic-${sessionId}`;
    const sandbox = sandboxed
      ? createSandboxTestContext({
          overrides: { sessionKey, workspaceDir: workspace, agentWorkspaceDir: workspace },
        })
      : null;
    if (sandbox) {
      sandbox.backend = {
        id: "synthetic",
        runtimeId: "synthetic",
        runtimeLabel: "Synthetic",
        workdir: "/workspace",
        buildExecSpec: async () => {
          throw new Error("Preparation must not execute sandbox commands");
        },
        runShellCommand: async () => {
          throw new Error("Preparation must not execute sandbox commands");
        },
      };
      sandbox.fsBridge = createSandboxFsBridge({ sandbox });
    }
    const setup = createAttemptSetupFixture({
      effectiveCwd: workspace,
      effectiveWorkspace: workspace,
      resolvedWorkspace: workspace,
      sessionAgentId: "main",
      sandbox,
      sandboxSessionKey: sessionKey,
      sandboxReport: { mode: sandboxed ? "all" : "off", sandboxed },
      getCurrentAttemptPluginMetadataSnapshot: () => preparedModelRuntime.metadataSnapshot,
      getProviderRuntimeHandle: () => ({
        provider: model.provider,
        modelId: model.id,
        workspaceDir: workspace,
        prepared: true,
      }),
    });
    let skillsSnapshot, promptBytes, toolBytes;
    for (let turn = 0; turn <= iterations; turn++) {
      const runId = `synthetic-${sessionId}-${turn}`;
      const admission = prepareSystemAgentRunAdmission(
        config,
        runId,
        "main",
        "turn-preparation-benchmark",
      );
      const { databaseClaim } = await loadSessionEntryForAdmission({
        agentId: "main",
        sessionKey,
        env: process.env,
      });
      const replyOperation = createReplyOperation({
        sessionId,
        sessionKey,
        resetTriggered: false,
        turnKind: "direct",
      });
      bindReplyAdmissionRelease({
        operation: replyOperation,
        admission: undefined,
        databaseClaim,
        sessionId,
        sessionKey,
      });
      let skills, base, bundle;
      const stages = [];
      const measure = async (name, run) => {
        if (values.allocation) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpu = process.threadCpuUsage(),
          processCpu = process.cpuUsage(),
          started = performance.now();
        const result = await run();
        const wallMs = performance.now() - started,
          used = process.threadCpuUsage(cpu),
          total = process.cpuUsage(processCpu);
        const sampledBytes = values.allocation
          ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
              (sum, sample) => sum + sample.size,
              0,
            )
          : undefined;
        stages.push({
          name,
          wallMs,
          sampledBytes,
          cpuMs: (used.user + used.system) / 1000,
          processCpuMs: (total.user + total.system) / 1000,
        });
        return result;
      };
      try {
        const runAbortController = new AbortController();
        const attempt = {
          config,
          agentId: "main",
          agentDir,
          sessionId,
          sessionKey,
          runId,
          workspaceDir: workspace,
          prompt: "Read synthetic evidence.",
          timeoutMs: 30000,
          replyOperation,
          sessionTarget: { agentId: "main", sessionId, sessionKey, storePath },
          sessionFile: path.join(root, `${sessionId}.sqlite`),
          model,
          provider: model.provider,
          modelId: model.id,
          thinkLevel: "off",
          ...preparedModelRuntime.createStores(),
          authProfileStore: getPreparedModelRuntimeAuthStore(preparedModelRuntime),
          preparedModelRuntime,
          admittedRunContext: await admission.admit("embedded"),
          abortSignal: runAbortController.signal,
          skillsSnapshot,
        };
        global.gc();
        const hostLoadBefore = loadavg();
        if (values.allocation) {
          inspector.connect();
        }
        await withDiagnosticsTimelineObserver(
          (name, _attributes, durationMs) => {
            if (durationMs !== undefined) {
              stages.push({ name, wallMs: durationMs });
              return undefined;
            }
            const started = performance.now();
            return () => stages.push({ name, wallMs: performance.now() - started });
          },
          async () => {
            skills = await measure("skills", () =>
              prepareEmbeddedSkills({
                attempt,
                effectiveWorkspace: workspace,
                sandbox,
                sessionAgentId: "main",
                includeCodeModeSkills: true,
                applySkillEnvironment: false,
              }),
            );
            skillsSnapshot = skills.skillsSnapshotForRun;
            base = await measure("tool-base", () =>
              prepareEmbeddedAttemptToolBase({
                agentDir,
                attempt,
                setup,
                markCoreToolStage() {},
                onYield() {},
                runAbortController,
                ...skills,
                skillsSnapshot: skills.skillsSnapshotForRun,
                toolSearchCatalogExecutor: async () => {
                  throw new Error("Fixture must not execute catalog tools");
                },
              }),
            );
            const bootstrap = await measure("bootstrap", () =>
              prepareEmbeddedAttemptBootstrap({
                attempt,
                setup,
                hasReadTool: base.toolsRaw.some((tool) => tool.name === "read"),
                isRawModelRun: false,
              }),
            );
            bundle = await measure("bundle-tools", () =>
              prepareEmbeddedAttemptBundleTools({
                agentDir,
                attempt,
                setup,
                isRawModelRun: false,
                preparedToolBase: base,
              }),
            );
            const prompt = await measure("system-prompt", () =>
              prepareEmbeddedAttemptSystemPrompt({
                activeContextEngine: undefined,
                referencePaths: { docsPath: null, sourcePath: null },
                attempt,
                setup,
                bootstrap,
                capabilityToolNames: new Set(
                  bundle.uncompactedEffectiveTools.map((tool) => tool.name),
                ),
                effectiveTools: bundle.uncompactedEffectiveTools,
                isRawModelRun: false,
                modelToolsEnabled: true,
                skillsPrompt: skills.skillsPrompt,
                toolSearchDirectoryEnabled: false,
                toolSearchRuntimeConfig: config,
              }),
            );
            const currentTools = JSON.stringify(
              bundle.uncompactedEffectiveTools.map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
              })),
            );
            promptBytes ??= prompt.systemPromptText;
            toolBytes ??= currentTools;
            assert.equal(
              prompt.systemPromptText,
              promptBytes,
              "unchanged prompt bytes across turns",
            );
            assert.equal(currentTools, toolBytes, "unchanged tool definitions across turns");
            assert(
              bundle.uncompactedEffectiveTools.length >= pluginCount + 80,
              "real factories and MCP catalog reached bundling",
            );
          },
        );
        if (values.allocation) {
          inspector.disconnect();
        }
        const sampledBytes = values.allocation
          ? stages.reduce((sum, stage) => sum + (stage.sampledBytes ?? 0), 0)
          : undefined;
        output.push({
          sandboxed,
          turn,
          first: turn === 0,
          stages,
          sampledBytes,
          promptHash: hash(promptBytes),
          toolsHash: hash(toolBytes),
          tools: bundle.uncompactedEffectiveTools.length,
          skills: skills.installedSkills.length,
          hostLoadBefore,
          hostLoadAfter: loadavg(),
          memory: process.memoryUsage(),
        });
      } finally {
        await bundle?.bundleMcpRuntime?.dispose();
        await bundle?.bundleLspRuntime?.dispose();
        await base?.releaseTools("complete");
        skills?.restoreSkillEnv();
        admission.close();
        clearAgentRunContext(runId);
        replyOperation.complete();
        await replyOperation.ownerSettlement;
        await databaseClaim.release();
      }
    }
  }
  console.log(
    JSON.stringify({
      node: process.version,
      schemaOwnerUrl: schemaOwnerUrl.href,
      schemaOwnerSha256,
      fileCount,
      sessionCount,
      historyCount,
      databaseBytes: (await fs.stat(storePath)).size,
      fixtureBytes: fileCount * Buffer.byteLength(payload),
      pluginCount,
      mode: values.allocation ? "allocation" : "timing",
      output,
    }),
  );
} finally {
  inspector.disconnect();
  await disposeAllSessionMcpRuntimes();
  await scheduler.stop();
  await cleanupSessionStateForTest({ stateDir });
  await fs.rm(stateDir, { recursive: true, force: true });
  if (!values.keep) {
    await fs.rm(root, { recursive: true, force: true });
  }
}
