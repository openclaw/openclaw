import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toErrorObject } from "../../../lib/error-format.mts";
import { hasUnjoinedWork } from "../../../lib/managed-child-process.mts";

// A real service command override makes the installed server reject the CLI's
// configured credential. No RPC or readiness owner is replaced by this fixture.
export function withReadinessAuthFault(unit) {
  const lines = unit.split("\n");
  const starts = lines.flatMap((line, index) => (line.startsWith("ExecStart=") ? [index] : []));
  assert.equal(starts.length, 1, "Expected one generated service command");
  const index = starts[0];
  assert(
    !/--token(?:[ =]|$)/u.test(lines[index]),
    "Fixture must not replace an existing token argument",
  );
  lines[index] += " --token repair-readiness-synthetic-server-token";
  return lines.join("\n");
}

export async function proveRepairReadiness({
  run,
  output,
  env,
  build,
  port,
  token,
  gateway,
  sessions,
  orphanSidecar,
}) {
  const unitPath = path.join(env.HOME, ".config/systemd/user/openclaw-gateway.service");
  const unit = fs.readFileSync(unitPath, "utf8");
  const config = fs.readFileSync(env.OPENCLAW_CONFIG_PATH);
  const sidecar = fs.readFileSync(orphanSidecar);
  const systemctl = path.join(env.npm_config_prefix, "bin/systemctl");
  const preserved = () => {
    assert.deepEqual(
      fs.readFileSync(env.OPENCLAW_CONFIG_PATH),
      config,
      "Lifecycle changed configuration",
    );
    assert.deepEqual(
      fs.readFileSync(orphanSidecar),
      sidecar,
      "Lifecycle changed credential sidecar",
    );
  };
  const observe = async (name, credential) => {
    await run(name, "openclaw", [
      "gateway",
      "probe",
      "--url",
      "ws://127.0.0.1:" + port,
      "--token",
      credential,
      "--json",
    ]);
    const target = output(name).targets.find((entry) => entry.url === "ws://127.0.0.1:" + port);
    assert.equal(target?.connect.ok, true, "Real installed Gateway connection failed");
    assert.equal(target.server.version, build.version);
    assert.equal(typeof build.buildId, "string", "Candidate build identity missing");
    assert.equal(target.server.buildId, build.buildId, "Serving a different candidate build");
    const health = await gateway(name + "-health", "health", {}, credential);
    assert.equal(health.ok, true);
    assert.equal(health.readiness?.state, "ready", "Healthy control is not operational");
    return { server: target.server, readiness: health.readiness };
  };
  const restart = async (name, strict, allowFailure = false) => {
    assert.equal(env.OPENCLAW_UPDATE_IN_PROGRESS, undefined, "Unexpected inherited update marker");
    if (strict) {
      env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    }
    try {
      // Preserve the deliberately divergent service command rather than invoking
      // service repair. Both cells execute the same shipped CLI entry point.
      return await run(
        name,
        "openclaw",
        ["gateway", "restart", "--preserve-definition", "--json"],
        allowFailure,
      );
    } finally {
      delete env.OPENCLAW_UPDATE_IN_PROGRESS;
    }
  };
  const before = await observe("readiness-healthy-before", token);
  let failure;
  let proof;
  try {
    fs.writeFileSync(unitPath, withReadinessAuthFault(unit));
    await run("readiness-load-fault", systemctl, ["--user", "daemon-reload"]);
    await restart("readiness-lifecycle", false);
    const ordinary = output("readiness-lifecycle");
    assert.equal(ordinary.ok, true);
    assert.equal(ordinary.result, "restarted");
    assert(
      ordinary.warnings?.some((warning) =>
        warning.includes("Gateway readiness: reachable (health-unavailable)"),
      ),
      "Ordinary restart did not retain the auth-liveness warning",
    );
    const faultToken = "repair-readiness-synthetic-server-token";
    const faulted = await observe("readiness-authenticated-control", faultToken);
    const strictExit = await restart("readiness-strict", true, true);
    // A timeout/kill of the harness is not an accepted refusal. run() throws on
    // either; require the CLI's own completed structured rejection here.
    assert.equal(strictExit.status, 1);
    assert.equal(strictExit.signal, null);
    const strict = output("readiness-strict");
    assert.equal(strict.ok, false);
    assert.equal(strict.result, "restart-health-failed");
    assert(
      strict.warnings?.some((warning) => warning.includes("Gateway readiness: reachable")),
      "Strict refusal did not report the observed readiness",
    );
    const afterRefusal = await observe("readiness-after-refusal", faultToken);
    preserved();
    const durable = sessions.find((session) => session.kind === "durable");
    assert(durable);
    const history = await gateway(
      "readiness-preserved-history",
      "chat.history",
      { ...durable.params, limit: 20 },
      faultToken,
    );
    assert.equal(history.sessionId, durable.sessionId);
    assert(
      JSON.stringify(history.messages).includes(durable.marker),
      "Strict refusal lost durable history",
    );
    proof = { before, faulted, afterRefusal, ordinary, strict, strictExit, preserved: true };
  } catch (error) {
    failure = toErrorObject(error, "Readiness proof failed");
  }
  // Never mutate a fixture with unjoined owned work. The outer custody owner
  // retains it for diagnosis rather than inventing a second cleanup route.
  let restorationFailure;
  if (!hasUnjoinedWork(failure)) {
    try {
      fs.writeFileSync(unitPath, unit);
      await run("readiness-restore-unit", systemctl, ["--user", "daemon-reload"]);
    } catch (restoreError) {
      restorationFailure = toErrorObject(restoreError, "Readiness fixture restoration failed");
    }
  }
  if (restorationFailure) {
    failure = failure
      ? Object.assign(
          new AggregateError(
            [failure, restorationFailure],
            "Readiness proof and fixture restoration failed",
            { cause: failure },
          ),
          { command: failure.command, exitCode: failure.exitCode, code: failure.code },
        )
      : restorationFailure;
  }
  if (failure) {
    throw failure;
  }
  await restart("readiness-recovered", true);
  const recovered = await observe("readiness-healthy-after", token);
  preserved();
  await run("readiness-stop", "openclaw", ["gateway", "stop", "--force", "--json"]);
  await run("readiness-stopped-status", "openclaw", ["gateway", "status", "--json"]);
  const stopped = output("readiness-stopped-status");
  assert.equal(stopped.service.runtime.status, "stopped");
  assert.equal(stopped.rpc.ok, false, "Stopped Gateway unexpectedly accepted RPC");
  assert.equal(fs.readFileSync(unitPath, "utf8"), unit);
  preserved();
  return {
    ...proof,
    recovered,
    stopped: true,
    fixture: "generated-unit manager shim; not operator systemd",
    limit:
      "The auth fault replays the candidate restart CLI with the shipped updater marker after a successful published-driver update; it does not claim a faulted published updater run.",
  };
}
