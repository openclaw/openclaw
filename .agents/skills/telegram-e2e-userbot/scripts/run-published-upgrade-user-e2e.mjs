#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePublishedUpgradeInputs } from "./published-upgrade-artifact.mjs";
import { drivePublishedUpgrade } from "./published-upgrade-scenario.mjs";
import {
  runTelegramTestScenario,
  runCommand,
  sanitizeChildEnvironment,
} from "./run-mock-sut-user-e2e.mjs";
import { parseScenario } from "./scenario.mjs";
import {
  judgeBindingUpgrade,
  publicUpgradeReport,
  publicUpgradeFailure,
} from "./telegram-binding-upgrade-verdict.mjs";
import { withTelegramRun, runTelegramCli } from "./telegram-run-scope.mjs";
import { acquireTelegramTestCredential } from "./telegram-test-credential.mjs";
import { checkTelegramTestCredential } from "./telegram-test-doctor.mjs";

const prepared = dirname(fileURLToPath(import.meta.url));
const source = resolve(prepared, "../../../..");

export function parseUpgradeArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (
      !["--candidate", "--baseline", "--baseline-spec", "--output"].includes(flag) ||
      !argv[index + 1] ||
      options[flag]
    ) {
      throw new Error("INVALID_UPGRADE_ARGUMENTS");
    }
    options[flag] = argv[index + 1];
  }
  const version = /^openclaw@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/.exec(
    options["--baseline-spec"] ?? "",
  )?.[1];
  if (
    !version ||
    ["--candidate", "--baseline", "--output"].some((flag) => !isAbsolute(options[flag] ?? ""))
  ) {
    throw new Error("EXACT_PUBLISHED_BASELINE_AND_ABSOLUTE_PATHS_REQUIRED");
  }
  return {
    candidate: options["--candidate"],
    baseline: options["--baseline"],
    output: options["--output"],
    version,
  };
}

async function reservePorts() {
  const listeners = [];
  try {
    for (let index = 0; index < 2; index++) {
      const server = net.createServer();
      await new Promise((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
      });
      listeners.push(server);
    }
    return listeners.map((server) => server.address().port);
  } finally {
    await Promise.all(
      listeners.map(
        (server) =>
          new Promise((done) => {
            server.close(done);
          }),
      ),
    );
  }
}

async function runPublishedUpgrade(options, signal) {
  mkdirSync(options.output, { recursive: true, mode: 0o700 });
  const publicPath = join(options.output, "published-upgrade.json");
  if (existsSync(publicPath)) {
    throw new Error("PUBLIC_RESULT_ALREADY_EXISTS");
  }
  const proof = mkdtempSync(join(os.tmpdir(), "openclaw-telegram-published-upgrade-"));
  const outputRoot = realpathSync(options.output);
  if (realpathSync(proof).startsWith(outputRoot.endsWith(sep) ? outputRoot : outputRoot + sep)) {
    rmSync(proof, { recursive: true, force: true });
    throw new Error("PRIVATE_SCRATCH_MUST_BE_OUTSIDE_PUBLIC_OUTPUT");
  }
  const save = (name, value) =>
    writeFileSync(join(proof, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  const temporary = join(proof, "tmp");
  mkdirSync(temporary, { mode: 0o700 });
  process.env.TMPDIR = temporary;
  process.env.TELEGRAM_USER_DRIVER_TDLIB_CACHE_DIR = join(proof, "tdlib");
  let stage = "preflight";
  try {
    const upgrade = await preparePublishedUpgradeInputs(options, signal);
    save("upgrade-input.json", upgrade);
    const ports = await reservePorts();
    const runId = `upgrade-${randomBytes(6).toString("hex")}`;
    process.env.E2E_MOCK_SERVER_PATH = join(source, "scripts/e2e/mock-openai-server.mjs");
    delete process.env.MOCK_RESPONSE_CONTROL;
    delete process.env.E2E_TELEGRAM_MOCK_RESPONSE;
    process.env.E2E_ROOT_CONFIG_PATCH = JSON.stringify({
      tools: { codeMode: false, toolSearch: false },
      session: { threadBindings: { enabled: true, spawnSessions: true } },
      agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } } } },
      logging: { file: join(proof, "gateway-file.log") },
    });
    process.env.E2E_TELEGRAM_CONFIG_PATCH = JSON.stringify({
      threadBindings: { enabled: true, spawnSessions: true },
    });
    const args = {
      upgrade,
      text: "",
      textProvided: false,
      photos: [],
      caption: "",
      expect: [],
      expectPassed: false,
      timeoutMs: 1800000,
      gatewayPort: ports[0],
      mockPort: ports[1],
      backend: "mock",
      anySutReply: false,
      output: join(proof, "summary.json"),
      record: join(proof, "events.ndjson"),
      chat: "",
      dm: false,
      preSend: [],
      scenarioPath: "",
      scenario: null,
      sourceGateway: false,
    };
    let fixture;
    let cleanup;
    const userTexts = ["SPAWN", "BEFORE", "AFTER"].map(
      (phase) => `@{sut} TELEGRAM_BINDING_${phase}_${runId}.`,
    );
    async function tdlib(credential, mode) {
      credential.assertLeaseHealthy();
      const result = await runCommand(
        "python3",
        [join(prepared, "telegram-binding-forum.py"), mode, source, join(proof, "fixture.json")],
        {
          cwd: source,
          env: { ...sanitizeChildEnvironment(), ...credential.driverEnv },
          timeoutMs: 180000,
        },
      );
      credential.assertLeaseHealthy();
      let value;
      try {
        value = JSON.parse(result.stdout);
      } catch {
        value = { ok: false, code: "NO_STRUCTURED_RESULT" };
      }
      if (result.status !== 0 || result.timedOut || value.ok !== true) {
        save(`${mode}-failure.json`, {
          code: /^[A-Z_]+$/.test(value.code ?? "") ? value.code : "TDLIB_OPERATION_FAILED",
          timedOut: Boolean(result.timedOut),
          exitCode: result.status,
        });
        throw new Error(`TDLIB_${mode.toUpperCase()}_FAILED`);
      }
      return value;
    }
    async function acquire(leaseOptions) {
      const credential = await acquireTelegramTestCredential(leaseOptions);
      const originalRelease = credential.release;
      let releasing;
      credential.release = () =>
        (releasing ??= (async () => {
          if (fixture && (fixture.owned || existsSync(args.record))) {
            try {
              cleanup = await withTelegramRun(() => tdlib(credential, "cleanup"), {
                leaseHealth: {
                  assertHealthy: credential.assertLeaseHealthy,
                  whenUnhealthy: credential.whenLeaseUnhealthy,
                },
              });
              save("cleanup.json", cleanup);
            } catch {
              save("cleanup.json", {
                ok: false,
                code: "RECEIPT_CLEANUP_UNCONFIRMED",
                retainedLease: true,
              });
              throw new Error("RECEIPT_CLEANUP_UNCONFIRMED");
            }
          } else {
            cleanup = { ok: true, deleted: 0, reason: "recorder-never-started" };
            save("cleanup.json", cleanup);
          }
          await originalRelease();
          cleanup = { ...cleanup, leaseReleased: true };
          save("cleanup.json", cleanup);
        })());
      return credential;
    }
    async function prepare(credential) {
      const existing =
        /^-\d+$/.test(credential.forumGroupId ?? "") &&
        Number.isSafeInteger(credential.forumTopicId) &&
        credential.forumTopicId > 0;
      fixture = {
        owned: !existing,
        chatId: existing ? credential.forumGroupId : null,
        topicId: existing ? credential.forumTopicId : null,
        runId,
        notBeforeUnixSeconds: Math.floor(Date.now() / 1000) - 2,
        eventsPath: args.record,
        summaryPath: args.output,
        userTexts: userTexts.map((text) => text.replaceAll("{sut}", credential.sutUsername)),
      };
      save("fixture.json", fixture);
      if (!existing) {
        save("preflight.json", { ok: false, status: "preparing-run-owned-forum", sent: false });
        const created = await tdlib(credential, "prepare");
        if (
          created.owned !== true ||
          !/^-\d+$/.test(created.chatId ?? "") ||
          !Number.isSafeInteger(created.topicId) ||
          created.topicId < 1
        ) {
          throw new Error("OWNED_FORUM_SETUP_RESULT_INVALID");
        }
        fixture.chatId = created.chatId;
        fixture.topicId = created.topicId;
        save("fixture.json", fixture);
      }
      args.chat = fixture.chatId;
      const verified = await tdlib(credential, "verify");
      await checkTelegramTestCredential({
        credential,
        chat: args.chat,
        requireForum: true,
        runCommandImpl: (command, argv, commandOptions) => {
          if (existing && argv.includes("prepare-group")) {
            throw new Error("SHARED_FIXTURE_MEMBERSHIP_REPAIR_NOT_PERMITTED");
          }
          return runCommand(
            command === "uv" ? "python3" : command,
            command === "uv" ? argv.slice(1) : argv,
            commandOptions,
          );
        },
      });
      save("preflight.json", { ...verified, standardReadiness: true, ownedFixture: fixture.owned });
      const parent = `agent:main:telegram:group:${fixture.chatId}:topic:${fixture.topicId}`;
      const send = (phase, atMs) => ({
        type: "send",
        atMs,
        text: userTexts[["SPAWN", "BEFORE", "AFTER"].indexOf(phase)],
        forumTopicId: fixture.topicId,
      });
      const checkpoint = (phase, atMs) => ({
        type: "command",
        atMs,
        cwd: "repo",
        timeoutMs: 170000,
        argv: [
          "node",
          join(prepared, "telegram-binding-checkpoint.mjs"),
          phase,
          parent,
          runId,
          join(proof, `routing-${phase}.json`),
          source,
          ...(phase === "spawn"
            ? []
            : [join(proof, `routing-${phase === "before" ? "spawn" : "before"}.json`)]),
        ],
      });
      args.scenario = parseScenario({
        actions: [
          send("SPAWN", 0),
          checkpoint("spawn", 1000),
          { type: "restartGateway", atMs: 2000, graceMs: 60000 },
          send("BEFORE", 3000),
          checkpoint("before", 4000),
          { type: "restartGateway", atMs: 5000, graceMs: 60000 },
          send("AFTER", 6000),
          checkpoint("after", 7000),
        ],
      });
      save("scenario.json", args.scenario);
    }

    stage = "live-scenario";
    const result = await runTelegramTestScenario({
      args,
      repoRoot: source,
      signal,
      acquireCredential: acquire,
      checkCredential: prepare,
      driveScenario: drivePublishedUpgrade,
    });
    stage = "final-judgment";
    const report = publicUpgradeReport(
      judgeBindingUpgrade({
        result,
        proof,
        recordPath: args.record,
        fixture,
        runId,
        upgrade,
        cleanup,
      }),
      upgrade,
      proof,
    );
    writeFileSync(publicPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    rmSync(proof, { recursive: true, force: true });
    return report;
  } catch (error) {
    save("failure.json", { message: String(error?.message ?? "Proof failed") });
    if (!existsSync(publicPath)) {
      writeFileSync(publicPath, JSON.stringify(publicUpgradeFailure(proof, stage)) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    }
    throw new Error("PUBLISHED_UPGRADE_PROOF_FAILED", { cause: error });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseUpgradeArguments(process.argv.slice(2));
    const report = await runTelegramCli((signal) => runPublishedUpgrade(options, signal));
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(
      /^[A-Z_]+$/.test(error?.message ?? "") ? error.message : "PUBLISHED_UPGRADE_PROOF_FAILED",
    );
    process.exitCode = 1;
  }
}
