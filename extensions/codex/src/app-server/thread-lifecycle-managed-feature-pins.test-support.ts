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

/** Safe denies enforced by disabling a native feature must fail closed when managed config pins it on. */
export function registerManagedFeaturePinTests(fixtures: ManagedFeaturePinFixtures): void {
  it.each([
    { denied: "image_generate", feature: "image_generation", legacy: false },
    // Session-tool denies are enforced by disabling native delegation.
    { denied: "sessions_send", feature: "multi_agent", legacy: false },
    { denied: "sessions_send", feature: "multi_agent_v2", legacy: false },
    { denied: "sessions_send", feature: "collab", legacy: false },
    { denied: "sessions_send", feature: "multi_agent_v2", legacy: true },
  ])(
    "fails closed when managed config pins $feature on for a $denied deny (legacy: $legacy)",
    async ({ denied, feature, legacy }) => {
      const { sessionFile, workspaceDir } = fixtures.createPaths();
      const params = fixtures.createParams(sessionFile, workspaceDir);
      params.pluginHarnessToolPolicySafeDeniedTools = [denied];
      const origin = { name: { type: "legacyManagedConfigTomlFromFile" } };
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return legacy
            ? {
                config: { features: { [feature]: true } },
                origins: { [`features.${feature}`]: origin },
                layers: [],
              }
            : { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: legacy ? {} : { featureRequirements: { [feature]: true } } };
        }
        throw new Error(`unexpected method: ${method}`);
      });

      await expect(
        fixtures.startOrResumeThread({
          client: { request } as never,
          params,
          userMcpServersEnabled: false,
        }),
      ).rejects.toThrow(`cannot override ${legacy ? "managed" : "required"} feature ${feature}`);
      expect(request.mock.calls.map(([method]) => method)).toEqual([...fixtures.preflightMethods]);
    },
  );
}
