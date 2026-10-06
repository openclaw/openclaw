// Qa Lab tests cover config-restart scenario ordering.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { applyQaMergePatch } from "./suite-merge-patch.js";

describe("QA config-restart scenario catalog", () => {
  it.each([undefined, "/dashboard", "/qa-restart-wakeup"])(
    "applies a changed serving path without changing other config: %s",
    async (basePath) => {
      const scenario = readQaScenarioById("config-apply-restart-wakeup");
      if (scenario.execution.kind !== "flow" || !scenario.execution.flow) {
        throw new Error("config apply restart scenario must be a flow");
      }
      const original = {
        gateway: {
          controlUi: { enabled: false, allowedOrigins: ["https://qa.example"], basePath },
        },
        channels: { "qa-channel": { defaultTo: "channel:qa-room" } },
      };
      const applied = new Error("config.apply captured");
      const applyConfig = vi.fn(
        ({
          nextConfig,
          deliveryContext,
        }: {
          nextConfig: typeof original;
          deliveryContext: { channel: string; to: string };
        }) => {
          // Serving paths are startup-owned; origins and enablement hot-apply.
          expect(nextConfig.gateway.controlUi.basePath).toEqual(expect.any(String));
          expect(nextConfig.gateway.controlUi.basePath).not.toBe(basePath);
          expect({
            ...nextConfig,
            gateway: {
              ...nextConfig.gateway,
              controlUi: { ...nextConfig.gateway.controlUi, basePath },
            },
          }).toEqual(original);
          expect(deliveryContext).toEqual({ channel: "qa-channel", to: "dm:qa-operator" });
          throw applied;
        },
      );
      await expect(
        runScenarioFlow({
          scenarioTitle: scenario.title,
          flow: scenario.execution.flow,
          api: {
            state: createQaBusState(),
            scenario,
            config: scenario.execution.config ?? {},
            env: {},
            randomUUID,
            reset: vi.fn(),
            buildAgentSessionKey: () => "agent:qa:qa-channel:channel:qa-room",
            createSession: vi.fn(),
            runAgentPrompt: vi.fn(),
            liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
            readConfigSnapshot: () => ({ config: structuredClone(original) }),
            applyConfig,
            runScenario: async (name, steps) => {
              for (const step of steps) {
                await step.run();
              }
              return { name, status: "pass", steps: [] };
            },
          },
        }),
      ).rejects.toBe(applied);
      expect(applyConfig).toHaveBeenCalledOnce();
    },
  );

  it("waits for the restart wake before using restored capabilities", () => {
    const flow = JSON.stringify(readQaScenarioById("config-restart-capability-flip"));
    const restartPatchIndex = flow.indexOf('"note":{"ref":"wakeMarker"}');
    const restartOwnedPathIndex = flow.indexOf('"gateway.controlUi.basePath"');
    const wakeWaitIndex = flow.indexOf("candidate.text.includes(wakeMarker)");
    const capabilityPollIndex = flow.indexOf('"saveAs":"afterTools"');

    expect(restartPatchIndex).toBeGreaterThanOrEqual(0);
    expect(restartOwnedPathIndex).toBeGreaterThanOrEqual(0);
    expect(restartOwnedPathIndex).toBeLessThan(wakeWaitIndex);
    expect(wakeWaitIndex).toBeGreaterThan(restartPatchIndex);
    expect(capabilityPollIndex).toBeGreaterThan(wakeWaitIndex);
    expect(flow.indexOf('"call":"runAgentPrompt"')).toBeGreaterThan(capabilityPollIndex);
  });

  it.each([
    undefined,
    { enabled: false, allowedOrigins: ["https://qa.example"] },
    { enabled: true, basePath: "/dashboard" },
    { enabled: true, basePath: "/qa-capability-flip" },
  ])("restores the original Control UI config after a failed wake: %j", async (controlUi) => {
    const scenario = readQaScenarioById("config-restart-capability-flip");
    if (scenario.execution.kind !== "flow" || !scenario.execution.flow) {
      throw new Error("config restart scenario must be a flow");
    }
    const original = {
      gateway: controlUi ? { controlUi } : {},
      tools: { deny: ["browser"] },
      agents: { defaults: { mediaModels: { image: { primary: "openai/gpt-image-1" } } } },
    };
    let current = structuredClone(original);
    const wakeError = new Error("restart wake unavailable");
    const pending = runScenarioFlow({
      scenarioTitle: scenario.title,
      flow: scenario.execution.flow,
      api: {
        state: createQaBusState(),
        scenario,
        config: scenario.execution.config ?? {},
        env: {},
        randomUUID,
        ensureImageGenerationConfigured: vi.fn(),
        readConfigSnapshot: () => ({ config: structuredClone(current) }),
        createSession: vi.fn(),
        patchConfig: ({ patch }: { patch: Record<string, unknown> }) => {
          current = applyQaMergePatch(current, patch) as typeof original;
        },
        waitForGatewayHealthy: vi.fn(),
        waitForQaChannelReady: vi.fn(),
        readEffectiveTools: () => new Set(),
        liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
        waitForOutboundMessage: () => {
          expect(current.gateway.controlUi?.basePath).toEqual(expect.any(String));
          expect(current.gateway.controlUi?.basePath).not.toBe(controlUi?.basePath);
          throw wakeError;
        },
        runScenario: async (name, steps) => {
          for (const step of steps) {
            await step.run();
          }
          return { name, status: "pass", steps: [] };
        },
      },
    });

    await expect(pending).rejects.toBe(wakeError);
    expect(current).toEqual(original);
  });
});
