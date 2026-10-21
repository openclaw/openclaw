import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewaySetupHarness } from "./gateway-child-setup.test-support.js";

const setup = createQaGatewaySetupHarness();
afterEach(() => setup.cleanup());

describe("QA child service identity", () => {
  it("keeps cron suppression under the child's runtime controls", async () => {
    expect(
      (await setup.prepare({}, { OPENCLAW_SKIP_CRON: "1" })).env.OPENCLAW_SKIP_CRON,
    ).toBeUndefined();
    expect(
      (
        await setup.prepare(
          {
            runtimeEnvPatch: { OPENCLAW_SKIP_CRON: "1" },
          },
          { OPENCLAW_SKIP_CRON: "1" },
        )
      ).env.OPENCLAW_SKIP_CRON,
    ).toBe("1");
  });

  it.each(["parent", "runtime patch"])(
    "keeps %s supervision out of QA-owned children",
    async (source) => {
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
      const child = await setup.prepare(
        {
          runtimeEnvPatch:
            source === "runtime patch"
              ? { ...supervisorEnv, OPENCLAW_PROFILE: "operator" }
              : undefined,
        },
        source === "parent" ? { ...supervisorEnv, OPENCLAW_PROFILE: "operator" } : {},
      );
      const { env } = child;

      for (const key of Object.keys(supervisorEnv)) {
        expect(env[key], key).toBeUndefined();
      }
      expect(env.OPENCLAW_NO_RESPAWN).toBe("1");
      expect(env.OPENCLAW_GATEWAY_HOST_LIFELINE).toBe("stdin");
      expect(env.OPENCLAW_PROFILE).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
      expect(env.OPENCLAW_PROFILE).not.toBe("operator");
      expect(env.OPENCLAW_PROFILE).not.toBe("default");
      expect(env.OPENCLAW_PROFILE).toBe((await child.prepareAttempt()).env.OPENCLAW_PROFILE);
      expect(env.OPENCLAW_PROFILE).not.toBe((await setup.prepare()).env.OPENCLAW_PROFILE);
      expect(env.OPENCLAW_STATE_DIR).toBe(child.stateDir);
      expect(env.OPENCLAW_CONFIG_PATH).toBe(child.configPath);
    },
  );
});
