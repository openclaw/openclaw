import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareModelRuntimeOwner } from "./prepared-model-runtime.owner.js";
import { listConfiguredRefreshInputs } from "./prepared-model-runtime.refresh-scope.js";

describe("configured model runtime refresh inputs", () => {
  it("prefers explicit workspaces over launch candidates on startup and replacement", async () => {
    await withOpenClawTestState({ label: "model-workspace-precedence" }, async (state) => {
      const agentDir = state.agentDir("main");
      const configuredWorkspace = state.path("configured-workspace");
      const launchWorkspace = state.path("launch-workspace");
      const nextLaunchWorkspace = state.path("next-launch-workspace");
      const config = (workspace?: string, directory = agentDir): OpenClawConfig => ({
        plugins: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: { agentDir: directory, workspace, model: "fixture/model" } },
        },
      });
      const options = { defaultWorkspaceDir: launchWorkspace };
      const [explicit] = listConfiguredRefreshInputs(
        config(` ${configuredWorkspace} `),
        options,
        new Map(),
      );
      expect.soft(explicit?.workspaceDir).toBe(configuredWorkspace);
      expect.soft(explicit?.preserveWorkspaceDirOnRefresh).not.toBe(true);

      const [initial] = listConfiguredRefreshInputs(config(), options, new Map());
      expect(initial?.workspaceDir).toBe(launchWorkspace);
      const owners = new Map([
        ["main", prepareModelRuntimeOwner(initial!, "configured", "static")],
      ]);
      const [retained] = listConfiguredRefreshInputs(
        config(),
        { defaultWorkspaceDir: nextLaunchWorkspace },
        owners,
      );
      expect(retained?.workspaceDir).toBe(launchWorkspace);
      expect(retained?.preserveWorkspaceDirOnRefresh).toBe(true);

      const [replacement] = listConfiguredRefreshInputs(config(configuredWorkspace), {}, owners);
      expect.soft(replacement?.workspaceDir).toBe(configuredWorkspace);
      expect.soft(replacement?.preserveWorkspaceDirOnRefresh).not.toBe(true);
      const [relocated] = listConfiguredRefreshInputs(
        config(undefined, state.path("new-agent-dir")),
        { defaultWorkspaceDir: nextLaunchWorkspace },
        owners,
      );
      expect(relocated?.workspaceDir).toBe(nextLaunchWorkspace);
    });
  });

  it.each(["entries", "list"] as const)(
    "resolves a %s fleet with bounded roster work and fresh configuration",
    async (representation) => {
      await withOpenClawTestState({ label: "model-refresh-roster" }, async (state) => {
        const count = 64;
        const entries = Array.from({ length: count }, (_, index) => ({
          id: `agent-${index}`,
          agentDir: state.agentDir(`agent-${index}`),
          workspace: state.path(`workspace-${index}`),
          model: `fixture/model-${index}`,
        }));
        let reads = 0;
        const observe = <T extends object>(roster: T): T =>
          new Proxy(roster, {
            get(target, key, receiver) {
              if (typeof key === "string" && Object.hasOwn(target, key) && key !== "length") {
                reads += 1;
              }
              return Reflect.get(target, key, receiver);
            },
          });
        const config: OpenClawConfig = {
          plugins: { enabled: false },
          agents:
            representation === "list"
              ? { list: observe(entries) }
              : {
                  entries: observe(
                    Object.fromEntries(entries.map(({ id, ...entry }) => [id, entry])),
                  ),
                },
        };
        const preservedWorkspace = state.path("startup-selected-workspace");
        const owners = new Map([
          [
            "published",
            prepareModelRuntimeOwner(
              {
                config,
                agentId: entries[0]!.id,
                agentDir: entries[0]!.agentDir,
                workspaceDir: preservedWorkspace,
                preserveWorkspaceDirOnRefresh: true,
              },
              "configured",
              "static",
            ),
          ],
        ]);
        const options = { allowGatewaySubagentBinding: true };
        reads = 0;
        const inputs = listConfiguredRefreshInputs(config, options, owners);
        const resolutionReads = reads;
        expect(
          inputs.map(({ agentId, agentDir, workspaceDir }) => ({
            agentId,
            agentDir,
            workspaceDir,
          })),
        ).toEqual(
          entries.map((entry) => ({
            agentId: entry.id,
            agentDir: path.resolve(entry.agentDir),
            workspaceDir: entry.workspace,
          })),
        );
        expect(inputs.every((input) => input.allowGatewaySubagentBinding === true)).toBe(true);
        expect(inputs[0]?.preserveWorkspaceDirOnRefresh).not.toBe(true);
        expect(
          inputs.map((input) =>
            input.runtimePluginSelections?.map(({ provider, modelId }) => ({ provider, modelId })),
          ),
        ).toEqual(entries.map((_, index) => [{ provider: "fixture", modelId: `model-${index}` }]));
        expect(resolutionReads).toBeLessThanOrEqual(count * 32);

        const changed =
          representation === "list" ? entries[1]! : config.agents!.entries![entries[1]!.id]!;
        changed.workspace = state.path("replacement-workspace");
        changed.model = "fixture/replacement-model";
        const refreshed = listConfiguredRefreshInputs(config, options, owners);
        expect(refreshed[1]?.workspaceDir).toBe(changed.workspace);
        expect(refreshed[1]?.runtimePluginSelections).toEqual([
          expect.objectContaining({ provider: "fixture", modelId: "replacement-model" }),
        ]);
        expect(refreshed[0]?.workspaceDir).toBe(entries[0]?.workspace);
      });
    },
  );
});
