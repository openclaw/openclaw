// Published-upgrade scenario. The maintained Telegram run scope owns every consumer.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireNormalGatewayStop } from "./telegram-binding-upgrade-verdict.mjs";

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const requireFact = (condition, code) => {
  if (!condition) {
    throw new Error(code);
  }
};

export async function drivePublishedUpgrade(args, source, credential) {
  const scripts = join(source, ".agents/skills/telegram-e2e-userbot/scripts");
  const harness = await import(pathToFileURL(join(scripts, "run-mock-sut-user-e2e.mjs")));
  const { currentTelegramRun } = await import(
    pathToFileURL(join(scripts, "telegram-run-scope.mjs"))
  );
  const { startTelegramTestApiProxy } = await import(
    pathToFileURL(join(scripts, "telegram-test-api-proxy.mjs"))
  );
  const { parseRecorderReady } = await import(pathToFileURL(join(scripts, "scenario.mjs")));
  const scope = currentTelegramRun();
  const proof = dirname(resolve(args.output));
  const upgradeInput = args.upgrade;
  const { prefix, packageRoot, tarball, profile, baseline, candidate } = upgradeInput;
  const candidateHead = candidate.buildInfo.commit;
  const mockPath = join(source, "scripts/e2e/mock-openai-server.mjs");
  requireFact(
    realpathSync(join(prefix, "bin/openclaw")) === join(packageRoot, "openclaw.mjs"),
    "OWNED_INSTALLED_PREFIX_REQUIRED",
  );
  const beforeBuild = json(join(packageRoot, "dist/build-info.json"));
  requireFact(beforeBuild.buildId === baseline.buildInfo.buildId, "PUBLISHED_BASELINE_CHANGED");
  const candidateSha256 = candidate.sha256;
  const driverEnv = { ...harness.sanitizeChildEnvironment(), ...credential.driverEnv };
  const status = await harness.runCommand(
    "python3",
    [join(scripts, "user-driver.py"), "status", "--json"],
    {
      cwd: source,
      env: driverEnv,
      timeoutMs: 30000,
    },
  );
  requireFact(status.status === 0 && !status.timedOut, "LEASED_USER_STATUS_FAILED");
  const tester = JSON.parse(status.stdout);
  requireFact(tester.ok && tester.user?.id && !tester.user.isBot, "LEASED_USER_IDENTITY_INVALID");
  harness.assertTesterMatchesLease(tester.user, credential);
  const proxy = scope.ownProxy(await startTelegramTestApiProxy({ leaseHealth: scope.health }));
  const bot = await harness.fetchWithLease(
    `${proxy.apiRoot}/bot${credential.sutToken}/getMe`,
    {},
    scope.health,
  );
  requireFact(bot.response.ok && bot.payload.ok, "LEASED_BOT_STATUS_FAILED");
  harness.assertSutMatchesLease(
    { id: String(bot.payload.result.id), username: bot.payload.result.username },
    credential,
  );
  await harness.drainSutUpdates(credential.sutToken, scope.health);
  const temp = harness.writeConfig({
    ...credential,
    groupId: args.chat,
    testerId: String(tester.user.id),
    gatewayPort: args.gatewayPort,
    mockPort: args.mockPort,
    backend: "mock",
    sourceGateway: false,
    telegramApiRoot: proxy.apiRoot,
    gatewayLog: join(proof, "gateway-file.log"),
  });
  let completed = false;
  // Successful proof uses ordinary scratch removal. Failure retains the exact upgrade input.
  scope.ownScratch(temp.root, (root) => {
    if (completed) {
      rmSync(root, { recursive: true, force: true });
    } else {
      save(join(proof, "retained-runner-state.json"), {
        root,
        stateDir: temp.stateDir,
        configPath: temp.configPath,
      });
    }
  });
  const gatewayEnv = {
    ...harness.createGatewayEnvironment({ configPath: temp.configPath, stateDir: temp.stateDir }),
    OPENCLAW_PROFILE: profile,
  };
  const commandEnv = harness.createScenarioCommandEnvironment({
    gatewayEnv,
    driverEnv: credential.driverEnv,
    telegramApiRoot: proxy.apiRoot,
  });
  const requestLog = join(proof, "mock-openai-requests.ndjson");
  writeFileSync(requestLog, "", { mode: 0o600 });
  const barrierDir = join(temp.root, "scenario-barriers");
  mkdirSync(barrierDir, { mode: 0o700 });
  const scenarioPath = join(temp.root, "scenario.json");
  const readyPath = join(temp.root, "recorder-ready.json");
  save(scenarioPath, args.scenario);
  const failures = join(barrierDir, "action-failure.json");
  function active() {
    scope.assertActive();
    requireFact(!existsSync(failures), "RECORDER_ACTION_FAILED");
  }
  function child(command, argv, env, cwd, label) {
    active();
    const process = harness.ownChild(
      spawn(command, argv, {
        cwd,
        env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    process.output = "";
    process.done = harness.watchChildCompletion(process);
    for (const [stream, suffix] of [
      [process.stdout, "stdout"],
      [process.stderr, "stderr"],
    ]) {
      stream.setEncoding("utf8");
      let log = "";
      stream.on("data", (text) => {
        log = (log + text).slice(-1024 * 1024);
        process.output = (process.output + text).slice(-8000);
      });
      scope.preserveEvidence(() =>
        writeFileSync(join(proof, `${label}.${suffix}.log`), log, { mode: 0o600 }),
      );
    }
    return process;
  }
  function live(process) {
    active();
    requireFact(
      !process.spawnError && process.exitCode === null && process.signalCode === null,
      "OWNED_CHILD_EXITED_BEFORE_READY",
    );
  }
  async function until(process, condition, timeoutMs, code) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      live(process);
      if (await condition()) {
        return;
      }
      await scope.sleep(100);
    }
    throw new Error(code);
  }
  async function joinedCommand(process, timeoutMs) {
    let timer;
    try {
      const result = await scope.wait(
        Promise.race([
          process.done,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("UPDATER_DEADLINE")), timeoutMs);
          }),
        ]),
      );
      await scope.stopChild(process);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  let gateway;
  let restartCount = 0;
  const actions = [];
  async function stopGatewayNormally(handle, phase) {
    requireFact(Boolean(handle), "GATEWAY_STOP_HANDLE_MISSING");
    const began = Date.now();
    const receipt = {
      phase,
      pid: handle.pid,
      runtime: handle.proofRuntime,
      graceMs: 60000,
      joined: false,
      exitCode: null,
      signal: null,
    };
    try {
      await scope.stopChild(handle, receipt.graceMs);
      const outcome = await handle.done;
      Object.assign(receipt, {
        joined: true,
        outcomeType: outcome.type,
        exitCode: outcome.type === "exit" ? outcome.code : null,
        signal: handle.signalCode ?? null,
        durationMs: Date.now() - began,
      });
    } catch (error) {
      Object.assign(receipt, {
        exitCode: handle.exitCode,
        signal: handle.signalCode ?? null,
        durationMs: Date.now() - began,
        cleanupUnconfirmed: true,
      });
      save(join(proof, `gateway-stop-${phase}.json`), receipt);
      throw error;
    }
    save(join(proof, `gateway-stop-${phase}.json`), receipt);
    requireNormalGatewayStop(
      receipt,
      {
        installedCommit: handle.proofRuntime.build.commit,
        entrySha256: handle.proofRuntime.entrySha256,
        installedRoot: handle.proofRuntime.packageRoot,
      },
      phase,
    );
  }
  const installedIdentity = (input) => {
    const build = json(join(packageRoot, "dist/build-info.json"));
    requireFact(
      build.commit === input.buildInfo.commit &&
        build.buildId === input.buildInfo.buildId &&
        build.version === input.buildInfo.version,
      "INSTALLED_BUILD_MISMATCH",
    );
    for (const [file, digest] of Object.entries(input.runtimeHashes)) {
      requireFact(sha(join(packageRoot, file)) === digest, "INSTALLED_RUNTIME_ARTIFACT_CHANGED");
    }
    const identity = { packageRoot, build, entrySha256: sha(join(packageRoot, "dist/entry.js")) };
    save(join(proof, "installed-runtime.json"), identity);
    return identity;
  };
  const baselineIdentity = installedIdentity(baseline);
  save(join(proof, "runtime-baseline.json"), baselineIdentity);
  const startGateway = async (input, label) => {
    const identity = installedIdentity(input);
    const gatewayChild = child(
      process.execPath,
      [
        join(packageRoot, "dist/entry.js"),
        "--profile",
        profile,
        "gateway",
        "--port",
        String(args.gatewayPort),
      ],
      gatewayEnv,
      packageRoot,
      label,
    );
    gatewayChild.proofRuntime = identity;
    await until(
      gatewayChild,
      async () => {
        try {
          const result = await harness.fetchWithLease(
            `http://127.0.0.1:${args.gatewayPort}/readyz`,
            { signal: AbortSignal.timeout(1000) },
            scope.health,
            fetch,
            (response) => response.arrayBuffer(),
          );
          return result.response.ok;
        } catch {
          active();
          return false;
        }
      },
      45000,
      "INSTALLED_GATEWAY_READINESS_DEADLINE",
    );
    return gatewayChild;
  };
  async function upgrade() {
    requireFact(
      sha(tarball) === candidateSha256 &&
        sha(join(packageRoot, "dist/entry.js")) === baselineIdentity.entrySha256,
      "UPGRADE_INPUT_CHANGED",
    );
    const home = join(proof, "updater-home");
    mkdirSync(home, { mode: 0o700 });
    const own = (name) => {
      const dir = join(proof, `updater-${name}`);
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    };
    const tmp = own("tmp");
    const env = {
      PATH: `${prefix}/bin:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      XDG_CACHE_HOME: own("xdg-cache"),
      XDG_CONFIG_HOME: own("xdg-config"),
      XDG_DATA_HOME: own("xdg-data"),
      npm_config_cache: own("npm-cache"),
      npm_config_prefix: prefix,
      npm_config_devdir: own("node-gyp"),
      npm_config_userconfig: join(home, ".npmrc"),
      npm_config_globalconfig: join(home, "global-npmrc"),
      NODE_COMPILE_CACHE: own("compile-cache"),
      COREPACK_HOME: own("corepack"),
      OPENCLAW_STATE_DIR: temp.stateDir,
      OPENCLAW_CONFIG_PATH: temp.configPath,
      OPENCLAW_PROFILE: profile,
      OPENCLAW_LOG_LEVEL: "silent",
      OPENAI_API_KEY: "openclaw-e2e-mock-key",
      CI: "1",
      NO_COLOR: "1",
      LANG: "en_US.UTF-8",
    };
    // Package Acceptance's existing registry owns prerelease dependency resolution.
    for (const key of ["NPM_CONFIG_REGISTRY", "npm_config_registry"]) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    const argv = [
      "--profile",
      profile,
      "update",
      "--tag",
      `file:${tarball}`,
      "--yes",
      "--no-restart",
      "--json",
    ];
    save(join(proof, "updater-command.json"), {
      command: [join(prefix, "bin/openclaw"), ...argv],
      cwd: home,
      stateDir: temp.stateDir,
      configPath: temp.configPath,
      candidateSha256,
      environmentKeys: Object.keys(env).toSorted(),
      inheritedEnvironment: false,
      baselineJoinedBeforeUpdate: true,
    });
    const started = Date.now();
    let outcome;
    try {
      outcome = await joinedCommand(
        child(join(prefix, "bin/openclaw"), argv, env, home, "updater"),
        900000,
      );
    } catch (error) {
      save(join(proof, "updater-readback.json"), {
        exitCode: null,
        joined: false,
        outcomeUncertain: true,
        timedOut: error?.message === "UPDATER_DEADLINE",
        durationMs: Date.now() - started,
        beforeBuild,
        baselineJoinedBeforeUpdate: true,
        stateDir: temp.stateDir,
        configPath: temp.configPath,
        candidateSha256,
        noRetry: true,
      });
      throw error;
    }
    let afterBuild;
    try {
      afterBuild = json(join(packageRoot, "dist/build-info.json"));
    } catch {
      afterBuild = null;
    }
    const result = {
      exitCode: outcome.type === "exit" ? outcome.code : null,
      joined: true,
      baselineJoinedBeforeUpdate: true,
      durationMs: Date.now() - started,
      beforeBuild,
      afterBuild,
      stateDir: temp.stateDir,
      configPath: temp.configPath,
      beforeEntrySha256: baselineIdentity.entrySha256,
      afterEntrySha256: existsSync(join(packageRoot, "dist/entry.js"))
        ? sha(join(packageRoot, "dist/entry.js"))
        : null,
      candidateSha256,
      lifecyclePendingAbsent: !existsSync(join(packageRoot, ".openclaw-lifecycle-pending")),
      legacyInstallGuardAbsent: !existsSync(join(packageRoot, "dist/openclaw-install-guard")),
    };
    save(join(proof, "updater-readback.json"), result);
    requireFact(
      result.exitCode === 0 &&
        result.afterBuild?.commit === candidateHead &&
        result.afterBuild.buildId !== beforeBuild.buildId &&
        result.lifecyclePendingAbsent &&
        result.legacyInstallGuardAbsent &&
        realpathSync(join(prefix, "bin/openclaw")) === join(packageRoot, "openclaw.mjs"),
      "PUBLISHED_UPDATER_FAILED_OR_UNSETTLED",
    );
    save(join(proof, "runtime-candidate.json"), installedIdentity(candidate));
  }
  try {
    const mock = child(
      process.execPath,
      [mockPath],
      {
        ...harness.sanitizeChildEnvironment(driverEnv),
        MOCK_PORT: String(args.mockPort),
        MOCK_REQUEST_LOG: requestLog,
      },
      source,
      "mock",
    );
    await until(
      mock,
      () => /mock-openai listening/u.test(mock.output),
      10000,
      "MOCK_READINESS_DEADLINE",
    );
    gateway = await startGateway(baseline, "gateway-baseline");
    const recorder = child(
      "python3",
      [
        join(scripts, "user-record.py"),
        "--scenario",
        scenarioPath,
        "--ready-file",
        readyPath,
        "--barrier-dir",
        barrierDir,
        "--seconds",
        String(args.timeoutMs / 1000),
        "--record",
        args.record,
        "--output",
        args.output,
        "--chat",
        args.chat,
      ],
      driverEnv,
      source,
      "recorder",
    );
    await until(recorder, () => existsSync(readyPath), 30000, "RECORDER_READINESS_DEADLINE");
    const ready = parseRecorderReady(json(readyPath));
    requireFact(String(ready.chatId) === args.chat, "RECORDER_CHAT_MISMATCH");
    const controls = scope.trackTask(
      (async () => {
        for (const [index, action] of args.scenario.actions.entries()) {
          if (!["command", "restartGateway"].includes(action.type)) {
            continue;
          }
          while (Date.now() - ready.startedAtUnixMs < action.atMs) {
            await scope.sleep(50);
          }
          active();
          live(recorder);
          const began = Date.now();
          if (action.type === "command") {
            const result = await harness.runCommand(action.argv[0], action.argv.slice(1), {
              cwd: source,
              env: commandEnv,
              timeoutMs: action.timeoutMs,
            });
            actions.push(
              harness.summarizeScenarioCommand({
                action,
                result,
                elapsedMs: began - ready.startedAtUnixMs,
                durationMs: Date.now() - began,
              }),
            );
            requireFact(result.status === 0 && !result.timedOut, "AUTHORITATIVE_CHECKPOINT_FAILED");
          } else {
            const stopping = gateway;
            await stopGatewayNormally(
              stopping,
              restartCount === 0 ? "baseline-before-update" : "candidate-restart",
            );
            gateway = undefined;
            active();
            if (++restartCount === 1) {
              await upgrade();
            }
            gateway = await startGateway(candidate, `gateway-candidate-${restartCount}`);
            active();
            live(recorder);
            writeFileSync(join(barrierDir, String(index)), "", { mode: 0o600 });
            actions.push({
              type: "restartGateway",
              elapsedMs: began - ready.startedAtUnixMs,
              durationMs: Date.now() - began,
              status: "completed",
              publishedUpgrade: restartCount === 1,
            });
          }
        }
      })(),
    );
    const outcome = await scope.wait(recorder.done);
    await scope.stopChild(recorder);
    await controls;
    active();
    requireFact(
      outcome.type === "exit" && outcome.code === 0 && restartCount === 2,
      "RECORDER_OR_RESTART_INCOMPLETE",
    );
    const summary = json(args.output);
    save(args.output, { ...summary, scenario: { recorderReady: ready, gatewayActions: actions } });
    requireFact(summary.recordingComplete && !summary.actionError, "RECORDER_SUMMARY_INCOMPLETE");
    const finalGateway = gateway;
    await stopGatewayNormally(finalGateway, "candidate-final");
    gateway = undefined;
    completed = true;
    return { exitCode: 0, report: { completed: true, publishedDriverUpgrade: true } };
  } finally {
    save(join(proof, "gateway-actions.json"), actions);
    await scope.stopChild(gateway, 60000);
  }
}
