import assert from "node:assert/strict";
import { classifyReleaseTrain, parseReleaseVersion } from "../../../lib/release-version.mjs";

// Native cells run sequentially on one disposable Linux guest. Container flows
// retain their own planner and manual restart contract.
export function planNativeUpgradeSurvivor({ flow = "systemd", baselines = ["2026.10.9"] } = {}) {
  assert.equal(flow, "systemd", "Unknown native upgrade-survivor flow");
  assert(baselines.length > 0, "At least one published baseline is required");
  return [...new Set(baselines)].map((version) => {
    const parsed = parseReleaseVersion(version);
    assert(
      parsed && ["stable", "extended-stable"].includes(classifyReleaseTrain(parsed)),
      "Native baselines must be exact published stable or extended-stable versions",
    );
    return {
      flow,
      baseline: `openclaw@${version}`,
      version,
      updateArgs: classifyReleaseTrain(parsed) === "extended-stable" ? ["--channel", "stable"] : [],
    };
  });
}

export function assertNativeUnit(unit, { home, uid }) {
  assert.equal(unit.ActiveState, "active", "Native unit is not active");
  assert.equal(unit.SubState, "running", "Native unit is not running");
  assert(Number(unit.MainPID) > 0, "Native unit has no MainPID");
  assert.equal(unit.FragmentPath, `${home}/.config/systemd/user/openclaw-gateway.service`);
  assert(
    unit.ControlGroup.startsWith(`/user.slice/user-${uid}.slice/user@${uid}.service/`),
    "Gateway is outside the native user manager",
  );
  assert(unit.ControlGroup.endsWith("/openclaw-gateway.service"));
}

export function assertNativeUpdate({ result, before, after, rpc, candidate }) {
  assert.equal(result.status, "ok", `Native update failed: ${result.reason}`);
  assert.equal(result.run?.status, "succeeded", "Updater did not record success");
  const verification = result.run.verification;
  for (const fact of [
    "serviceRunning",
    "versionMatch",
    "channelsReady",
    "readyz",
    "coreReady",
    "settled",
  ]) {
    assert.equal(verification?.[fact], true, `Updater verification missing ${fact}`);
  }
  assert.deepEqual(verification.pluginErrors, []);
  assert(
    result.steps.some((step) => step.name === "gateway verification" && step.exitCode === 0),
    "Updater did not verify its restart",
  );
  assert.notEqual(before.MainPID, after.MainPID, "Native MainPID did not change");
  assert.equal(
    Number(verification.pid),
    Number(after.MainPID),
    "Recorded PID differs from native MainPID",
  );
  assert.equal(rpc.rpc?.ok, true, "Authenticated candidate RPC failed");
  assert.equal(rpc.rpc.server.version, candidate.version);
  assert.equal(rpc.rpc.server.buildId, candidate.buildId, "Serving build differs from candidate");
}
