import fs from "node:fs/promises";
import path from "node:path";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { HealthCheck, OpenClawConfig } from "openclaw/plugin-sdk/health";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { assert, describe, expect, it, vi } from "vitest";
import { registerCodexManagedAppServerDoctorChecks } from "./api.js";
import plugin from "./index.js";

const CHECK_ID = "codex/native-profile-recovery";
const IMPORT_COMMAND = "openclaw models auth login --provider openai --method device-code";
const config: OpenClawConfig = {
  auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
  agents: { entries: { main: {}, worker: {} } },
};
const managedStore: AuthProfileStore = {
  version: 1,
  profiles: {
    "openai:default": {
      type: "oauth",
      provider: "openai",
      access: "synthetic-managed-access",
      refresh: "synthetic-managed-refresh",
      expires: 1_893_456_000_000,
    },
  },
};

function recoveryCheck() {
  const checks = new Map<string, HealthCheck>();
  const host = {
    getHealthCheck: (id: string) => checks.get(id),
    registerHealthCheck: (check: HealthCheck) => checks.set(check.id, check),
  };
  registerCodexManagedAppServerDoctorChecks(host);
  const check = checks.get(CHECK_ID);
  assert(check, "Doctor must register the recovery finding");
  return check;
}

function doctorContext(state: OpenClawTestState, cfg = config) {
  return {
    mode: "fix" as const,
    cfg,
    env: state.env,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  };
}

describe("native profile recovery", () => {
  it("reports the retired native profile in Doctor and startup without importing credentials", async () => {
    const state = await createOpenClawTestState({ label: "codex-native-profile-recovery" });
    try {
      const nativeHome = path.join(state.home, ".codex");
      await fs.mkdir(nativeHome, { recursive: true });
      const nativeAuth = JSON.stringify({
        tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" },
      });
      await fs.writeFile(path.join(nativeHome, "auth.json"), nativeAuth);
      const check = recoveryCheck();
      const findings = await check.detect(doctorContext(state));
      expect(findings).toEqual([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("2026.9.5"),
          fixHint: IMPORT_COMMAND,
        }),
      ]);
      expect(findings[0]?.message).toContain("native Codex login");
      expect(findings[0]?.message).not.toMatch(/HTTP 401|re-authenticate/);
      const captured = createCapturedPluginRegistration({ config });
      const services: OpenClawPluginService[] = [];
      captured.api.registerService = (service) => services.push(service);
      plugin.register(captured.api);
      const recovery = services.find((service) => service.id === CHECK_ID);
      assert(recovery, "Gateway startup must register the same recovery check");
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      await recovery.start({ config, stateDir: state.stateDir, logger });
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(findings[0]?.message);
      expect(await fs.readFile(path.join(nativeHome, "auth.json"), "utf8")).toBe(nativeAuth);
      expect(loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles).toEqual({});

      await state.writeAuthProfiles(managedStore);
      await expect(check.detect(doctorContext(state))).resolves.toEqual([]);
      logger.warn.mockClear();
      await recovery.start({ config, stateDir: state.stateDir, logger });
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await state.cleanup();
    }
  });

  it("honors shared state ownership and agent-local profiles without warning on unpinned native login", async () => {
    const state = await createOpenClawTestState({ label: "codex-persisted-profile-recovery" });
    try {
      const check = recoveryCheck();
      await expect(check.detect(doctorContext(state, {}))).resolves.toEqual([]);
      await state.writeAuthProfiles(managedStore, "worker");
      const localFindings = await check.detect(doctorContext(state));
      expect(localFindings).toHaveLength(1);
      expect(localFindings[0]?.message).toContain("Affected agents: main.");

      saveAuthProfileStore(managedStore);
      await expect(check.detect(doctorContext(state))).resolves.toEqual([]);
    } finally {
      await state.cleanup();
    }
  });

  it("reports an unreadable store separately from the retired native overlay", async () => {
    const state = await createOpenClawTestState({ label: "codex-unreadable-profile-recovery" });
    try {
      await fs.mkdir(state.agentDir("worker"), { recursive: true });
      await fs.writeFile(
        path.join(state.agentDir("worker"), "openclaw-agent.sqlite"),
        "not sqlite",
      );
      const findings = await recoveryCheck().detect(doctorContext(state));
      expect(findings).toEqual([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("unreadable"),
          fixHint: "openclaw doctor --fix",
        }),
        expect.objectContaining({ message: expect.stringContaining("Affected agents: main.") }),
      ]);
      expect(findings[0]?.message).not.toMatch(/2026\.9\.5|HTTP 401|sign in/);
    } finally {
      await state.cleanup();
    }
  });
});
