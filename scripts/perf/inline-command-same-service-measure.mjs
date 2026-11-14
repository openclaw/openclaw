// Targeted same-service UX/resource proof. Production source/builds remain untouched.
// Reuses the existing native512 workload and Gateway/pairing/cleanup/resource owners.
// Required: --comparison-plan <json> --candidate <path> --candidate-source <commit> --candidate-tree <tree> --output <path>.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { registerSealedRuntimeProcessEntrypoints } from "../../src/infra/runtime-process-url.ts";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.ts";
import { prepareGatewayMatrixProcessOwner } from "../lib/code-mode-matrix-process-owner.ts";
import { installSameServiceBrowserProbe } from "./inline-command-same-service-browser-probe.mjs";
import { createSameServiceNativeProvider } from "./inline-command-same-service-native-provider.mjs";

const { values } = parseArgs({
  options: {
    candidate: { type: "string" },
    "candidate-source": { type: "string" },
    "candidate-tree": { type: "string" },
    output: { type: "string" },
    turns: { type: "string", default: "12" },
    "execution-seconds": { type: "string", default: "1200" },
    "comparison-plan": { type: "string" },
    "only-cell": { type: "string" },
    "minimum-cell-seconds": { type: "string", default: "0" },
    "post-active-idle-seconds": { type: "string" },
  },
});
assert(values["comparison-plan"], "--comparison-plan must declare the pinned comparison");
const comparisonBytes = await readFile(values["comparison-plan"]);
const comparisonPlan = JSON.parse(comparisonBytes.toString());
for (const required of ["candidate", "output", "candidate-source", "candidate-tree"]) {
  assert(values[required], `Missing --${required}`);
}
assert.equal(process.platform, "linux", "Use the authorized isolated Linux guest");
const turns = Number(values.turns);
assert(Number.isInteger(turns) && turns >= 6 && turns <= 360, "Bounded turns per service: 6–360");
const executionSeconds = Number(values["execution-seconds"]);
assert(Number.isInteger(executionSeconds) && executionSeconds >= 180 && executionSeconds <= 14400);
const minimumCellSeconds = Number(values["minimum-cell-seconds"]);
const postActiveIdleSeconds = Number(values["post-active-idle-seconds"] ?? "60");
assert(
  Number.isInteger(minimumCellSeconds) && minimumCellSeconds >= 0 && minimumCellSeconds <= 3600,
);
assert(
  Number.isInteger(postActiveIdleSeconds) &&
    postActiveIdleSeconds >= 0 &&
    postActiveIdleSeconds <= 300,
);
const executionDeadline = performance.now() + executionSeconds * 1000;
const checkDeadline = () =>
  assert(
    performance.now() < executionDeadline,
    "Bounded execution deadline reached; preserve partial proof",
  );
const sourceRoot = path.resolve(values.candidate);
const sourceImport = (file) => import(pathToFileURL(path.join(sourceRoot, file)).href);
const { chromium } = createRequire(path.join(sourceRoot, "package.json"))("playwright");
const { acquireGatewayTestClient } = await sourceImport("test/helpers/gateway-client.ts");
const { runQaGatewayFixture } = await sourceImport("test/helpers/qa-gateway-cleanup.ts");
const { pairControlUiPage } = await sourceImport(
  "ui/src/test-helpers/control-ui-browser-pairing.ts",
);
const { createControlUiE2eArtifactDir } = await sourceImport(
  "ui/src/test-helpers/control-ui-e2e-artifacts.ts",
);
const {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  resolvePlaywrightChromiumExecutablePath,
} = await sourceImport("ui/src/test-helpers/control-ui-e2e.ts");
const { readGatewayMemory } = await sourceImport("scripts/lib/gateway-bench-probes.ts");
const { readProcessCgroupV2Snapshot, readProcessMemoryCapacity } = await sourceImport(
  "scripts/lib/process-memory.mts",
);
const root = createControlUiE2eArtifactDir("inline-same-service", values.output);
const json = (name, value) => writeFile(path.join(root, name), JSON.stringify(value, null, 2));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const providerId = "inline-native-fixture";
const modelId = "gpt-5.4";
const producer = path.join(sourceRoot, "scripts/perf/inline-command-native-producer.mjs");
const declaredCells = (await import("./inline-command-opt-in-analysis.mjs")).comparisonPlanCells(
  comparisonPlan,
  {
    cwd: sourceRoot,
    source: values["candidate-source"],
    tree: values["candidate-tree"],
  },
);
const cells = values["only-cell"]
  ? declaredCells.filter((cell) => cell.label === values["only-cell"])
  : declaredCells;
assert(cells.length > 0, "Selected cell must exist in the declared comparison");
assert(
  executionSeconds >= cells.length * (minimumCellSeconds + postActiveIdleSeconds + 60) + 120,
  "Execution bound must include selected cell cycles, recovery and startup/settlement runway",
);
for (const cell of cells) {
  cell.commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: cell.cwd,
    encoding: "utf8",
  }).trim();
  const html = await readFile(path.join(cell.cwd, "dist/control-ui/index.html"));
  cell.indexSha256 = sha(html);
  cell.runtimeBuild = JSON.parse(
    await readFile(path.join(cell.cwd, "dist/build-info.json"), "utf8"),
  );
  cell.runtimeEntrySha256 = sha(await readFile(path.join(cell.cwd, "dist/index.js")));
  cell.sourceCommit = cell.source;
  assert.equal(cell.commit, cell.sourceCommit, "checkout must match the selected exact source");
  cell.liveOutputExpected = cell.inline;
  cell.tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: cell.cwd,
    encoding: "utf8",
  }).trim();
  assert.equal(cell.tree, comparisonPlan.cells.find((entry) => entry.label === cell.label).tree);
  if (cell.role === "candidate") {
    assert.equal(
      cell.tree,
      values["candidate-tree"],
      "candidate transport tree must equal reviewed source tree",
    );
  }
  assert.equal(
    cell.runtimeBuild.commit,
    cell.sourceCommit,
    "Gateway runtime must identify selected original source",
  );
  cell.build = JSON.parse(
    html.toString().match(/globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su)[1],
  );
  assert.equal(
    cell.build.commit,
    cell.sourceCommit,
    "UI build must identify selected original source",
  );
  const require = createRequire(path.join(cell.cwd, "extensions/codex/package.json"));
  const codexPackage = require.resolve("@openai/codex/package.json");
  cell.codexVersion = JSON.parse(await readFile(codexPackage, "utf8")).version;
  assert.equal(cell.codexVersion, "0.164.0", "all revisions must use the pinned native binary");
  cell.launcher = path.join(path.dirname(codexPackage), "bin/codex.js");
  cell.launcherSha256 = sha(await readFile(cell.launcher));
  assert.equal(process.arch, "x64", "This workload pins the Linux x64 native package");
  const nativeRequire = createRequire(codexPackage);
  cell.binary = path.join(
    path.dirname(nativeRequire.resolve("@openai/codex-linux-x64/package.json")),
    "vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  cell.binarySha256 = sha(await readFile(cell.binary));
  cell.nativeVersion = execFileSync(cell.launcher, ["--version"], { encoding: "utf8" }).trim();
  assert(cell.nativeVersion.includes(cell.codexVersion));
}
for (const cell of cells) {
  assert.equal(cell.launcherSha256, cells[0].launcherSha256);
  assert.equal(cell.binarySha256, cells[0].binarySha256);
}

// The source-loaded driver needs the built kernel owner, shared across all cells.
// Loading the owner through tsx would invalidate its exclusive child-wait contract.
registerSealedRuntimeProcessEntrypoints(
  "serviceChildRelay",
  await prepareGatewayMatrixProcessOwner(path.resolve(values.candidate), root),
);

function resources() {
  return {
    at: new Date().toISOString(),
    load: os.loadavg(),
    cpus: os.availableParallelism(),
    memory: readProcessMemoryCapacity({}),
    cgroup: readProcessCgroupV2Snapshot(),
    affinity: readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/mu)?.[1],
    limits: readFileSync("/proc/self/limits", "utf8"),
    cgroupMembership: readFileSync("/proc/self/cgroup", "utf8"),
    cgroupMounts: readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .filter((line) => line.includes(" - cgroup2 ")),
    cpu: readFileSync("/proc/stat", "utf8").split("\n")[0],
  };
}

const admissionBefore = resources();
await delay(6000);
const admissionAfter = resources();
assert(admissionAfter.cpus >= 2 && admissionAfter.memory.limitBytes >= 4 * 1024 ** 3);
const toolingName = path.basename(fileURLToPath(import.meta.url));
const toolingDirectory = path.dirname(fileURLToPath(import.meta.url));
const toolingPrefix = toolingName.replace(/measure\.mjs$/u, "");
const toolingFiles = [
  toolingName,
  `${toolingPrefix}native-provider.mjs`,
  `${toolingPrefix}browser-probe.mjs`,
  "../../test/helpers/openclaw-test-process.ts",
  "../../test/helpers/openclaw-test-instance.ts",
  "../../src/infra/runtime-process-url.ts",
  "../lib/code-mode-matrix-process-owner.ts",
  "inline-command-opt-in-analysis.mjs",
];
const toolingHashes = Object.fromEntries(
  await Promise.all(
    toolingFiles.map(async (file) => [
      file,
      sha(await readFile(path.join(toolingDirectory, file))),
    ]),
  ),
);
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
const browserCdp = await browser.newBrowserCDPSession().catch(async (error) => {
  await browser.close();
  throw error;
});
try {
  const tickHz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  const metric = async (cdp) =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]),
    );
  const waitForFile = async (filename) => {
    const deadline = performance.now() + 60000;
    while (!existsSync(filename)) {
      checkDeadline();
      assert(performance.now() < deadline, `Missing native producer boundary: ${filename}`);
      await delay(10);
    }
  };
  const readProc = (pid) => {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw
      .slice(raw.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/u);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rss = /^VmRSS:\s+(\d+)/mu.exec(status);
    return {
      pid,
      raw,
      rssKiB: rss ? Number(rss[1]) : null,
      childrenCpuMs: ((Number(fields[13]) + Number(fields[14])) / tickHz) * 1000,
      cpuMs: ((Number(fields[11]) + Number(fields[12])) / tickHz) * 1000,
      startTicks: fields[19],
      cgroupMembership: readFileSync(`/proc/${pid}/cgroup`, "utf8"),
      status,
    };
  };
  const readGatewayTree = (rootPid, commandPid, browserPid) => {
    assert(Number.isInteger(rootPid) && rootPid > 0, "Gateway custody root is required");
    // Existing proof needs live native-process RSS as well as the Gateway isolate.
    // PIDs/parentage only: never capture unrelated command lines or environments.
    const children = new Map();
    for (const line of execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
      .trim()
      .split("\n")) {
      const [pid, parent] = line.trim().split(/\s+/u).map(Number);
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
    }
    const descendants = (startPid) => {
      const selected = new Set();
      const pending = [startPid];
      while (pending.length) {
        const pid = pending.pop();
        if (!selected.has(pid)) {
          selected.add(pid);
          pending.push(...(children.get(pid) ?? []));
        }
      }
      return selected;
    };
    const custodyPids = descendants(rootPid);
    const commandPids = descendants(commandPid);
    const browserPids = browserPid ? descendants(browserPid) : new Set();
    const selected = [];
    for (const pid of new Set([...custodyPids, ...browserPids])) {
      try {
        selected.push(readProc(pid));
      } catch (error) {
        if (
          pid !== rootPid &&
          pid !== browserPid &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        ) {
          selected.push({ pid, exitedDuringSnapshot: true });
        } else {
          throw error;
        }
      }
    }
    // One inventory covers custody/browser helpers while retaining command-only attribution.
    return {
      commandTree: selected.filter((entry) => commandPids.has(entry.pid)),
      custodyTree: selected.filter((entry) => custodyPids.has(entry.pid)),
      browserTree: selected.filter((entry) => browserPids.has(entry.pid)),
    };
  };
  const summaries = [];
  const failures = [];
  await json("plan.json", {
    kind: "bounded-same-service-product-risk-proof",
    qualification: false,
    cells,
    turns,
    executionSeconds,
    comparisonContract: {
      id: comparisonPlan.contractId,
      planSha256: sha(comparisonBytes),
      declaredCells: comparisonPlan.cells,
      selectedCell: values["only-cell"] ?? null,
      minimumCellSeconds,
      turnCap: turns,
      postActiveIdleSeconds,
      requiredExecutionRunwaySeconds:
        cells.length * (minimumCellSeconds + postActiveIdleSeconds + 60) + 120,
      qualification: false,
    },
    toolingHashes,
    perTurnWorkload: { writes: 512, bytesPerWrite: 4096, intervalMs: 20 },
    producerSha256: sha(await readFile(producer)),
    admissionBefore,
    admissionAfter,
    browser: { version: browser.version(), executablePath },
    tickHz,
    boundary:
      "Real Gateway, Codex native shell and production WebUI; deterministic inference only. One Gateway/session/page per cell, repeated turns, no restart/reload/forced GC.",
    observation:
      "One lifetime trusted input/wheel listener set and an observation-only WebSocket listener; one rAF reads compact preview only. No consumer/context/render instrumentation. Observer CPU recorded; observation overhead is not assumed zero.",
    metrics:
      "Input capture and frame opportunities, trusted wheel outcomes, continuous mounted preview progress and accepted-frame-to-next-observed-preview age, natural heap/RSS/CPU trends. Callback gaps and natural endpoint heap alone do not decide product readiness.",
    comparators:
      "Explicit pinned upstream and same-source candidate grouped/inline. Optional original control remains an independent anchor; absent historical measurements are not zero. Grouped preview is N/A.",
  });
  for (const cell of cells) {
    checkDeadline();
    const cellDir = path.join(root, cell.label);
    await mkdir(cellDir);
    const turnDirs = Array.from({ length: turns }, (_, turn) =>
      path.join(cellDir, `turn-${String(turn).padStart(2, "0")}`),
    );
    for (const dir of turnDirs) {
      await mkdir(dir);
    }
    const provider = await createSameServiceNativeProvider({
      sourceImport,
      turns,
      commandForTurn: (turn) =>
        [process.execPath, producer, turnDirs[turn]].map(shellQuote).join(" "),
    });
    let instance, client, context, page, cdp;
    const errors = [];
    const turnReceipts = [];
    const checkpoints = [];
    const cellStartedAt = performance.now();
    const lifecycleBefore = resources();
    let gatewayPid;
    const resourcePoint = async (phase, turn) => {
      assert.equal(instance.child.pid, gatewayPid, "Gateway identity stable for complete sequence");
      const memory = await readGatewayMemory(
        (method, params) => client.request(method, params),
        cellStartedAt,
      );
      const processInfo = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo;
      const browserRootPid = processInfo.find((entry) => entry.type === "browser")?.id;
      const transport = await page.evaluate(() => window.sameServiceProbe.facts());
      const atMs = performance.now();
      const gateway = readProc(gatewayPid);
      const { commandTree, custodyTree, browserTree } = readGatewayTree(
        instance.child.memoryRootPid,
        gatewayPid,
        browserRootPid,
      );
      const osProcesses = new Map(
        [...custodyTree, ...browserTree].map((entry) => [entry.pid, entry]),
      );
      const browserProcesses = processInfo.map((entry) => {
        try {
          return Object.assign({}, entry, {
            proc: osProcesses.get(entry.id) ?? readProc(entry.id),
          });
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ESRCH") {
            return Object.assign({}, entry, { exitedDuringSnapshot: true });
          }
          throw error;
        }
      });
      const point = {
        phase,
        turn,
        transport,
        atMs,
        gateway,
        gatewayTree: commandTree,
        memory,
        renderer: await metric(cdp),
        browserProcesses,
        resources: resources(),
      };

      const productProcesses = [
        ...custodyTree,
        ...browserTree,
        ...browserProcesses.map(
          (entry) =>
            entry.proc ?? {
              pid: entry.id,
              exitedDuringSnapshot: true,
            },
        ),
      ];
      const missingProcesses = productProcesses
        .filter((entry) => !entry.startTicks || !Number.isFinite(entry.rssKiB))
        .map(({ pid, startTicks, exitedDuringSnapshot }) => ({
          pid,
          startTicks,
          exitedDuringSnapshot: exitedDuringSnapshot === true,
        }));
      const commandCovered = commandTree.some((entry) => entry.pid === gatewayPid);
      const identities = [
        ...new Map(
          productProcesses
            .filter((entry) => entry.startTicks && Number.isFinite(entry.rssKiB))
            .map((entry) => [`${entry.pid}:${entry.startTicks}`, entry]),
        ).values(),
      ].map(({ pid, startTicks, rssKiB }) => ({ pid, startTicks, rssKiB }));
      const browserCovered = browserProcesses.some(
        (entry) =>
          entry.type === "browser" && browserTree.some((observed) => observed.pid === entry.id),
      );
      const identitiesStable =
        new Set(identities.map((entry) => entry.pid)).size === identities.length;
      const complete =
        commandCovered && browserCovered && identitiesStable && missingProcesses.length === 0;
      point.processAccounting = {
        gatewayCustodyRootPid: instance.child.memoryRootPid,
        gatewayCustodyTree: custodyTree,
        browserRootPid: browserRootPid ?? null,
        browserOsTree: browserTree,
        productRss: {
          complete,
          commandCovered,
          browserCovered,
          identitiesStable,
          missingProcesses,
          identities,
          rssKiB: complete ? identities.reduce((sum, entry) => sum + entry.rssKiB, 0) : null,
        },
        gatewayLiveTreeCpuMs: point.gatewayTree.reduce((sum, entry) => sum + (entry.cpuMs ?? 0), 0),
        gatewayLiveTreeRssKiB: point.gatewayTree.reduce(
          (sum, entry) => sum + (entry.rssKiB ?? 0),
          0,
        ),
        gatewayRootReapedChildrenCpuMs: point.gateway.childrenCpuMs,
        browserLiveProcessesCpuSeconds: browserProcesses.reduce(
          (sum, entry) => sum + entry.cpuTime,
          0,
        ),
        browserLiveProcessesRssKiB: browserProcesses.reduce(
          (sum, entry) => sum + (entry.proc?.rssKiB ?? 0),
          0,
        ),
        driverCpuUsage: process.cpuUsage(),
        driverMemoryUsage: process.memoryUsage(),
        completeForExitedChildren: false,
        interpretation:
          "Command-root CPU and CDP process facts retain historical attribution. Product RSS counts the custody-root Gateway/native tree, browser OS tree and CDP-only PID/start identities once; missing observations make its total unknown. Driver/provider/probe memory is separate. RSS can double-count shared pages; live PID CPU misses exited children.",
      };

      checkpoints.push(point);
      await writeFile(
        path.join(cellDir, "resource-checkpoints.json"),
        JSON.stringify(checkpoints, null, 2),
      );
      return point;
    };
    const settlementPhases = [];
    const settled = (name, action) => async () => {
      const entry = { name, startedAtMs: performance.now() };
      settlementPhases.push(entry);
      try {
        await action();
        entry.status = "settled";
      } catch (error) {
        entry.status = "failed";
        entry.error = String(error);
        throw error;
      } finally {
        entry.endedAtMs = performance.now();
      }
    };
    await runQaGatewayFixture(
      async () => {
        try {
          instance = await createOpenClawTestInstance({
            name: cell.label,
            cwd: cell.cwd,
            entrypoint: ["dist/index.js"],
            env: {
              VITEST: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              OPENCLAW_SKIP_PROVIDERS: undefined,
              OPENAI_API_KEY: undefined,
              CODEX_API_KEY: undefined,
              CODEX_ACCESS_TOKEN: undefined,
            },
            config: {
              gateway: { controlUi: { enabled: true } },
              cron: { enabled: false },
              browser: { enabled: false },
              update: { checkOnStart: false },
              models: {
                mode: "replace",
                catalogRefresh: { enabled: false },
                providers: {
                  [providerId]: {
                    auth: "native-command",
                    api: "openai-responses",
                    baseUrl: provider.baseUrl,
                    agentRuntime: { id: "codex" },
                    models: [
                      {
                        id: modelId,
                        name: "Deterministic native command",
                        reasoning: true,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 100000,
                        maxTokens: 1000,
                      },
                    ],
                  },
                },
              },
              plugins: {
                enabled: true,
                allow: ["codex"],
                entries: {
                  codex: {
                    enabled: true,
                    config: {
                      appServer: {
                        command: cell.launcher,
                        args: ["app-server"],
                        mode: "yolo",
                        sandbox: "danger-full-access",
                        codeModeOnly: false,
                        requestTimeoutMs: 90000,
                      },
                    },
                  },
                },
              },
              agents: {
                defaults: {
                  model: { primary: `${providerId}/${modelId}`, fallbacks: [] },
                  skipBootstrap: true,
                  skills: [],
                  timeoutSeconds: 90,
                  sandbox: { mode: "off" },
                },
              },
              tools: { profile: "full" },
            },
          });
          const ca = instance.state.path("fixture-ca.pem");
          await writeFile(ca, provider.certificate);
          instance.env.SSL_CERT_FILE = ca;
          const codexHome = path.join(instance.state.agentDir(), "codex-home");
          await mkdir(codexHome, { recursive: true });
          const tokenCommand = instance.state.path("native-token.mjs");
          await writeFile(tokenCommand, 'process.stdout.write("synthetic-inline-native-token");\n');
          await writeFile(
            path.join(codexHome, "config.toml"),
            [
              `model=${JSON.stringify(modelId)}`,
              `model_provider=${JSON.stringify(providerId)}`,
              'cli_auth_credentials_store="ephemeral"',
              'web_search="disabled"',
              'approval_policy="never"',
              'sandbox_mode="danger-full-access"',
              "allow_login_shell=false",
              "[features]",
              "shell_snapshot=false",
              "secret_auth_storage=true",
              "[analytics]",
              "enabled=false",
              "[feedback]",
              "enabled=false",
              `[model_providers.${providerId}]`,
              'name="Deterministic native provider"',
              `base_url=${JSON.stringify(provider.baseUrl)}`,
              'wire_api="responses"',
              "requires_openai_auth=false",
              "supports_websockets=false",
              "request_max_retries=0",
              "stream_max_retries=0",
              `[model_providers.${providerId}.auth]`,
              `command=${JSON.stringify(process.execPath)}`,
              `args=[${JSON.stringify(tokenCommand)}]`,
            ].join("\n"),
          );
          await instance.startGateway();
          gatewayPid = instance.child.pid;
          client = await acquireGatewayTestClient(
            {
              url: instance.url,
              token: instance.gatewayToken,
              env: instance.env,
              clientName: "cli",
              mode: "cli",
              scopes: ["operator.admin"],
              deviceIdentity: null,
              deviceAuthScope: instance.url,
              sharedStateMode: "read-only",
            },
            {
              timeoutMs: 10000,
              timeoutMessage: "Same-service client did not connect",
              closeMessage: "Same-service client closed",
            },
          );
          const key = "agent:main:dashboard:inline-same-service";
          await client.request("sessions.create", {
            key,
            agentId: "main",
            label: "Same-service command trail",
            model: `${providerId}/${modelId}`,
          });
          await client.request("sessions.patch", { key, verboseLevel: "off" });
          context = await browser.newContext({
            viewport: { width: 1440, height: 600 },
            locale: "en-US",
          });
          page = await context.newPage();
          page.setDefaultTimeout(15000);
          page.on("pageerror", (error) => errors.push(error.message));
          await page.addInitScript(installSameServiceBrowserProbe);
          await page.addInitScript(
            ({ storageKey, inline }) => {
              localStorage.setItem(storageKey, JSON.stringify({ chatInlineCommands: inline }));
            },
            {
              storageKey: controlUiBundledSettingsStorageKey(`http://127.0.0.1:${instance.port}/`),
              inline: cell.inline,
            },
          );
          const cli = async (args) => {
            const result = await instance.cli(args);
            assert.equal(result.code, 0, result.stderr);
            return result.stdout;
          };
          await pairControlUiPage(page, cli);
          await page.goto(controlUiSessionUrl(`http://127.0.0.1:${instance.port}/`, key));
          const script = await page
            .locator('script[type="module"][src]')
            .first()
            .getAttribute("src");
          const served = await context.request.get(new URL(script, page.url()).href);
          assert(
            (await served.body()).equals(
              await readFile(path.join(cell.cwd, "dist/control-ui", script.replace(/^\//u, ""))),
            ),
            "Served assets match selected source",
          );
          const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
          const composer = pane.getByRole("textbox", { name: "Chat composer", exact: true });
          const thread = pane.locator(".chat-thread");
          const stop = pane.locator("button.chat-send-btn--stop");
          cdp = await context.newCDPSession(page);
          await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
          await composer.waitFor({ state: "visible" });
          await resourcePoint("service-ready", -1);
          const activeSequenceStartedAt = performance.now();
          for (let turn = 0; turn < turns; turn++) {
            checkDeadline();
            const turnDir = turnDirs[turn];
            const receipt = {
              turn,
              sessionKey: key,
              gatewayPid,
              sourceCommit: cell.sourceCommit,
              startedAtMs: performance.now(),
              actions: [],
              status: "started",
            };
            turnReceipts.push(receipt);
            await composer.fill(`Run native streaming proof turn ${turn}.`);
            await page.evaluate((index) => window.sameServiceProbe.begin(index), turn);
            await pane.getByRole("button", { name: "Send message", exact: true }).click();
            await waitForFile(path.join(turnDir, "producer-ready"));
            // A typed draft hides Stop; establish running state before composing.
            await stop.waitFor({ state: "visible" });
            if (cell.inline) {
              await pane
                .locator(".chat-tool-row--running .chat-tool-row__cmd")
                .waitFor({ state: "visible" });
            }
            await composer.focus();
            await composer.evaluate((target) => {
              if (target.value !== "" || document.activeElement !== target) {
                throw new Error("Expected focused empty post-send composer");
              }
            });
            receipt.before = await resourcePoint("running-before-output", turn);
            const calibration = [];
            for (let index = 0; index < 3; index++) {
              const beforeMs = performance.now();
              const browserMs = await page.evaluate(() => performance.now());
              calibration.push({ beforeMs, browserMs, afterMs: performance.now() });
            }
            receipt.clockCalibration = calibration;
            receipt.warmStartBrowserMs = await page.evaluate(() => {
              const state = window.sameServiceProbe.snapshot().run;
              state.warmStartAt = performance.now();
              return state.warmStartAt;
            });
            const warmStart = performance.now();
            await writeFile(path.join(turnDir, "producer-start"), "start\n");
            let expectedDraft = "";
            const expectedLengths = [];
            let releasedReaderAnchor;
            for (let checkpoint = 0; checkpoint < 16; checkpoint++) {
              await delay(Math.max(0, warmStart + checkpoint * 640 - performance.now()));
              const action = { checkpoint, atMs: performance.now() };
              // Keep the in-progress action if an awaited outcome fails.
              receipt.actions.push(action);
              if ([6, 8, 10].includes(checkpoint) && releasedReaderAnchor !== undefined) {
                const currentTop = await thread.evaluate((element) => element.scrollTop);
                action.readerHold = { from: releasedReaderAnchor, to: currentTop };
                assert(
                  Math.abs(currentTop - releasedReaderAnchor) <= 1,
                  "Live output must preserve released reader position",
                );
              }
              if ([4, 6, 8, 10].includes(checkpoint)) {
                const box = await thread.boundingBox();
                assert(box, "Mounted scrollport must have geometry");
                const before = await thread.evaluate((element) => ({
                  top: element.scrollTop,
                  max: element.scrollHeight - element.clientHeight,
                }));
                const deltaY = checkpoint === 10 ? 100000 : checkpoint === 8 ? 120 : -120;
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.mouse.wheel(0, deltaY);
                action.wheel = { before, deltaY, box };
              }
              // Hover/wheel must not steal keyboard focus from this same composer.
              if (checkpoint === 12) {
                await page.keyboard.press("Shift+ArrowLeft");
                action.selectionBefore = await composer.evaluate((element) => ({
                  start: element.selectionStart,
                  end: element.selectionEnd,
                  direction: element.selectionDirection,
                }));
                await page.evaluate(
                  () =>
                    new Promise((resolve) => {
                      requestAnimationFrame(() => requestAnimationFrame(resolve));
                    }),
                );
                action.selectionAfterOutputFrames = await composer.evaluate((element) => ({
                  start: element.selectionStart,
                  end: element.selectionEnd,
                  direction: element.selectionDirection,
                }));
                assert.deepEqual(
                  action.selectionAfterOutputFrames,
                  action.selectionBefore,
                  "Trusted backward selection survives ongoing output",
                );
                assert.equal(action.selectionBefore.end - action.selectionBefore.start, 1);
                expectedDraft = expectedDraft.slice(0, -1);
              }
              await page.keyboard.press("a");
              expectedDraft += "a";
              expectedLengths.push(expectedDraft.length);
              const framed = await page.evaluate(
                () =>
                  new Promise((resolve) => {
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => resolve(performance.now())),
                    );
                  }),
              );
              action.secondFrameObservedAt = framed;
              assert.equal(
                await composer.inputValue(),
                expectedDraft,
                "Draft reflects each trusted typing/editing action",
              );
              assert(
                await composer.evaluate((element) => document.activeElement === element),
                "Wheel must preserve composer focus",
              );
              if (action.wheel) {
                const after = await thread.evaluate((element) => ({
                  top: element.scrollTop,
                  max: element.scrollHeight - element.clientHeight,
                }));
                action.wheel.after = after;
                const { before, deltaY } = action.wheel;
                action.wheel.hadRoom =
                  deltaY < 0 ? before.top >= 24 : before.max - before.top >= 24;
                if (action.wheel.hadRoom) {
                  // Produced position, not wheel dispatch acknowledgement. Animation may finish after two frames.
                  await page.waitForFunction(
                    ({ deltaY: requestedDeltaY, top }) => {
                      const target = document.querySelector(
                        'openclaw-chat-pane[aria-hidden="false"] .chat-thread',
                      );
                      return (
                        target &&
                        (requestedDeltaY < 0
                          ? target.scrollTop < top - 1
                          : target.scrollTop > top + 1)
                      );
                    },
                    { deltaY, top: before.top },
                    { timeout: 1500 },
                  );
                }
              }
              if (checkpoint === 11) {
                action.followRejoin = await thread.evaluate(
                  (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
                );
                assert(
                  action.followRejoin <= 8,
                  "Trusted wheel rejoin resumes following at the end",
                );
              }
              if ([5, 7, 9].includes(checkpoint)) {
                releasedReaderAnchor = await thread.evaluate((element) => element.scrollTop);
                action.readerDistance = await thread.evaluate(
                  (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
                );
                if (cell.inline && action.readerDistance > 8) {
                  action.newContentBelow = await pane
                    .locator(".chat-scroll-to-bottom")
                    .getAttribute("data-visible");
                  assert.equal(
                    action.newContentBelow,
                    "true",
                    "Live same-height output advertises new content below",
                  );
                }
              }
            }
            await waitForFile(path.join(turnDir, "producer-receipt.json"));
            const native = JSON.parse(
              await readFile(path.join(turnDir, "producer-receipt.json"), "utf8"),
            );
            assert.equal(native.chunks, 512);
            assert.equal(native.chunkBytes, 4096);
            assert.equal(native.intervalMs, 20);
            assert.equal(
              native.sha256,
              "5c928ba18713ac641610b6b486d92ec35908c8374472d96f88dcf3df9e523ac5",
            );
            receipt.producerReceipt = native;
            if (cell.inline) {
              await page.waitForFunction(() =>
                window.sameServiceProbe
                  .snapshot()
                  .run.previewFrames.some(
                    (frame) => frame.index === 511 && frame.visibility === "visible",
                  ),
              );
              assert(
                (await pane.locator(".chat-tool-row--running").count()) > 0,
                "Final preview remains Running before completion release",
              );
            }
            receipt.observation = await page.evaluate(() => window.sameServiceProbe.finish());
            receipt.after = await resourcePoint("running-after-output", turn);
            assert.equal(
              receipt.observation.inputs.length,
              16,
              "One trusted input receipt per checkpoint",
            );
            assert(
              receipt.observation.inputs.every(
                (input, index) =>
                  input.isTrusted &&
                  input.focused &&
                  input.focusedAfter &&
                  input.composerIdentity &&
                  input.length === expectedLengths[index] &&
                  input.lengthAfter === expectedLengths[index] &&
                  input.selectionStartAfter === expectedLengths[index] &&
                  input.selectionEndAfter === expectedLengths[index],
              ),
              "Trusted typing preserves DOM, focus, draft and caret",
            );
            assert(
              receipt.observation.wheels.length >= 4 &&
                receipt.observation.wheels.every((wheel) => wheel.isTrusted),
              "Trusted wheel events reach the live scrollport",
            );
            const maxima = receipt.observation.frames.filter(
              (frame) => frame.phase === "update" && frame.maxIndex >= 0,
            );
            for (let index = 1; index < maxima.length; index++) {
              assert(
                maxima[index].maxIndex >= maxima[index - 1].maxIndex,
                "Output order preserved",
              );
            }
            if (cell.inline) {
              assert(
                maxima.some((frame) => frame.maxIndex === 511),
                "Accepted final update retained",
              );
            }
            if (!cell.inline && cell.role === "candidate") {
              assert.equal(maxima.length, 0, "Grouped mode declines live stdout");
            }
            if (turn === 0 || turn === turns - 1) {
              await page.screenshot({ path: path.join(turnDir, "running-after-measurement.png") });
            }
            await composer.fill("");
            await writeFile(path.join(turnDir, "producer-finish"), "finish\n");
            const finalText = `INLINE_NATIVE_COMMAND_COMPLETE_TURN_${turn}`;
            await pane
              .getByRole("paragraph")
              .filter({ hasText: new RegExp(`^${finalText}$`, "u") })
              .waitFor({ state: "visible" });
            let history;
            const historyDeadline = performance.now() + 30000;
            for (;;) {
              history = await client.request("chat.history", {
                sessionKey: key,
                limit: 100,
                maxChars: 500000,
                toolResultMaxChars: 500000,
                maxBytes: 2000000,
              });
              const saved = history.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  (typeof message.content === "string"
                    ? message.content
                    : (message.content ?? [])
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("\n")) === finalText,
              );
              if (!history.inFlightRun && saved) {
                break;
              }
              assert(performance.now() < historyDeadline, "Saved terminal history did not settle");
              await delay(100);
            }
            await writeFile(path.join(turnDir, "history.json"), JSON.stringify(history));
            const calls = history.messages
              .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
              .filter(
                (part) => part.type === "toolCall" && part.arguments?.command?.includes(turnDir),
              );
            assert.equal(calls.length, 1, "One native command per turn in persisted history");
            const results = history.messages.filter(
              (message) => message.role === "toolResult" && message.toolCallId === calls[0].id,
            );
            assert.equal(results.length, 1);
            assert.equal(results[0].isError, false);
            const text = results[0].content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
            assert(/^Process exited with code 0$/mu.test(text) && text.includes("output-000000:"));
            assert(!text.includes("Process running with session ID"));
            receipt.history = {
              responseMetadata: Object.fromEntries(
                Object.entries(history).filter(([field]) => field !== "messages"),
              ),
              messages: history.messages.length,
              jsonBytes: Buffer.byteLength(JSON.stringify(history)),
              resultBytes: Buffer.byteLength(text),
              resultSha256: sha(text),
            };
            assert.equal(
              provider.requests.length,
              (turn + 1) * 2,
              "Exactly native call plus result inference per turn",
            );
            assert.deepEqual(provider.errors, []);
            assert.deepEqual(errors, []);
            await page.waitForFunction(
              () =>
                document.querySelectorAll(
                  'openclaw-chat-pane[aria-hidden="false"] .chat-tool-row--running',
                ).length === 0,
            );
            if (cell.inline) {
              const worked = pane
                .locator(".chat-work-group > .chat-activity-group__summary")
                .last();
              await worked.waitFor({ state: "visible" });
              assert.equal(
                await worked.getAttribute("aria-expanded"),
                "false",
                "Completed task folds under Worked",
              );
            }
            const idleStart = {
              atMs: performance.now(),
              gateway: readProc(gatewayPid),
              renderer: await metric(cdp),
            };
            await delay(2000);
            receipt.idleInterval = {
              before: idleStart,
              after: {
                atMs: performance.now(),
                gateway: readProc(gatewayPid),
                renderer: await metric(cdp),
              },
            };
            receipt.idle = await resourcePoint("settled-idle", turn);
            receipt.status = "complete";
            receipt.completedAtMs = performance.now();
            await writeFile(path.join(turnDir, "sample.json"), JSON.stringify(receipt, null, 2));
            await writeFile(
              path.join(cellDir, "turns.json"),
              JSON.stringify(turnReceipts, null, 2),
            );
            console.log(
              JSON.stringify({ cell: cell.label, turn, gatewayPid, status: receipt.status }),
            );
            if (
              minimumCellSeconds > 0 &&
              turn >= 5 &&
              performance.now() - activeSequenceStartedAt >= minimumCellSeconds * 1000
            ) {
              break;
            }
          }
          const activeSequenceElapsedMs = performance.now() - activeSequenceStartedAt;

          assert(
            activeSequenceElapsedMs >= minimumCellSeconds * 1000,
            "Sustained turn cap reached before required active-session duration; preserve incomplete run",
          );
          const recoveryStartedAt = performance.now();
          const recoveryTimes = [...new Set([5, 30, 60, postActiveIdleSeconds])]
            .filter((seconds) => seconds > 0 && seconds <= postActiveIdleSeconds)
            .toSorted((left, right) => left - right);
          for (const seconds of recoveryTimes) {
            checkDeadline();
            await delay(Math.max(0, recoveryStartedAt + seconds * 1000 - performance.now()));
            checkDeadline();
            await resourcePoint("post-active-idle-recovery", turnReceipts.length);
          }

          const scrollCoverage = turnReceipts.map((receipt) => ({
            turn: receipt.turn,
            up: receipt.actions.filter((action) => action.wheel?.hadRoom && action.wheel.deltaY < 0)
              .length,
            down: receipt.actions.filter(
              (action) => action.wheel?.hadRoom && action.wheel.deltaY > 0,
            ).length,
          }));
          const upward = scrollCoverage.reduce((sum, item) => sum + item.up, 0);
          const downward = scrollCoverage.reduce((sum, item) => sum + item.down, 0);
          assert(
            upward >= 8 &&
              downward >= 8 &&
              upward + downward >= 24 &&
              scrollCoverage.filter((item) => item.up + item.down > 0).length >= 6,
            "Insufficient sustained scrolling geometry/coverage: need24 gestures,8 each direction across6turns",
          );
          const probeEnd = await page.evaluate(() => window.sameServiceProbe.dispose());
          await writeFile(path.join(cellDir, "probe-end.json"), JSON.stringify(probeEnd, null, 2));
          await resourcePoint("service-end", turnReceipts.length);
          await page.screenshot({ path: path.join(cellDir, "completed.png") });
          const summary = {
            label: cell.label,
            sourceCommit: cell.sourceCommit,
            tree: cell.tree,
            gatewayPid,
            sessionKey: "agent:main:dashboard:inline-same-service",
            turns: turnReceipts.length,
            comparisonContractId: comparisonPlan.contractId,
            turnCap: turns,
            minimumCellSeconds,
            activeSequenceElapsedMs,
            postActiveIdleSeconds,
            gatewayCpuAccounting: {
              completeForExitedChildren: false,
              interpretation:
                "Gateway root CPU excludes live descendants. Per-checkpoint gatewayTree records each live PID's own CPU once; child-time fields are separate and must not be added to those PID values. Processes entirely between snapshots are unobserved. Enclosing cgroup includes benchmark/background work; RSS can double-count shared pages.",
            },
            startedAtMs: cellStartedAt,
            completedAtMs: performance.now(),
            providerRequests: provider.requests,
            errors,
            providerErrors: provider.errors,
            status: "complete",
          };
          summaries.push(summary);
          await writeFile(path.join(cellDir, "completion.json"), JSON.stringify(summary, null, 2));
          await json("cells.json", summaries);
        } catch (error) {
          // Failed gestures need the same trusted-event evidence as completed turns.
          const observation =
            page && !page.isClosed()
              ? await page
                  .evaluate(() => window.sameServiceProbe.snapshot())
                  .catch((failure) => ({
                    unavailable: String(failure),
                  }))
              : { unavailable: "Page unavailable" };
          await writeFile(
            path.join(cellDir, "failure-observation.json"),
            JSON.stringify(observation, null, 2),
          );
          await writeFile(
            path.join(cellDir, "failure.json"),
            JSON.stringify(
              {
                message: String(error),
                stack: error.stack,
                errors,
                providerErrors: provider.errors,
                providerRequests: provider.requests,
                turns: turnReceipts,
                checkpoints,
              },
              null,
              2,
            ),
          );
          if (page && !page.isClosed()) {
            await page.screenshot({ path: path.join(cellDir, "failure.png") }).catch(() => {});
          }
          if (instance) {
            await writeFile(path.join(cellDir, "gateway.private.log"), instance.logs());
          }
          throw error;
        }
      },
      settled("release-producer-start", async () => {
        for (const dir of turnDirs) {
          if (!existsSync(path.join(dir, "producer-start"))) {
            await writeFile(path.join(dir, "producer-start"), "cleanup\n");
          }
        }
      }),
      settled("release-producer-finish", async () => {
        for (const dir of turnDirs) {
          if (!existsSync(path.join(dir, "producer-finish"))) {
            await writeFile(path.join(dir, "producer-finish"), "cleanup\n");
          }
        }
      }),
      settled("cdp-detach", () => cdp?.detach()),
      settled("browser-context-close", () => context?.close()),
      settled("client-stop-and-wait", () => client?.stopAndWait()),
      settled("gateway-owner-cleanup", () => instance?.cleanup()),
      settled("provider-close", () => provider.close()),
    )
      .finally(async () => {
        await writeFile(
          path.join(cellDir, "settlement.json"),
          JSON.stringify({
            phases: settlementPhases,
            at: new Date().toISOString(),
            elapsedMs: performance.now() - cellStartedAt,
            pageClosed: page?.isClosed(),
            gatewayExitCode: instance?.child?.exitCode,
            gatewaySignalCode: instance?.child?.signalCode,
            lifecycleResources: {
              before: lifecycleBefore,
              after: resources(),
              interpretation:
                "Enclosing cgroup includes benchmark/background work and exited descendants across startup, active work, recovery and attempted cleanup. It is not product-only CPU and must not be added to process totals. Cleanup phase receipts decide settlement.",
            },
          }),
        );
      })
      .catch(async (error) => {
        // A failing historical control must not hide current-candidate evidence.
        // Continue only after the existing owner settled every cleanup phase.
        if (
          settlementPhases.length !== 7 ||
          settlementPhases.some((phase) => phase.status !== "settled")
        ) {
          throw error;
        }
        failures.push({ label: cell.label, message: String(error) });
        await json("failures.json", failures);
      });
  }
  await json("completion.json", {
    status: failures.length ? "failed" : "complete",
    failures,
    cells: summaries.length,
    comparisonContractId: comparisonPlan.contractId,
    turnCap: turns,
    qualification: false,
    resources: resources(),
  });
  assert.equal(failures.length, 0, "Failed cells remain failures after independent cells finish");
} finally {
  await runQaGatewayFixture(
    () => json("resource-final.json", resources()),
    () => browserCdp.detach(),
    () => browser.close(),
  );
}
console.log(root);
