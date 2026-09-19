// Qa Lab tests cover scenario runtime api plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaTransportAdapter } from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { createQaScenarioRuntimeApi } from "./scenario-runtime-api.js";

type CreateQaScenarioRuntimeApiParams = Parameters<typeof createQaScenarioRuntimeApi>[0];
type QaScenarioRuntimeConstants = CreateQaScenarioRuntimeApiParams["constants"];

const constants: QaScenarioRuntimeConstants = {
  imageUnderstandingPngBase64: "png-small",
  imageUnderstandingLargePngBase64: "png-large",
  imageUnderstandingValidPngBase64: "png-valid",
};

describe("createQaScenarioRuntimeApi", () => {
  it("builds a markdown-flow runtime surface from the transport adapter", async () => {
    const state = createQaBusState();
    const resetSpy = vi.spyOn(state, "reset");
    const inboundSpy = vi.spyOn(state, "addInboundMessage");
    const outboundSpy = vi.spyOn(state, "addOutboundMessage");
    const readSpy = vi.spyOn(state, "readMessage");
    const waitForCondition: QaTransportAdapter["waitForCondition"] = async <T>(
      check: () => T | Promise<T | null | undefined> | null | undefined,
    ): Promise<T> => {
      const value = await check();
      if (value === null || value === undefined) {
        throw new Error("waitForCondition test check did not return a value");
      }
      return value;
    };
    const sleep = vi.fn(async () => undefined);
    const env = {
      lab: { baseUrl: "http://127.0.0.1:1234" },
      transport: {
        state,
        reset: async () => {
          state.reset();
        },
        sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) =>
          state.addInboundMessage(input),
        sendNativeCommand: async (
          input: Omit<Parameters<typeof state.addInboundMessage>[0], "nativeCommand" | "text"> & {
            command: string;
          },
        ) => {
          const { command, ...message } = input;
          state.addInboundMessage({
            ...message,
            text: `/${command}`,
            nativeCommand: { name: command },
          });
        },
        waitForNoOutbound: vi.fn(async () => undefined),
        waitForOutbound: vi.fn(async () => {
          throw new Error("not used");
        }),
        waitForOutboundSequence: vi.fn(async () => {
          throw new Error("not used");
        }),
        waitForCondition,
      },
    };
    const scenario = {
      id: "generic-flow",
      title: "Generic Flow",
      surface: "test",
      objective: "test",
      successCriteria: ["works"],
      sourcePath: "qa/scenarios/generic-flow.yaml",
      execution: {
        kind: "flow" as const,
        config: { expected: "value" },
        flow: {
          steps: [{ name: "noop", actions: [{ assert: "true" }] }],
        },
      },
    };
    const deps = {
      sleep,
      waitForTransportReady: vi.fn(),
      waitForAgentHistoryReply: vi.fn(),
      browserRequest: vi.fn(),
      normalizeModelRef: vi.fn(),
    };

    const api = createQaScenarioRuntimeApi({
      env,
      scenario,
      deps,
      constants,
    });

    expect(api.lab).toBe(env.lab);
    expect(api.state).toBe(state);
    expect(api.config).toEqual({ expected: "value" });
    expect(api.waitForCondition).toBe(waitForCondition);
    expect(api.waitForChannelReady).toBe(api.waitForTransportReady);
    expect(api.waitForQaChannelReady).toBe(api.waitForTransportReady);
    for (const name of Object.keys(deps) as Array<keyof typeof deps>) {
      expect(api[name]).toBe(deps[name]);
    }
    expect(api.getTransportSnapshot()).toEqual(state.getSnapshot());
    expect(api.imageUnderstandingPngBase64).toBe("png-small");

    const inbound = await api.injectInboundMessage({
      accountId: "qa-channel",
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "qa-operator",
      text: "hello",
    });
    const outbound = api.injectOutboundMessage({
      accountId: "qa-channel",
      to: "dm:qa-operator",
      text: "hi",
    });
    expect(inbound.id.trim()).not.toBe("");
    expect(outbound.id.trim()).not.toBe("");
    api.readTransportMessage({ accountId: "qa-channel", messageId: outbound.id });
    await api.reset();
    await api.resetBus();
    await api.resetTransport();

    expect(inboundSpy).toHaveBeenCalledTimes(1);
    expect(outboundSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("routes scenario injection through a factory-created transport", async () => {
    const state = createQaBusState();
    const providerState = createQaBusState();
    const sendInbound = vi.fn(async (input: Parameters<QaTransportAdapter["sendInbound"]>[0]) =>
      providerState.addInboundMessage(input),
    );
    const created = await createQaTransportAdapter(
      {
        channelId: "discord",
        driver: "crabline",
        outputDir: ".artifacts/qa-e2e/scenario-runtime-api",
        state,
      },
      [
        {
          id: "crabline-test",
          matches: () => true,
          async create() {
            return {
              id: "discord",
              label: "Crabline Discord",
              accountId: "sut",
              requiredPluginIds: [],
              supportedActions: [],
              sendInbound,
              createGatewayConfig: () => ({}),
              async waitReady() {},
              buildAgentDelivery: ({ target }: { target: string }) => ({
                channel: "discord",
                to: target,
                replyChannel: "discord",
                replyTo: target,
              }),
              async handleAction() {},
              createReportNotes: () => [],
            };
          },
        },
      ],
    );
    const api = createQaScenarioRuntimeApi({
      env: { lab: { baseUrl: "http://127.0.0.1:1234" }, transport: created.adapter },
      scenario: {
        id: "factory-inbound",
        title: "Factory inbound",
        surface: "channel",
        objective: "test provider delivery",
        successCriteria: ["provider receives inbound"],
        sourcePath: "qa/scenarios/factory-inbound.yaml",
        execution: { kind: "flow", flow: { steps: [] } },
      },
      deps: {
        sleep: vi.fn(async () => undefined),
        waitForTransportReady: vi.fn(),
      },
      constants,
    });

    const inbound = await api.injectInboundMessage({
      accountId: "sut",
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "qa-operator",
      text: "provider ingress",
    });

    expect(sendInbound).toHaveBeenCalledOnce();
    expect(providerState.readMessage({ accountId: "sut", messageId: inbound.id })).toMatchObject({
      text: "provider ingress",
    });
    expect(state.getSnapshot().messages).toEqual([]);
    await created.cleanupWithoutGateway();
  });
});
