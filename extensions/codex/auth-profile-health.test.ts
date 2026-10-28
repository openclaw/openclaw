import fs from "node:fs/promises";
import path from "node:path";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { HealthCheck, OpenClawConfig } from "openclaw/plugin-sdk/health";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { registerCodexManagedAppServerDoctorChecks } from "./api.js";
import plugin from "./index.js";

const CHECK_ID = "codex/native-profile-recovery";
const IMPORT_COMMAND = "openclaw models auth login --provider openai --method device-code";
const config: OpenClawConfig = {
  auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
  agents: { entries: { main: {}, worker: {} } },
};
const credentials = { access: "synthetic-access", refresh: "synthetic-refresh", expires: 2e12 };
const managedStore: AuthProfileStore = {
  version: 1,
  profiles: { "openai:default": { type: "oauth", provider: "openai", ...credentials } },
};
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

const checks: HealthCheck[] = [];
registerCodexManagedAppServerDoctorChecks({
  getHealthCheck: (id) => checks.find((check) => check.id === id),
  registerHealthCheck: (check) => checks.push(check),
});
function recoveryCheck() {
  const check = checks.find((candidate) => candidate.id === CHECK_ID);
  assert(check, "Doctor must register the recovery finding");
  return check;
}
const healthCheck = recoveryCheck();

async function doctorState() {
  const state = await createOpenClawTestState({ applyEnv: false });
  onTestFinished(() => state.cleanup());
  const detect = (cfg = config) =>
    healthCheck.detect({ mode: "fix", cfg, env: state.env, runtime });
  return { state, detect };
}
const warning = (text: string, fixHint: string) =>
  expect.objectContaining({ severity: "warning", message: expect.stringContaining(text), fixHint });

it("reports missing agent-local profiles without importing native credentials, then recovers", async () => {
  const { state, detect } = await doctorState();
  await expect(detect({})).resolves.toEqual([]);
  await state.writeAuthProfiles(managedStore, "worker");
  const clock = createGatewaySchedulerClock();
  const host = createTestGatewayScheduler(clock.clock);
  const scheduler = createTestPluginServiceScheduler(host);
  onTestFinished(() => scheduler.stop().then(() => host.stop()));
  const nativeHome = path.join(state.home, ".codex");
  await fs.mkdir(nativeHome, { recursive: true });
  const nativeAuth =
    '{"tokens":{"access_token":"synthetic-access","refresh_token":"synthetic-refresh"}}';
  await fs.writeFile(path.join(nativeHome, "auth.json"), nativeAuth);
  const findings = await detect();
  expect(findings).toEqual([warning("2026.9.5", IMPORT_COMMAND)]);
  expect(findings[0]?.message).toContain("native Codex login");
  expect(findings[0]?.message).toContain("Affected agents: main.");
  expect(findings[0]?.message).not.toMatch(/HTTP 401|re-authenticate/);
  state.applyEnv();
  setRuntimeConfigSnapshot(config);
  const captured = createCapturedPluginRegistration({ config });
  const services = vi.spyOn(captured.api, "registerService");
  plugin.register(captured.api);
  const recovery = services.mock.calls.find(([service]) => service.id === CHECK_ID)?.[0];
  assert(recovery, "Gateway startup must register the same recovery check");
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  await recovery.start({ config, stateDir: state.stateDir, logger, scheduler });
  expect(logger.warn).not.toHaveBeenCalled();
  await clock.wake();
  expect(logger.warn).toHaveBeenCalledExactlyOnceWith(findings[0]?.message);
  expect(await fs.readFile(path.join(nativeHome, "auth.json"), "utf8")).toBe(nativeAuth);
  expect(loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles).toEqual({});

  await state.writeAuthProfiles(managedStore);
  await expect(detect()).resolves.toEqual([]);
  logger.warn.mockClear();
  await recovery.start({ config, stateDir: state.stateDir, logger, scheduler });
  await clock.wake();
  expect(logger.warn).not.toHaveBeenCalled();
});

it("reports an unreadable store separately from the retired native overlay", async () => {
  const { state, detect } = await doctorState();
  await state.writeText("agents/worker/agent/openclaw-agent.sqlite", "not sqlite");
  const findings = await detect();
  expect(findings).toEqual([
    warning("unreadable", "openclaw doctor --fix"),
    expect.objectContaining({ message: expect.stringContaining("Affected agents: main.") }),
  ]);
  expect(findings[0]?.message).not.toMatch(/2026\.9\.5|HTTP 401|sign in/);
});
