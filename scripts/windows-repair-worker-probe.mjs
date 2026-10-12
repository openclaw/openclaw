import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../test/helpers/openai-responses-sse.ts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  hashFile,
  hashInstall,
  installedPackageSchema,
  prepareInstalledPackage,
} from "./lib/gateway-bench-installed-package.ts";
import { spawnWindowsJobChild } from "./lib/managed-windows-job.mts";
import { createPackagedOwnerLoader, verifyPackageMember } from "./lib/windows-repair-package.mts";

const fixture = fileURLToPath(import.meta.url);
const deferredReason =
  "Inference repair is deferred until after the update has failed. Updates do not require inference.";
// These are unchanged npm modules, authenticated by registry integrity and module digest.
const publishedParents = [
  {
    version: "2026.9.4",
    commit: "3a9d69db306cd7f081e06254cb89c4bcc14a7107",
    integrity:
      "sha512-lTQpEEe1Xm3u2PCHaPEr+vP8paGk1vLdHuzdItsNToaLI6hAqRVvgJYg+GxukJhETJp4tPy/S1Gftl4KuB8n7A==",
    module: "update-repair-agent-BCh-8meC.mjs",
    sha256: "ada75d25197b5d64b9ef54aba765319d0ce7268c211e9921562d36d44111c977",
    phases: ["verifying"],
  },
  {
    version: "2026.9.5",
    commit: "ec9c1a13db8938e5a3eaa51fca2e981cde2395a9",
    integrity:
      "sha512-TCO/ImVLh5HkF4tdfo7iriIa7kT6iYkIr/jR5ZOkePGFGhUx5Oe7DE716Y1DzzG2teRAVDdCjgJDu1A24Yta7w==",
    module: "update-repair-agent-DH1YLzzi.mjs",
    sha256: "a71347f3216f2d217198a8584549d7e6872e5e2dce7a3c093173d6382ea3815f",
    phases: ["validating", "verifying"],
  },
];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
};
async function waitFor(predicate, milliseconds, message) {
  const deadline = performance.now() + milliseconds;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, message);
    await delay(25);
  }
}
async function send(message) {
  assert.ok(typeof process.send === "function", "Repair observer requires an IPC sender");
  await promisify(process.send.bind(process))(message);
}
async function acknowledgement() {
  const [message] = await once(process, "message", { signal: AbortSignal.timeout(90_000) });
  assert.deepEqual(message, { continue: true });
}
function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if (-not $p) { throw 'Proof process disappeared' }; @{pid=[int]$p.ProcessId; parentPid=[int]$p.ParentProcessId; created=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }),
  );
}
function isolatedEnvironment(root) {
  const home = path.join(root, "home");
  const env = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
  ]) {
    const key = Object.keys(process.env).find(
      (entry) => entry.toLowerCase() === name.toLowerCase(),
    );
    if (key) {
      env[name] = process.env[key];
    }
  }
  return {
    ...env,
    CI: "1",
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
    OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json"),
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

function repairConfig(baseUrl) {
  const model = "repair-test/repair-model";
  return {
    plugins: { slots: { memory: "none" } },
    tools: { exec: { mode: "ask", safeBins: ["cat"] }, fs: { workspaceOnly: false } },
    agents: {
      defaults: {
        model: { primary: model },
        models: { [model]: { agentRuntime: { id: "openclaw" } } },
        systemAgent: { agentId: "operator" },
        skipBootstrap: true,
        skills: [],
        sandbox: { mode: "off" },
      },
      entries: { operator: {} },
    },
    models: {
      mode: "replace",
      providers: {
        "repair-test": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "synthetic-repair-key",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "repair-model",
              name: "Repair model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
}
function toolResponse(response, command) {
  const item = {
    type: "function_call",
    id: "fc_repair_exec",
    call_id: "call_repair_exec",
    name: "exec",
    arguments: JSON.stringify({ command, background: true }),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_repair",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}
async function observer(spec) {
  assert.equal(process.platform, "win32");
  assert.ok(process.connected, "Repair observer requires its outer Job control channel");
  const packageRoot = path.join(spec.input.installRoot, "node_modules", "openclaw");
  const loadPackagedOwner = await createPackagedOwnerLoader(packageRoot, spec.input.tarball);
  // Repair tools are scoped to the real installation. Only these owned fixture
  // artifacts are added there; successful cleanup restores its original hash.
  const workspace = path.join(packageRoot, `.openclaw-repair-proof-${randomUUID()}`);
  const state = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  await fs.mkdir(workspace);
  await fs.mkdir(state, { recursive: true });
  const marker = path.join(workspace, "descendant.json");
  const launcher = path.join(workspace, "launcher.cjs");
  const descendant = path.join(workspace, "descendant.cjs");
  await fs.writeFile(
    descendant,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,launcher:process.ppid,effect:'owned'}));setInterval(()=>{},60000);`,
  );
  await fs.writeFile(
    launcher,
    `require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore',detached:true,windowsHide:true});setInterval(()=>{},60000);`,
  );
  let child;
  let issued = false;
  let requests = 0;
  let validations = 0;
  let effect;
  /** @type {Error | undefined} */
  let providerError;
  let forcedKillRequested = false;
  let workerTimedOut = false;
  const owners = [];
  const server = createServer((request, response) => {
    void (async () => {
      requests += 1;
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "repair-model", object: "model" }] }));
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses");
      const body = JSON.parse(await text(request));
      if (!issued && body.tools?.some((tool) => tool.name === "exec")) {
        issued = true;
        toolResponse(response, `node ${JSON.stringify(launcher)}`);
        return;
      }
      if (!issued) {
        writeOpenAiResponsesText(response, {
          text: "OK",
          messageId: "msg_probe",
          responseId: "resp_probe",
        });
        return;
      }
      await waitFor(
        async () => {
          try {
            effect = JSON.parse(await fs.readFile(marker, "utf8"));
            return true;
          } catch (error) {
            if (error.code === "ENOENT") {
              return false;
            }
            throw error;
          }
        },
        5_000,
        "The delegated tool did not create its descendant",
      );
      assert.equal(effect.effect, "owned");
      assert.ok(alive(effect.pid) && alive(effect.launcher));
      const acknowledged = acknowledgement();
      await send({
        type: "descendant-live",
        worker: child.pid,
        descendant: effect.pid,
        intermediate: effect.launcher,
      });
      await acknowledged;
      if (spec.mode === "forced") {
        assert.ok(child.kill("SIGKILL"), "Worker exited before the requested forced-exit fault");
        forcedKillRequested = true;
        response.destroy();
      } else {
        writeOpenAiResponsesText(response, {
          text: 'REPAIR_RESULT: {"status":"fixed","summary":"Created the target repair marker."}',
          messageId: "msg_repaired",
          responseId: "resp_repaired",
        });
      }
    })().catch(
      /** @param {unknown} error */ (error) => {
        providerError = toErrorObject(error, "Synthetic repair provider failed.");
        response.destroy();
        child?.kill("SIGKILL");
      },
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = JSON.stringify(repairConfig(`http://127.0.0.1:${server.address().port}`));
  await fs.writeFile(configPath, config);
  const target = { installRoot: packageRoot, stateDir: state, configPath, workspaceDir: workspace };
  owners.push(
    await verifyPackageMember(
      packageRoot,
      spec.input.tarball,
      path.join(packageRoot, "dist", "infra", "update-repair.worker.js"),
    ),
  );
  const before = await hashInstall(state);
  const workspaceBefore = await hashInstall(workspace);
  let result;
  let workerExit;
  let ready;
  try {
    if (spec.mode === "legacy") {
      const parent = publishedParents.find((entry) => entry.version === spec.version);
      assert.ok(parent?.phases.includes(spec.phase));
      const modulePath = path.join(
        spec.publishedRoot,
        spec.version,
        "node_modules",
        "openclaw",
        "dist",
        parent.module,
      );
      assert.equal(await hashFile(modulePath), parent.sha256);
      const { t: prepareUnattendedUpdateRepair } = await import(pathToFileURL(modulePath).href);
      result = await prepareUnattendedUpdateRepair({
        runId: "released-update-run",
        requester: { channel: "synthetic", senderId: "owner" },
        target,
        context: {
          phase: spec.phase,
          beforeVersion: parent.version,
          targetVersion: spec.input.candidate.version,
          error: "Synthetic repair failure.",
        },
        budget: { maxTurns: 1, wallClockMs: 90_000, perTurnMs: 60_000, maxToolCalls: 2 },
        validate: async () => {
          validations += 1;
          throw new Error("Legacy deferred repair must not validate");
        },
      });
      assert.equal(result.status, "unavailable");
      assert.equal(result.reason, deferredReason);
      assert.deepEqual(result.attempts, []);
      assert.equal(result.finalValidation.ok, false);
      assert.equal(result.finalValidation.summary, deferredReason);
      assert.equal(validations, 0);
      assert.equal(requests, 0);
      assert.deepEqual(await hashInstall(state), before);
      assert.deepEqual(await hashInstall(workspace), workspaceBefore);
    } else {
      const executor = await loadPackagedOwner(
        "update-command-executor",
        ["withUpdateCommandExecutor", "withUpdateCommandExecutorChild"],
        owners,
      );
      const ledger = await loadPackagedOwner(
        "update-run-ledger",
        ["createUpdateRun", "recordUpdateRunPhase", "finishUpdateRun"],
        owners,
      );
      const database = await loadPackagedOwner(
        "update-managed-service-handoff-lease",
        ["createManagedHandoffLeaseDatabase", "captureManagedUpdateLeaseDatabaseIdentity"],
        owners,
      );
      const databasePath = path.join(spec.root, "managed-update-handoffs.sqlite");
      const identity = database.createManagedHandoffLeaseDatabase(databasePath)(true, () =>
        database.captureManagedUpdateLeaseDatabaseIdentity(databasePath),
      );
      const run = ledger.createUpdateRun({ trigger: "cli" }, { env: process.env });
      ledger.recordUpdateRunPhase(run.runId, "repairing", undefined, { env: process.env });
      try {
        await executor.withUpdateCommandExecutor(
          run.runId,
          async (owner) => {
            const fence = await owner.enter(packageRoot);
            await executor.withUpdateCommandExecutorChild(
              fence,
              packageRoot,
              async (grant, bindChild) => {
                child = spawn(
                  process.execPath,
                  [path.join(packageRoot, "dist", "infra", "update-repair.worker.js")],
                  {
                    cwd: packageRoot,
                    env: process.env,
                    stdio: ["ignore", "ignore", "pipe", "ipc"],
                    windowsHide: true,
                  },
                );
                // One deadline includes startup and inference, beginning at spawn.
                const timer = setTimeout(() => {
                  workerTimedOut = true;
                  child.kill("SIGKILL");
                }, 90_000);
                let stderr = "";
                child.stderr.on("data", (chunk) => {
                  stderr = (stderr + chunk.toString()).slice(-32_768);
                });
                const closed = once(child, "close");
                let decoy;
                let decoyClosed;
                try {
                  const [message] = await once(child, "message", {
                    signal: AbortSignal.timeout(90_000),
                  });
                  assert.equal(message.type, "ready", stderr);
                  assert.equal(message.repairTurns, true);
                  assert.equal(message.candidateRehearsal, true);
                  assert.equal(message.executorDelegation, "pid-start-v1");
                  ready = message;
                  if (spec.mode === "wrong-receiver") {
                    decoy = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], {
                      stdio: "ignore",
                      windowsHide: true,
                    });
                    decoyClosed = once(decoy, "close");
                    bindChild(decoy.pid);
                  } else {
                    bindChild(child.pid);
                  }
                  child.on("message", (reply) => {
                    if (reply.type === "turn-result") {
                      result = reply.result;
                    }
                  });
                  child.send({
                    type: "turn",
                    runId: run.runId,
                    executor: grant,
                    target,
                    prompt: "Repair the missing marker using the configured tools.",
                    wallClockMs: 90_000,
                    timeoutMs: 60_000,
                    maxToolCalls: 2,
                  });
                  const [code, signal] = await closed;
                  clearTimeout(timer);
                  workerExit = {
                    pid: child.pid,
                    code,
                    signal,
                    stderr,
                    forcedKillRequested,
                    workerTimedOut,
                  };
                  assert.equal(workerTimedOut, false, "Worker exceeded its 90-second deadline");
                  if (providerError) {
                    throw providerError;
                  }
                  if (spec.mode === "forced") {
                    assert.ok(effect && issued && forcedKillRequested);
                    assert.notEqual(code, 0);
                    assert.equal(result, undefined);
                  } else {
                    assert.equal(code, 0, stderr);
                    assert.equal(
                      result?.status,
                      spec.mode === "wrong-receiver" ? "aborted" : "completed",
                      JSON.stringify(result),
                    );
                  }
                  if (spec.mode === "wrong-receiver") {
                    assert.equal(requests, 0);
                    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
                  } else {
                    assert.ok(effect && requests > 0);
                    if (spec.mode === "normal") {
                      assert.equal(result.toolCalls, 1);
                      assert.equal(result.timedOut, false);
                      assert.equal(result.summary, "Created the target repair marker.");
                    }
                  }
                  assert.equal(await fs.readFile(configPath, "utf8"), config);
                  if (effect) {
                    // The parent executor must not settle its command scope until
                    // the outer observer has checked the worker's descendants.
                    const checked = acknowledgement();
                    await send({ type: "worker-exited", workerExit, effect });
                    await checked;
                  }
                } finally {
                  clearTimeout(timer);
                  if (decoy) {
                    decoy.kill("SIGKILL");
                    await decoyClosed;
                  }
                  if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                  }
                  await closed;
                }
              },
            );
          },
          { existingAuthority: { ...identity, installKey: packageRoot } },
        );
      } finally {
        ledger.finishUpdateRun(
          run.runId,
          { status: "failed", reason: "Synthetic Windows repair-worker proof completed." },
          { env: process.env },
        );
      }
    }
    const acknowledged = acknowledgement();
    await send({
      type: "result",
      observer: process.pid,
      result,
      workerExit,
      ready,
      effect,
      requests,
      validations,
      owners,
      legacyControllerResult:
        spec.mode === "legacy"
          ? "exact deferred result from the unchanged published controller; IPC was not instrumented"
          : undefined,
    });
    await acknowledged;
    await fs.rm(workspace, { recursive: true });
  } finally {
    loadPackagedOwner[Symbol.dispose]();
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

async function runCell(spec) {
  const specPath = path.join(spec.root, "input.json");
  const env = isolatedEnvironment(spec.root);
  await fs.mkdir(spec.root);
  for (const directory of [env.HOME, env.TMP, env.APPDATA, env.LOCALAPPDATA]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await fs.writeFile(specPath, JSON.stringify(spec));
  const launch = spawnWindowsJobChild(
    process.execPath,
    ["--import", new URL("./tsx.mjs", import.meta.url).href, fixture, "--observer", specPath],
    { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
  );
  assert.ok(launch, "Native Job owner is unavailable");
  const { child, job } = launch;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-32_768);
  });
  // Launch errors belong to job.ready; this promise joins the actual close event.
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  let outcome;
  /** @type {Error | undefined} */
  let failure;
  const failed = Promise.withResolvers();
  const stopErrors = [];
  let launcherClosed = false;
  child.once("close", () => {
    launcherClosed = true;
  });
  const stop = () => {
    try {
      job.stop();
    } catch (error) {
      stopErrors.push(toErrorObject(error, "Windows Job termination failed.").message);
    }
  };
  const observations = [];
  let handling = Promise.resolve();
  child.on("message", (message) => {
    if (job.isControlMessage(message)) {
      return;
    }
    handling = handling
      .then(async () => {
        if (message.type === "descendant-live") {
          const members = job.inspect();
          for (const pid of [
            child.pid,
            job.commandPid,
            message.worker,
            message.descendant,
            message.intermediate,
          ]) {
            assert.ok(members.includes(pid), `Process ${pid} did not inherit the outer Job`);
          }
          observations.push({
            ...message,
            members,
            identities: [message.worker, message.descendant, message.intermediate].map(
              processIdentity,
            ),
          });
        } else if (message.type === "worker-exited") {
          const live = observations.find((entry) => entry.type === "descendant-live");
          assert.ok(live, "Worker exit has no admitted descendant observation");
          assert.equal(message.workerExit.pid, live.worker);
          assert.equal(message.effect.pid, live.descendant);
          assert.equal(message.effect.launcher, live.intermediate);
          await waitFor(
            () => !alive(message.effect.pid) && !alive(message.effect.launcher),
            2_000,
            "Repair worker left a tool descendant alive",
          );
          const members = job.inspect();
          assert.ok(
            members.includes(child.pid) && members.includes(job.commandPid),
            "Outer launcher/observer exited before the descendant assertion",
          );
          for (const pid of [message.workerExit.pid, message.effect.pid, message.effect.launcher]) {
            assert.ok(
              !members.includes(pid),
              "Repair worker descendant remains in the inherited Job",
            );
          }
          observations.push({
            type: "extinction-before-parent-release",
            members,
            observer: job.commandPid,
            launcher: child.pid,
          });
        } else if (message.type === "result") {
          if (message.effect) {
            assert.ok(
              observations.some((entry) => entry.type === "extinction-before-parent-release"),
              "Parent executor settled before descendant extinction was observed",
            );
          }
          outcome = message;
        } else {
          throw new Error(`Unexpected proof message: ${JSON.stringify(message)}`);
        }
        child.send({ continue: true });
      })
      .catch(
        /** @param {unknown} error */ (error) => {
          failure = toErrorObject(error, "Windows repair observation failed.");
          stop();
          failed.reject(failure);
        },
      );
  });
  const timer = setTimeout(() => {
    failure = new Error("Windows repair cell exceeded its 120-second deadline");
    stop();
    failed.reject(failure);
  }, 120_000);
  let cleanup;
  try {
    await Promise.race([job.ready, failed.promise]);
    const [code, signal] = await Promise.race([closed, failed.promise]);
    await handling;
    if (failure) {
      throw failure;
    }
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.ok(outcome, "The observer exited without a proof result");
    cleanup = await Promise.race([
      job.certify(),
      delay(2_000).then(() => {
        throw new Error("Outer Job did not settle naturally");
      }),
    ]);
    assert.equal(cleanup.status, "confirmed");
    return { name: spec.name, status: "passed", ...outcome, observations, cleanup };
  } catch (error) {
    stop();
    cleanup = await job.certify();
    const normalized = toErrorObject(error, "Windows repair cell failed.");
    throw Object.assign(normalized, {
      proof: {
        name: spec.name,
        status: "failed",
        error: normalized.message,
        stderr,
        outcome,
        observations,
        cleanup,
        stopErrors,
        launcherClosed,
      },
    });
  } finally {
    clearTimeout(timer);
    // Certification owns handle closure even on uncertainty. Do not hide that
    // evidence by waiting indefinitely for a launcher whose cleanup failed.
    if (cleanup?.status === "confirmed") {
      await closed;
    }
  }
}
async function main(inputPath, outputPath) {
  assert.equal(process.platform, "win32", "This probe must run on native Windows");
  assert.ok(inputPath && outputPath);
  const input = installedPackageSchema.parse(JSON.parse(await fs.readFile(inputPath, "utf8")));
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    input.toolingSha,
    "Tooling checkout changed",
  );
  const prepared = await prepareInstalledPackage(input);
  const publishedRoot = path.join(path.dirname(input.stateRoot), "repair-published");
  const parents = [];
  for (const parent of publishedParents) {
    const installRoot = path.join(publishedRoot, parent.version);
    const root = path.join(installRoot, "node_modules", "openclaw");
    const lock = JSON.parse(await fs.readFile(path.join(installRoot, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["node_modules/openclaw"].integrity, parent.integrity);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, "dist", "build-info.json"), "utf8")).commit,
      parent.commit,
    );
    assert.equal(await hashFile(path.join(root, "dist", parent.module)), parent.sha256);
    parents.push({ ...parent, installRoot, before: await hashInstall(installRoot) });
  }
  await fs.mkdir(prepared.root);
  const evidence = {
    status: "running",
    input,
    runtime: { version: process.version, platform: process.platform, arch: process.arch },
    fixtureSha256: await hashFile(fixture),
    parents,
    cases: [],
    fullUpdaterUpgrade: "not exercised; published controller compatibility only",
  };
  const specs = [
    ...parents.flatMap((parent) =>
      parent.phases.map((phase) => ({
        name: `published-${parent.version}-${phase}`,
        mode: "legacy",
        version: parent.version,
        phase,
      })),
    ),
    { name: "delegated-normal-exit", mode: "normal" },
    { name: "delegated-forced-exit", mode: "forced" },
    { name: "delegated-wrong-receiver", mode: "wrong-receiver" },
  ];
  evidence.plannedCells = specs.map((spec) => spec.name);
  const checkpoint = () => fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await checkpoint();
  try {
    for (const spec of specs) {
      process.stdout.write(`repair-cell ${spec.name}\n`);
      try {
        evidence.cases.push(
          await runCell({
            ...spec,
            input,
            publishedRoot,
            root: path.join(prepared.root, spec.name),
          }),
        );
      } catch (error) {
        evidence.cases.push(
          error.proof ?? { name: spec.name, status: "failed", error: error.message },
        );
        throw error;
      } finally {
        await checkpoint();
      }
    }
    assert.deepEqual(
      await hashInstall(input.installRoot),
      prepared.before,
      "Candidate installation changed",
    );
    for (const parent of parents) {
      assert.deepEqual(
        await hashInstall(parent.installRoot),
        parent.before,
        "Published installation changed",
      );
    }
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error.message;
    throw error;
  } finally {
    await checkpoint();
  }
}
if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  if (process.argv[2] === "--parent-manifest") {
    process.stdout.write(JSON.stringify(publishedParents));
  } else if (process.argv[2] === "--observer") {
    try {
      await observer(JSON.parse(await fs.readFile(process.argv[3], "utf8")));
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${error.stack}\n`);
      process.exit(1);
    }
  } else {
    await main(process.argv[2], process.argv[3]);
  }
}
