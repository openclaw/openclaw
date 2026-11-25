import { expect, it, vi } from "vitest";
import type {
  startOrResumeAttemptThreadWithoutSkills,
  CodexAttemptThreadInput as LifecycleInput,
} from "./thread-lifecycle.test-fixtures.js";

type ManagedFeaturePinFixtures = {
  createPaths: () => { sessionFile: string; workspaceDir: string };
  createParams: (sessionFile: string, workspaceDir: string) => LifecycleInput["params"];
  startOrResumeThread: (
    input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>,
  ) => ReturnType<typeof startOrResumeAttemptThreadWithoutSkills>;
  preflightMethods: readonly string[];
};

const LEGACY_FILE = {
  type: "legacyManagedConfigTomlFromFile",
  file: "/etc/codex/managed_config.toml",
};
const USER_FILE = { type: "user", file: "/home/test/.codex/config.toml", profile: null };

// config/read shapes captured from Codex 0.164.0 with /etc/codex/managed_config.toml.
const legacy = (features: Record<string, unknown>, originKeys: string[], name = LEGACY_FILE) => ({
  config: { features },
  origins: Object.fromEntries(originKeys.map((key) => [key, { name, version: "sha256:x" }])),
  layers: [],
});
const LEGACY_PINS = {
  // [features] multi_agent_v2 = true reports its origin on the enabled field.
  boolean: legacy({ multi_agent_v2: true }, ["features.multi_agent_v2.enabled"]),
  // [features.multi_agent_v2] enabled = true
  table: legacy({ multi_agent_v2: { enabled: true, tool_namespace: "x" } }, [
    "features.multi_agent_v2.enabled",
    "features.multi_agent_v2.tool_namespace",
  ]),
  // [features] collab = true
  alias: legacy({ collab: true }, ["features.collab"]),
};

/** Safe denies enforced by disabling a native feature must fail closed when managed config pins it on. */
export function registerManagedFeaturePinTests(fixtures: ManagedFeaturePinFixtures): void {
  const run = (denied: string, configRead: unknown, requirements: unknown) => {
    const { sessionFile, workspaceDir } = fixtures.createPaths();
    const params = fixtures.createParams(sessionFile, workspaceDir);
    params.pluginHarnessToolPolicySafeDeniedTools = [denied];
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return configRead;
      }
      if (method === "configRequirements/read") {
        return { requirements };
      }
      if (method === "thread/start") {
        throw new Error("admitted");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    return {
      request,
      result: fixtures.startOrResumeThread({
        client: { request } as never,
        params,
        userMcpServersEnabled: false,
      }),
    };
  };

  it.each([
    { denied: "image_generate", feature: "image_generation" },
    // Session-tool denies are enforced by disabling native delegation.
    { denied: "sessions_send", feature: "multi_agent" },
    { denied: "sessions_send", feature: "multi_agent_v2" },
    { denied: "sessions_send", feature: "collab" },
  ])(
    "fails closed when requirements pin $feature on for a $denied deny",
    async ({ denied, feature }) => {
      const { request, result } = run(
        denied,
        { config: {}, layers: [] },
        {
          featureRequirements: { [feature]: true },
        },
      );
      await expect(result).rejects.toThrow(`cannot override required feature ${feature}`);
      expect(request.mock.calls.map(([method]) => method)).toEqual([...fixtures.preflightMethods]);
    },
  );

  it.each(Object.entries(LEGACY_PINS))(
    "fails closed when a legacy managed layer pins delegation on (%s) for a session-tool deny",
    async (_shape, configRead) => {
      const { request, result } = run("sessions_send", configRead, {});
      await expect(result).rejects.toThrow(/cannot override managed feature multi_agent/);
      expect(request.mock.calls.map(([method]) => method)).toEqual([...fixtures.preflightMethods]);
    },
  );

  it("admits a delegation-denied turn when only a session-overridable layer enables V2", async () => {
    const { request, result } = run(
      "sessions_send",
      legacy({ multi_agent_v2: { enabled: true } }, ["features.multi_agent_v2.enabled"], USER_FILE),
      {},
    );
    await expect(result).rejects.toThrow("admitted");
    expect(request.mock.calls.map(([method]) => method)).toContain("thread/start");
  });
}
