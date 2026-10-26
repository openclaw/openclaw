import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const library = new URL("./release-lib.mjs", import.meta.url).pathname;
const profile = {
  channels: [["sample-channel", "sample-account"]],
  modelAgent: "sample-agent",
  policy: {
    mode: "full",
    appServer: {
      mode: "yolo",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      defaultWorkspaceDir: "/srv/sample/workspace",
    },
    workspaceOnly: true,
    updateAuto: false,
    clickclackCommandMenu: false,
  },
};
const channels = {
  channelAccounts: { "sample-channel": [{
    accountId: "sample-account", configured: true, enabled: true,
    running: true, connected: true, lifecycle: "ready", restartPending: false, lastError: null,
  }] },
  eventLoop: { degraded: false },
};

function invoke(args, input, selected = profile) {
  const env = { ...process.env };
  env.OPENCLAW_TEAM_OPERATOR_PROFILE =
    typeof selected === "string" ? selected : JSON.stringify(selected);
  return spawnSync(process.execPath, ["--no-warnings", library, ...args], {
    env,
    input: input && JSON.stringify(input),
    encoding: "utf8",
    timeout: 10_000,
  });
}

function configFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "controller-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    update: { auto: { enabled: false } },
    channels: { clickclack: { commandMenu: false } },
    tools: { exec: { mode: "full" }, fs: { workspaceOnly: true } },
    plugins: {
      entries: {
        codex: { config: { appServer: { ...profile.policy.appServer, extra: "preserved" } } },
      },
    },
    agents: { entries: { "sample-agent": { model: "fixture/selected-model" } } },
  };
  const pathname = join(root, "config.json");
  const policy = (selected) => {
    writeFileSync(pathname, JSON.stringify(config));
    return invoke(["policy", pathname], undefined, selected);
  };
  return { config, policy };
}

test("operator channels select configured account identities", () => {
  const result = invoke(["channels", "@stdin"], channels);
  assert.equal(result.status, 0, result.stderr);
  const wrong = structuredClone(channels);
  wrong.channelAccounts["sample-channel"][0].accountId = "other-account";
  assert.notEqual(invoke(["channels", "@stdin"], wrong).status, 0);
});

test("operator profile rejects missing, malformed, or unsafe expectations", () => {
  for (const selected of [
    "",
    "{",
    null,
    {},
    { ...profile, channels: [] },
    { ...profile, channels: [...profile.channels, ...profile.channels] },
    { ...profile, channels: [["sample-channel"]] },
    { ...profile, policy: { ...profile.policy, updateAuto: true } },
  ]) {
    assert.notEqual(invoke(["channels", "@stdin"], channels, selected).status, 0);
  }
});

test("operator policy selects the configured model agent and workspace", (t) => {
  const fixture = configFixture(t);
  const result = fixture.policy();
  assert.equal(result.status, 0, result.stderr);
  const accepted = JSON.parse(result.stdout);
  assert.equal(accepted.model, "fixture/selected-model");
  assert.equal(accepted.appServer.defaultWorkspaceDir, "/srv/sample/workspace");
  assert.equal(accepted.appServer.extra, "preserved");
  fixture.config.plugins.entries.codex.config.appServer.defaultWorkspaceDir =
    "/srv/other/workspace";
  assert.notEqual(fixture.policy().status, 0);
});

test("operator policy requires a selected or default model and forbids unattended updates", (t) => {
  const fixture = configFixture(t);
  assert.notEqual(fixture.policy({ ...profile, modelAgent: "other-agent" }).status, 0);
  fixture.config.agents.defaults = { model: "fixture/default-model" };
  const fallback = fixture.policy({ ...profile, modelAgent: "other-agent" });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).model, "fixture/default-model");
  fixture.config.update.auto.enabled = true;
  assert.notEqual(fixture.policy({
    ...profile, policy: { ...profile.policy, updateAuto: true },
  }).status, 0, "operator profile cannot enable unattended updates");
});

test("operator policy captures only the selected model fallback policy", (t) => {
  const fixture = configFixture(t);
  fixture.config.agents.defaults = { model: { primary: "fixture/default", fallbacks: ["fixture/default-fallback"] } };
  for (const [model, expected] of [
    [undefined, ["fixture/default-fallback"]],
    ["fixture/selected-model", []],
    [{ primary: "fixture/selected-model" }, []],
    [{ primary: "fixture/selected-model", fallbacks: [] }, []],
    [{ primary: "fixture/selected-model", fallbacks: ["fixture/fallback"] }, ["fixture/fallback"]],
  ]) {
    fixture.config.agents.entries["sample-agent"].model = model;
    const result = fixture.policy();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).fallbacks, expected);
  }
  for (const fallbacks of ["fixture/fallback", ["unqualified"], [null]]) {
    fixture.config.agents.entries["sample-agent"].model = { primary: "fixture/selected-model", fallbacks };
    const result = fixture.policy();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configured deployment model fallbacks are invalid/);
  }
});
