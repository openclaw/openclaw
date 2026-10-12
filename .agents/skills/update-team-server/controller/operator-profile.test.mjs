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
const account = {
  accountId: "sample-account",
  configured: true,
  enabled: true,
  running: true,
  connected: true,
  lifecycle: "ready",
  restartPending: false,
  lastError: null,
};
const channels = {
  channelAccounts: { "sample-channel": [account] },
  eventLoop: { degraded: false },
};

function invoke(args, selected = profile, input) {
  const env = { ...process.env };
  delete env.OPENCLAW_TEAM_OPERATOR_PROFILE;
  if (selected !== undefined)
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
  const write = () => writeFileSync(pathname, JSON.stringify(config));
  write();
  return { pathname, config, write };
}

test("operator channels select configured account identities", () => {
  const result = invoke(["channels", "@stdin"], profile, channels);
  assert.equal(result.status, 0, result.stderr);
  const wrong = structuredClone(channels);
  wrong.channelAccounts["sample-channel"][0].accountId = "other-account";
  assert.notEqual(invoke(["channels", "@stdin"], profile, wrong).status, 0);
});

test("operator channels cannot be omitted, emptied, duplicated, or malformed", () => {
  for (const selected of [
    "",
    "{",
    null,
    {},
    { ...profile, channels: [] },
    { ...profile, channels: [...profile.channels, ...profile.channels] },
    { ...profile, channels: [["sample-channel"]] },
  ]) {
    assert.notEqual(invoke(["channels", "@stdin"], selected, channels).status, 0);
  }
});

test("operator policy selects the configured model agent and workspace", (t) => {
  const fixture = configFixture(t);
  const result = invoke(["policy", fixture.pathname]);
  assert.equal(result.status, 0, result.stderr);
  const accepted = JSON.parse(result.stdout);
  assert.equal(accepted.model, "fixture/selected-model");
  assert.equal(accepted.appServer.defaultWorkspaceDir, "/srv/sample/workspace");
  assert.equal(accepted.appServer.extra, "preserved");
  fixture.config.plugins.entries.codex.config.appServer.defaultWorkspaceDir =
    "/srv/other/workspace";
  fixture.write();
  assert.notEqual(invoke(["policy", fixture.pathname]).status, 0);
});

test("operator policy rejects missing expectations and missing selected model", (t) => {
  const fixture = configFixture(t);
  for (const selected of [
    "",
    {},
    { ...profile, channels: undefined },
    { ...profile, channels: [] },
    { modelAgent: "sample-agent", policy: {} },
    { ...profile, modelAgent: "other-agent" },
    { ...profile, policy: { ...profile.policy, updateAuto: true } },
  ]) {
    assert.notEqual(invoke(["policy", fixture.pathname], selected).status, 0);
  }
  fixture.config.agents.defaults = { model: "fixture/default-model" };
  fixture.write();
  const fallback = invoke(["policy", fixture.pathname], { ...profile, modelAgent: "other-agent" });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).model, "fixture/default-model");
  fixture.config.update.auto.enabled = true;
  fixture.write();
  assert.notEqual(invoke(["policy", fixture.pathname], {
    ...profile, policy: { ...profile.policy, updateAuto: true },
  }).status, 0, "operator profile cannot enable unattended updates");
});
