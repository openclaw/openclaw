import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareModelRuntimeOwner } from "./prepared-model-runtime.owner.js";
import { listConfiguredRefreshInputs as refreshInputs } from "./prepared-model-runtime.refresh-scope.js";

type Owners = Parameters<typeof refreshInputs>[2];
function configuredOwner(input: Parameters<typeof prepareModelRuntimeOwner>[0]): Owners {
  return new Map([["published", prepareModelRuntimeOwner(input, "configured", "static")]]);
}

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
      const select = (cfg: OpenClawConfig, dir = launchWorkspace, owners: Owners = new Map()) =>
        refreshInputs(cfg, { defaultWorkspaceDir: dir }, owners)[0];
      const initial = select(config());
      expect(initial?.workspaceDir).toBe(launchWorkspace);
      const owners = configuredOwner(initial!);
      const defaultsConfig = config();
      defaultsConfig.agents!.defaults!.workspace = configuredWorkspace;
      const cases = [
        [select(config(` ${configuredWorkspace} `)), configuredWorkspace, false],
        [select(config(), nextLaunchWorkspace, owners), launchWorkspace, true],
        [refreshInputs(config(configuredWorkspace), {}, owners)[0], configuredWorkspace, false],
        [refreshInputs(defaultsConfig, {}, owners)[0], configuredWorkspace, false],
      ] as const;
      for (const [input, workspaceDir, preserve] of cases) {
        expect.soft(input?.workspaceDir).toBe(workspaceDir);
        expect.soft(input?.preserveWorkspaceDirOnRefresh === true).toBe(preserve);
      }
      expect(
        select(config(undefined, state.path("new-agent-dir")), nextLaunchWorkspace, owners)
          ?.workspaceDir,
      ).toBe(nextLaunchWorkspace);
    });
  });

  it("resolves an entries fleet with bounded roster work and fresh configuration", async () => {
    await withOpenClawTestState({ label: "model-refresh-roster" }, async (state) => {
      const count = 64;
      const entries = Array.from({ length: count }, (_, index) => ({
        id: `agent-${index}`,
        agentDir: state.agentDir(`agent-${index}`),
        workspace: state.path(`workspace-${index}`),
        model: `fixture/model-${index}`,
      }));
      let reads = 0;
      const roster = new Proxy(Object.fromEntries(entries.map(({ id, ...entry }) => [id, entry])), {
        get(target, key, receiver) {
          if (typeof key === "string" && Object.hasOwn(target, key) && key !== "length") {
            reads += 1;
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { entries: roster },
      };
      const owners = configuredOwner({
        config,
        agentId: entries[0]!.id,
        agentDir: entries[0]!.agentDir,
        workspaceDir: state.path("startup-selected-workspace"),
        preserveWorkspaceDirOnRefresh: true,
      });
      const options = { allowGatewaySubagentBinding: true };
      reads = 0;
      const inputs = refreshInputs(config, options, owners);
      const resolutionReads = reads;
      expect(inputs).toMatchObject(
        entries.map(({ id, agentDir, workspace }, index) => ({
          agentId: id,
          agentDir: path.resolve(agentDir),
          workspaceDir: workspace,
          allowGatewaySubagentBinding: true,
          runtimePluginSelections: [{ provider: "fixture", modelId: `model-${index}` }],
        })),
      );
      expect(inputs[0]?.preserveWorkspaceDirOnRefresh).not.toBe(true);
      expect(resolutionReads).toBeLessThanOrEqual(count * 32);

      const changed = config.agents!.entries![entries[1]!.id]!;
      changed.workspace = state.path("replacement-workspace");
      changed.model = "fixture/replacement-model";
      const refreshed = refreshInputs(config, options, owners);
      expect(refreshed[1]).toMatchObject({
        workspaceDir: changed.workspace,
        runtimePluginSelections: [{ provider: "fixture", modelId: "replacement-model" }],
      });
      expect(refreshed[0]?.workspaceDir).toBe(entries[0]?.workspace);
    });
  });
});
