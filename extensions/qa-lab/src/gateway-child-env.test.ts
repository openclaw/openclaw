import { describe, expect, it } from "vitest";
import { buildQaRuntimeEnv } from "./gateway-child-env.js";

function createParams(baseEnv: NodeJS.ProcessEnv) {
  return {
    baseEnv,
    configPath: "/tmp/openclaw-qa/openclaw.json",
    gatewayToken: "qa-token",
    homeDir: "/tmp/openclaw-qa/home",
    stateDir: "/tmp/openclaw-qa/state",
    tempRoot: "/tmp/openclaw-qa",
    xdgConfigHome: "/tmp/openclaw-qa/xdg-config",
    xdgDataHome: "/tmp/openclaw-qa/xdg-data",
    xdgCacheHome: "/tmp/openclaw-qa/xdg-cache",
    developmentSourceRoot: null,
  };
}

describe("QA child service identity", () => {
  it.each(["default", "parent", "runtime patch"])(
    "keeps %s supervision out of QA-owned children",
    (source) => {
      const supervisorEnv = {
        OPENCLAW_SUPERVISOR_MODE: "external",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
        LAUNCH_JOB_NAME: "ai.openclaw.gateway",
        XPC_SERVICE_NAME: "ai.openclaw.gateway",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        INVOCATION_ID: "synthetic-parent-invocation",
        SYSTEMD_EXEC_PID: "1234",
        JOURNAL_STREAM: "8:1234",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway",
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      };
      const env = buildQaRuntimeEnv({
        ...createParams(
          source === "parent" ? { ...supervisorEnv, OPENCLAW_PROFILE: "operator" } : {},
        ),
        runtimeEnvPatch:
          source === "runtime patch"
            ? { ...supervisorEnv, OPENCLAW_PROFILE: "operator" }
            : undefined,
      });

      for (const key of Object.keys(supervisorEnv)) {
        expect(env[key], key).toBeUndefined();
      }
      expect(env.OPENCLAW_NO_RESPAWN).toBe("1");
      expect(env.OPENCLAW_QA_PARENT_PID).toBe(String(process.pid));
      expect(env.OPENCLAW_PROFILE).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
      expect(env.OPENCLAW_PROFILE).not.toBe("operator");
      expect(env.OPENCLAW_PROFILE).not.toBe("default");
      expect(env.OPENCLAW_PROFILE).toBe(buildQaRuntimeEnv(createParams({})).OPENCLAW_PROFILE);
      expect(env.OPENCLAW_PROFILE).not.toBe(
        buildQaRuntimeEnv({ ...createParams({}), tempRoot: "/tmp/another-qa" }).OPENCLAW_PROFILE,
      );
      expect(env.OPENCLAW_STATE_DIR).toBe(createParams({}).stateDir);
      expect(env.OPENCLAW_CONFIG_PATH).toBe(createParams({}).configPath);
    },
  );
});
