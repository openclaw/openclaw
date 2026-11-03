import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasUnjoinedWork, runManagedCommand } from "../lib/managed-child-process.mts";

// This fixture needs the disposable native CI account, not an operator desktop.
assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_OS, "macOS");
assert.ok(process.env.RUNNER_TEMP);
const harnessRepository = process.cwd();
assert.equal(process.argv[2], "candidate");
const repository = fs.realpathSync(path.join(harnessRepository, process.argv[2]));
const evidence = path.join(harnessRepository, ".artifacts/macos-local-auth-proof");
fs.mkdirSync(evidence, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "local-auth-")));
const binary = path.join(repository, "dist/OpenClaw.app/Contents/MacOS/OpenClaw");
assert.ok(fs.existsSync(binary));
const candidate = "8149b98130829cb7d83ec153c9bc9355bcc7cc64";
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  candidate,
);
assert.equal(
  execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim(),
  "",
);
const stableCli = path.join(harnessRepository, "stable-runtime/node_modules/openclaw/openclaw.mjs");
const stableBinary = path.join(
  harnessRepository,
  "stable-app/OpenClaw.app/Contents/MacOS/OpenClaw",
);
process.chdir(repository);

const results: Record<string, unknown>[] = [];
const syntheticValues: string[] = [];
const runnerNames = [process.env.HOME, os.hostname(), os.userInfo().username];
for (const property of ["ComputerName", "LocalHostName"]) {
  runnerNames.push(execFileSync("scutil", ["--get", property], { encoding: "utf8" }).trim());
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function sanitized(value: string): string {
  let result = value
    .replaceAll(root, "<fixture>")
    .replaceAll(repository, "<candidate>")
    .replaceAll(harnessRepository, "<harness>");
  for (const secret of syntheticValues) {
    result = result.replaceAll(secret, "<synthetic-credential>");
  }
  for (const privateValue of runnerNames) {
    if (privateValue) {
      result = result.replaceAll(privateValue, "<runner>");
    }
  }
  return result;
}

async function command(
  name: string,
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number> {
  const raw = path.join(root, `${name}.log`);
  const descriptor = fs.openSync(raw, "w", 0o600);
  try {
    return await runManagedCommand({
      bin,
      args,
      env,
      stdio: ["ignore", descriptor, descriptor],
      requireProcessTreeExit: true,
      timeoutMs: options.timeoutMs ?? 180_000,
      signal: options.signal,
    });
  } finally {
    fs.closeSync(descriptor);
    fs.writeFileSync(path.join(evidence, `${name}.log`), sanitized(fs.readFileSync(raw, "utf8")));
  }
}

type Surface = "token" | "password";
type Scenario = {
  name: string;
  surface: Surface;
  kind:
    | "typed-password-remote-token"
    | "suppressed-password-remote-token"
    | "typed-token-remote-password"
    | "suppressed-password-remote-password"
    | "shorthand-dollar"
    | "shorthand-braced";
  upgrade?: boolean;
};

async function observe(scenario: Scenario, port: number): Promise<void> {
  const { name, surface } = scenario;
  const profile = `auth-proof-${randomUUID().slice(0, 8)}`;
  // Native service ownership is anchored to the OS account, not a relocated HOME.
  // The disposable CI account and a fresh named profile provide the isolation.
  const home = os.userInfo().homedir;
  assert.equal(process.env.HOME, home);
  const state = path.join(home, `.openclaw-${profile}`);
  const configPath = path.join(state, "openclaw.json");
  const plist = path.join(home, "Library/LaunchAgents", `ai.openclaw.${profile}.plist`);
  assert.ok(!fs.existsSync(state), "Refusing to reuse an existing profile");
  assert.ok(!fs.existsSync(plist), "Refusing to reuse an existing service");
  const temporary = path.join(root, name, "tmp");
  const keychain = path.join(root, name, "proof.keychain-db");
  for (const directory of [
    state,
    temporary,
    path.dirname(keychain),
    path.join(home, "Library/Preferences"),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "DEVELOPER_DIR",
    "SDKROOT",
    "TOOLCHAINS",
    "LANG",
    "RUNNER_TRACKING_ID",
  ]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  Object.assign(env, {
    HOME: home,
    TMPDIR: `${temporary}/`,
    OPENCLAW_PROFILE: profile,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
  const credential = `synthetic-${randomUUID()}`;
  const otherCredential = `synthetic-${randomUUID()}`;
  syntheticValues.push(credential, otherCredential);
  const ref = { source: "env", provider: "proof", id: "GW_PROOF_CREDENTIAL" };
  const shorthand = scenario.kind.startsWith("shorthand-");
  const suppressed = scenario.kind.startsWith("suppressed-");
  const typedToken = scenario.kind === "typed-token-remote-password";
  const auth = shorthand
    ? {
        password:
          scenario.kind === "shorthand-dollar" ? "$GW_PROOF_MISSING" : "${GW_PROOF_MISSING}",
      }
    : { [typedToken ? "token" : "password"]: ref };
  const remote = shorthand
    ? {}
    : scenario.kind.endsWith("remote-token")
      ? { token: otherCredential }
      : { password: typedToken ? credential : otherCredential };
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth,
      remote,
    },
    secrets: { providers: { proof: { source: "env", allowlist: ["GW_PROOF_CREDENTIAL"] } } },
    logging: {
      level: "debug",
      consoleLevel: "debug",
      consoleStyle: "json",
      file: path.join(state, "gateway.jsonl"),
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const durableEnv: Record<string, string> = shorthand
    ? {}
    : {
        GW_PROOF_CREDENTIAL: typedToken || suppressed ? otherCredential : credential,
      };
  if (shorthand || suppressed) {
    durableEnv.OPENCLAW_GATEWAY_TOKEN = credential;
  }
  fs.writeFileSync(
    path.join(state, ".env"),
    Object.entries(durableEnv)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    { mode: 0o600 },
  );
  const authoredEnv = fs.readFileSync(path.join(state, ".env"), "utf8");
  const appEnv = { ...env };
  const retainedFile = path.join(state, "workspace", "USER.md");
  fs.mkdirSync(path.dirname(retainedFile), { recursive: true });
  const retainedContents = "Synthetic upgrade fixture: retain this user document.\n";
  fs.writeFileSync(retainedFile, retainedContents);
  const wrapper = path.join(root, name, "gateway-wrapper");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scenario.upgrade ? stableCli : path.join(repository, "openclaw.mjs"))} "$@" --verbose --ws-log full\n`,
    { mode: 0o700 },
  );
  let cliEntry = scenario.upgrade ? stableCli : path.join(repository, "openclaw.mjs");
  const cli = (suffix: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    command(`${name}-${suffix}`, process.execPath, [cliEntry, "--profile", profile, ...args], {
      ...env,
      ...extraEnv,
    });
  let keychainCreated = false;
  const failures: unknown[] = [];
  const result: Record<string, unknown> = {
    name,
    scenario,
    port,
    profile,
    productionRevision: candidate,
  };
  results.push(result);
  try {
    for (const args of [
      ["create-keychain", "-p", "", keychain],
      ["unlock-keychain", "-p", "", keychain],
      ["set-keychain-settings", keychain],
      ["list-keychains", "-d", "user", "-s", keychain],
      ["default-keychain", "-d", "user", "-s", keychain],
    ]) {
      assert.equal(
        await command(`${name}-${args[0]}`, "security", args, env, { timeoutMs: 30_000 }),
        0,
      );
      keychainCreated = true;
    }
    const suite = `ai.openclaw.mac.profile.${profile}`;
    for (const [key, type, value] of [
      ["openclaw.onboardingSeen", "-bool", "true"],
      ["openclaw.onboardingVersion", "-int", "8"],
      ["openclaw.computerControlEnabled", "-bool", "false"],
      ["openclaw.swabbleEnabled", "-bool", "false"],
      ["openclaw.gatewayProjectRootPath", "-string", repository],
    ]) {
      assert.equal(
        await command(`${name}-${key}`, "defaults", ["write", suite, key, type, value], env),
        0,
      );
    }
    // Installation owns activation; no direct launchctl bootstrap or hand-written plist.
    assert.equal(
      await cli(
        "install",
        [
          "gateway",
          "install",
          "--port",
          String(port),
          "--runtime",
          "node",
          "--wrapper",
          wrapper,
          "--json",
        ],
        {},
      ),
      0,
    );
    const installedConfigText = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      path.join(evidence, `${name}-installed-config.json`),
      sanitized(installedConfigText),
    );
    const installedConfig = JSON.parse(installedConfigText);
    assert.deepEqual(installedConfig.gateway.auth, auth);
    result.installedAuthInputPreserved = true;
    const serviceEnvironment = path.join(state, "service-env", `ai.openclaw.${profile}.env`);
    const snapshot = fs.readFileSync(serviceEnvironment, "utf8");
    result.serviceSnapshotHasCredential = snapshot.includes(credential);
    result.serviceSnapshotHasRefKey = snapshot.includes("GW_PROOF_CREDENTIAL=");
    assert.equal(result.serviceSnapshotHasCredential, !typedToken);
    assert.equal(result.serviceSnapshotHasRefKey, !shorthand);
    const readinessDeadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < readinessDeadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        });
        ready = response.ok;
      } catch {
        /* A service still starting has no HTTP listener yet. */
      }
      if (ready) {
        break;
      }
      await delay(1_000);
    }
    result.serviceReady = ready;
    assert.ok(ready, "The actual installed Gateway did not become ready");
    const phases = scenario.upgrade ? ["stable", "candidate"] : ["candidate"];
    for (const phase of phases) {
      if (scenario.upgrade && phase === "candidate") {
        assert.equal(await cli("stop-stable", ["gateway", "stop", "--json"]), 0);
        // Replace the installed native bundle in the same fixture-owned location.
        // This exercises manual developer-candidate replacement, not Sparkle or signing continuity.
        fs.rmSync(path.join(root, name, "OpenClaw.app"), { recursive: true, force: true });
        execFileSync("/usr/bin/ditto", [
          path.join(repository, "dist/OpenClaw.app"),
          path.join(root, name, "OpenClaw.app"),
        ]);
        execFileSync("codesign", [
          "--verify",
          "--deep",
          "--strict",
          path.join(root, name, "OpenClaw.app"),
        ]);
        cliEntry = path.join(repository, "openclaw.mjs");
        fs.writeFileSync(
          wrapper,
          `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliEntry)} "$@" --verbose --ws-log full\n`,
          { mode: 0o700 },
        );
        assert.equal(
          await cli("upgrade-service", [
            "gateway",
            "install",
            "--force",
            "--port",
            String(port),
            "--runtime",
            "node",
            "--wrapper",
            wrapper,
            "--json",
          ]),
          0,
        );
        assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).gateway.auth, auth);
        assert.equal(fs.readFileSync(retainedFile, "utf8"), retainedContents);
        result.upgradeAuthAndWorkspacePreserved = true;
      } else if (scenario.upgrade) {
        execFileSync("/usr/bin/ditto", [
          path.dirname(path.dirname(path.dirname(stableBinary))),
          path.join(root, name, "OpenClaw.app"),
        ]);
        execFileSync("codesign", [
          "--verify",
          "--deep",
          "--strict",
          path.join(root, name, "OpenClaw.app"),
        ]);
      }
      const protocolLog = path.join(state, "gateway.jsonl");
      const protocolOffset = fs.existsSync(protocolLog)
        ? fs.readFileSync(protocolLog, "utf8").length
        : 0;
      const phaseResult: Record<string, unknown> = { phase, startedAt: new Date().toISOString() };
      result[phase] = phaseResult;
      const controller = new AbortController();
      const app = command(
        `${name}-${phase}-app`,
        scenario.upgrade ? path.join(root, name, "OpenClaw.app/Contents/MacOS/OpenClaw") : binary,
        ["--attach-only", "--chat"],
        appEnv,
        {
          signal: controller.signal,
          timeoutMs: 90_000,
        },
      ).then(
        (exit) => ({ exit }),
        (error: unknown) => ({ error }),
      );
      const phaseFailures: unknown[] = [];
      try {
        // Require a protected RPC on the native app's own authenticated connection.
        const deadline = Date.now() + 60_000;
        let connected: string | undefined;
        while (Date.now() < deadline && !connected) {
          const text = fs.existsSync(protocolLog)
            ? fs.readFileSync(protocolLog, "utf8").slice(protocolOffset)
            : "";
          const messages = text.split("\n").flatMap((line) => {
            try {
              return Object.values(JSON.parse(line)).filter(
                (value): value is string => typeof value === "string",
              );
            } catch {
              return [line];
            }
          });
          for (const message of messages) {
            if (
              !message.includes("client=openclaw-macos ") ||
              !message.includes("mode=ui ") ||
              !message.includes(`auth=${surface}`)
            ) {
              continue;
            }
            // Stable emits the authenticated connect event with a shortened ID;
            // newer builds emit a full-ID client-connected event instead.
            const connection =
              /client connected conn=([a-f0-9-]+)/.exec(message)?.[1] ??
              (message.startsWith("← connect ")
                ? /\bconn=([a-f0-9]+…[a-f0-9]+)/.exec(message)?.[1]
                : undefined);
            if (!connection) {
              continue;
            }
            const short =
              !connection.includes("…") && connection.length > 12
                ? `${connection.slice(0, 8)}…${connection.slice(-4)}`
                : connection;
            if (
              messages.some(
                (entry) => entry.includes("res ✓ config.get") && entry.includes(`conn=${short}`),
              )
            ) {
              connected = connection;
              break;
            }
          }
          if (!connected) {
            await delay(1_000);
          }
        }
        assert.ok(
          connected,
          "No successful protected config.get on a native UI connection with expected auth",
        );
        phaseResult.nativeConnection = connected;
        phaseResult.protectedConfigGet = true;
        assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).gateway.auth, auth);
        assert.equal(fs.readFileSync(retainedFile, "utf8"), retainedContents);
        for (const [key, expected] of [
          ["openclaw.computerControlEnabled", "0"],
          ["openclaw.swabbleEnabled", "0"],
          ["openclaw.gatewayProjectRootPath", repository],
        ]) {
          assert.equal(
            execFileSync("defaults", ["read", suite, key], { env, encoding: "utf8" }).trim(),
            expected,
          );
        }
        const observedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
        for (const key of ["mode", "bind", "port", "remote"]) {
          assert.deepEqual(observedConfig.gateway[key], config.gateway[key]);
        }
        assert.deepEqual(observedConfig.secrets.providers, config.secrets.providers);
        assert.equal(fs.readFileSync(path.join(state, ".env"), "utf8"), authoredEnv);
        phaseResult.authAndWorkspacePreserved = true;
        phaseResult.namedPreferencesPreserved = true;
        phaseResult.serviceHealthy = (
          await fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: AbortSignal.timeout(1_000),
          })
        ).ok;
        assert.equal(phaseResult.serviceHealthy, true);
      } catch (error) {
        phaseResult.failure = sanitized(String(error));
        phaseFailures.push(error);
      } finally {
        controller.abort();
        const outcome = await app;
        if ("error" in outcome) {
          const error = outcome.error;
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ABORT_ERR") {
            phaseResult.appFailure = sanitized(String(error));
            phaseFailures.push(error);
          } else {
            phaseResult.appExit = "stopped-after-observation";
          }
        } else {
          phaseResult.appExit = outcome.exit;
        }
        phaseResult.finishedAt = new Date().toISOString();
        // Native Logger output goes to unified logging, not stdout. Capture it
        // on the disposable account so early socket retirement is diagnosable.
        try {
          phaseResult.nativeLogExit = await command(
            `${name}-${phase}-native-log`,
            "/usr/bin/log",
            [
              "show",
              "--last",
              "90s",
              "--style",
              "json",
              "--debug",
              "--info",
              "--predicate",
              'process == "OpenClaw"',
            ],
            env,
            { timeoutMs: 30_000 },
          );
        } catch (error) {
          phaseResult.nativeLogError = sanitized(String(error));
          if (hasUnjoinedWork(error)) {
            phaseFailures.push(error);
          }
        }
      }
      if (phaseFailures.length) {
        throw new AggregateError(phaseFailures, `${name} ${phase} observation failed`);
      }
    }
    result.serviceStatusExit = await cli("status", ["gateway", "status", "--json", "--no-probe"]);
  } catch (error) {
    result.failure = sanitized(String(error));
    failures.push(error);
  } finally {
    const cleanup = await Promise.allSettled([
      fs.existsSync(plist)
        ? cli("uninstall", ["gateway", "uninstall", "--json"])
        : Promise.resolve(0),
      keychainCreated
        ? command(`${name}-keychain-cleanup`, "security", ["delete-keychain", keychain], env)
        : Promise.resolve(0),
    ]);
    result.cleanup = cleanup.map((entry) =>
      entry.status === "fulfilled"
        ? { exit: entry.value }
        : { error: sanitized(String(entry.reason)) },
    );
    const cleanupSucceeded = cleanup.every(
      (entry) => entry.status === "fulfilled" && entry.value === 0,
    );
    for (const [file, label] of [
      [path.join(state, "gateway.jsonl"), "gateway"],
      [path.join(home, "Library/Logs/openclaw", `gateway-${profile}.log`), "supervisor"],
    ]) {
      if (fs.existsSync(file)) {
        fs.writeFileSync(
          path.join(evidence, `${name}-${label}.log`),
          sanitized(fs.readFileSync(file, "utf8")),
        );
      }
    }
    result.cleanupSucceeded = cleanupSucceeded;
    if (!cleanupSucceeded) {
      failures.push(new Error("An owned native fixture did not clean up"));
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `${name} native fixture failed`);
  }
}

try {
  const scenarios: Scenario[] = [
    {
      name: "typed-password-remote-token",
      kind: "typed-password-remote-token",
      surface: "password",
    },
    {
      name: "suppressed-password-remote-token",
      kind: "suppressed-password-remote-token",
      surface: "token",
    },
    {
      name: "typed-token-remote-password",
      kind: "typed-token-remote-password",
      surface: "password",
    },
    {
      name: "suppressed-password-remote-password",
      kind: "suppressed-password-remote-password",
      surface: "token",
    },
    { name: "upgrade-shorthand-dollar", kind: "shorthand-dollar", surface: "token", upgrade: true },
    { name: "upgrade-shorthand-braced", kind: "shorthand-braced", surface: "token", upgrade: true },
  ];
  const scenarioFailures: unknown[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    try {
      await observe(scenario, 19891 + index);
    } catch (error) {
      // A failed scenario must not hide independent cases, but failed cleanup
      // means the disposable account is no longer qualified for another case.
      const result = results.at(-1);
      if (
        hasUnjoinedWork(error) ||
        result?.name !== scenario.name ||
        result.cleanupSucceeded !== true
      ) {
        throw error;
      }
      scenarioFailures.push(error);
    }
  }
  if (scenarioFailures.length) {
    throw new AggregateError(scenarioFailures, "Native authentication scenarios failed");
  }
} finally {
  fs.writeFileSync(
    path.join(evidence, "observations.json"),
    JSON.stringify(
      {
        revision,
        stable: "v2026.10.9",
        candidate,
        scope: "Actual app and installed local Gateway; observations require independent judgment.",
        results,
      },
      null,
      2,
    ),
  );
}
