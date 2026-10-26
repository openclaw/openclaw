import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { applyQaMergePatch } from "./suite-merge-patch.js";

function runConfigFlow(scenarioId: string, api: Record<string, unknown>) {
  const scenario = readQaScenarioById(scenarioId);
  if (scenario.execution.kind !== "flow" || !scenario.execution.flow) {
    throw new Error("config restart scenario must be a flow");
  }
  return runScenarioFlow({
    scenarioTitle: scenario.title,
    flow: scenario.execution.flow,
    api: {
      state: createQaBusState(),
      scenario,
      config: scenario.execution.config ?? {},
      env: {},
      randomUUID,
      createSession: vi.fn(),
      liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      runScenario: async (name, steps) => {
        for (const step of steps) {
          await step.run();
        }
        return { name, status: "pass", steps: [] };
      },
      ...api,
    },
  });
}

it("applies a changed serving path without changing other config", async () => {
  const basePath = "/qa-restart-wakeup";
  const original = {
    gateway: {
      controlUi: { enabled: false, allowedOrigins: ["https://qa.example"], basePath },
    },
    channels: { "qa-channel": { defaultTo: "channel:qa-room" } },
  };
  const applied = new Error("config.apply captured");
  const expectedDelivery = { channel: "qa-channel", to: "dm:qa-operator" };
  type ApplyInput = { nextConfig: typeof original; deliveryContext: typeof expectedDelivery };
  const applyConfig = vi.fn(({ nextConfig, deliveryContext }: ApplyInput) => {
    expect(nextConfig.gateway.controlUi.basePath).toEqual(expect.any(String));
    expect(nextConfig.gateway.controlUi.basePath).not.toBe(basePath);
    const restored = structuredClone(nextConfig);
    restored.gateway.controlUi.basePath = basePath;
    expect(restored).toEqual(original);
    expect(deliveryContext).toEqual(expectedDelivery);
    throw applied;
  });
  await expect(
    runConfigFlow("config-apply-restart-wakeup", {
      reset: vi.fn(),
      buildAgentSessionKey: () => "agent:qa:qa-channel:channel:qa-room",
      runAgentPrompt: vi.fn(),
      readConfigSnapshot: () => ({ config: structuredClone(original) }),
      applyConfig,
    }),
  ).rejects.toBe(applied);
  expect(applyConfig).toHaveBeenCalledOnce();
});

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

it("restores an absent Control UI config after a failed wake", async () => {
  const original: OpenClawConfig = {
    gateway: {},
    tools: { deny: ["browser"] },
    agents: { defaults: { mediaModels: { image: { primary: "openai/gpt-image-1" } } } },
  };
  let current = structuredClone(original);
  const wakeError = new Error("restart wake unavailable");
  const pending = runConfigFlow("config-restart-capability-flip", {
    ensureImageGenerationConfigured: vi.fn(),
    readConfigSnapshot: () => ({ config: structuredClone(current) }),
    patchConfig: ({ patch }: { patch: Record<string, unknown> }) => {
      current = applyQaMergePatch(current, patch) as typeof original;
    },
    waitForGatewayHealthy: vi.fn(),
    waitForQaChannelReady: vi.fn(),
    readEffectiveTools: () => new Set(),
    waitForOutboundMessage: () => {
      expect(current.gateway?.controlUi?.basePath).toEqual(expect.any(String));
      throw wakeError;
    },
  });

  await expect(pending).rejects.toBe(wakeError);
  expect(current).toEqual(original);
});
