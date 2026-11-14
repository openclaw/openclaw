import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computerCapabilities } from "../gateway/desktop/computer.test-support.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createAdmittedHostCapabilityTestFixture } from "./harness/host-capability.test-support.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import { withSessionPlacementComputer } from "./session-placement-computer.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createOpenClawOnlyToolConstructionPlan } from "./test-helpers/tool-construction-plan.js";
import type { ComputerToolTransport } from "./tools/computer-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope = {
  agentId: "main",
  runId: "run-computer",
  sessionId: "session-computer",
  sessionKey: "agent:main:session-computer",
};
const transport: ComputerToolTransport = {
  computerUse: computerCapabilities(
    { id: "fixture", label: "Fixture", generation: "generation-1" },
    ["screenshot"],
  ),
  resolveNode: async () => ({ nodeId: "session-desktop" }),
  invoke: async () => {
    throw new Error("Tool construction must not invoke the desktop");
  },
};

it.each<[string, OpenClawConfig["tools"], boolean, boolean?, boolean?]>([
  ["default", {}, true],
  ["prepared default", {}, true, true, true],
  ["prepared denial", { deny: ["computer"] }, false, true, true],
  ["additive sandbox tools", { sandbox: { tools: { alsoAllow: ["web_fetch"] } } }, true],
  ["explicit sandbox allow", { sandbox: { tools: { allow: ["read"] } } }, false],
  ["explicit sandbox deny", { sandbox: { tools: { deny: ["computer"] } } }, false],
  ["inactive sandbox allow", { sandbox: { tools: { allow: ["read"] } } }, true, false],
  ["global deny", { deny: ["computer"] }, false],
  ["coding profile", { profile: "coding" }, false],
])(
  "applies %s policy to the real harness host tool surface",
  async (_name, tools, allowed, sandboxed = true, prepared = false) => {
    const workspaceDir = tempDirs.make("placement-computer-");
    const config: OpenClawConfig = { plugins: { enabled: false }, tools };
    const host = await createAdmittedHostCapabilityTestFixture({
      ...scope,
      cwd: workspaceDir,
      workspaceDir,
      config,
    });
    const surface = host.hostCapabilities.createToolSurface!;
    let desktop: ComputerToolTransport | null = transport;
    const options = {
      ...scope,
      workspaceDir,
      config,
      modelHasVision: true,
      sandbox: sandboxed
        ? createAgentToolsSandboxContext({
            workspaceDir,
            tools: resolveSandboxToolPolicyForAgent(config, "main"),
          })
        : undefined,
      toolConstructionPlan: createOpenClawOnlyToolConstructionPlan(),
    };
    try {
      const ordinary = surface(options);
      if (sandboxed) {
        expect(ordinary.some((tool) => tool.name === "computer")).toBe(false);
      }
      await withSessionPlacementComputer(
        {
          ...scope,
          isActive: () => true,
          sandboxToolPolicy: resolveSandboxToolPolicyForAgent(config, "main", {
            containedToolNames: ["computer"],
          }),
          bind: (run) => {
            expect(run).toBe(host.admittedRunContext.operationalRunInstance);
            return desktop;
          },
        },
        async () => {
          const conversationCapabilityProfile = prepared
            ? resolveConversationCapabilityProfile({
                ...options,
                sandboxToolPolicy: options.sandbox?.tools,
              })
            : undefined;
          const bound = surface({ ...options, conversationCapabilityProfile });
          const computer = bound.find((tool) => tool.name === "computer");
          expect(Boolean(computer)).toBe(allowed);
          if (computer) {
            expect(computer.parameters).not.toHaveProperty("properties.node");
            expect(computer.parameters).not.toHaveProperty("properties.gatewayUrl");
            expect(computer.description).toContain("this session's desktop");
          }
          desktop = null;
          expect(
            surface({ ...options, sandbox: undefined }).some((tool) => tool.name === "computer"),
          ).toBe(false);
        },
      );
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  },
);

it("scopes placement policy to the active run and agent without binding a desktop", async () => {
  const ordinary = { allow: ["read"], deny: [] };
  const contained = { allow: ["computer"], deny: [] };
  const bind = vi.fn(() => transport);
  let active = true;
  await withSessionPlacementComputer(
    {
      runId: "placement-run",
      agentId: "main",
      isActive: () => active,
      sandboxToolPolicy: contained,
      bind,
    },
    async () => {
      const profile = (runId = "placement-run", agentId = "main") =>
        resolveConversationCapabilityProfile({ runId, agentId, sandboxToolPolicy: ordinary });
      expect(profile().policy.sandboxPolicy).toBe(contained);
      expect(profile().policy.explicitToolAllowlist).toContain("computer");
      for (const [runId, agentId] of [
        ["other-run", "main"],
        ["placement-run", "other-agent"],
      ]) {
        const projected = profile(runId, agentId);
        expect(projected.policy.sandboxPolicy).toBe(ordinary);
        expect(projected.policy.explicitToolAllowlist).not.toContain("computer");
      }
      active = false;
      expect(profile().policy.sandboxPolicy).toBe(ordinary);
      expect(profile().policy.explicitToolAllowlist).not.toContain("computer");
      expect(bind).not.toHaveBeenCalled();
    },
  );
});
