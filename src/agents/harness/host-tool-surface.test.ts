import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createHostCurrentTurnDeliveryOwner } from "./host-tool-surface.js";

function createCurrentTurnDelivery(
  attempt: Parameters<typeof createHostCurrentTurnDeliveryOwner>[0]["attempt"] = {},
) {
  return createHostCurrentTurnDeliveryOwner({
    abortSignal: new AbortController().signal,
    assertActive: () => {},
    attempt: {
      agentId: "main",
      config: { tools: { codeMode: { enabled: true } } } as OpenClawConfig,
      model: { compat: { supportsTools: true } },
      modelId: "gpt-test",
      provider: "openai",
      sessionKey: "agent:main:telegram:direct:123",
      ...attempt,
    } as never,
    sessionTarget: {
      agentId: attempt.agentId ?? "main",
      expectedWriterRunId: "run-1",
      sessionId: "session-1",
      sessionKey: attempt.sessionKey ?? "agent:main:telegram:direct:123",
      storePath: "/state/sessions.json",
    },
  });
}

describe("agent harness host tool surface", () => {
  it.each(["global", "agent:main:telegram:direct:123"])(
    "plans terminal delivery for the executing agent, not policy session %s",
    (sandboxSessionKey) => {
      for (const enabled of [true, false]) {
        const owner = createCurrentTurnDelivery({
          agentId: "worker",
          sessionKey: "agent:worker:main",
          sandboxAgentId: "main",
          sandboxSessionKey,
          config: {
            agents: {
              entries: {
                main: { tools: { codeMode: { enabled: !enabled } } },
                worker: { tools: { codeMode: { enabled } } },
              },
            },
          },
        });

        expect(Boolean(owner.create({ terminalCompletion: "per-result" }).terminalReply)).toBe(
          enabled,
        );
      }
    },
  );

  it("still rejects a mismatched executing agent and session", () => {
    expect(() =>
      createCurrentTurnDelivery({
        agentId: "worker",
        sessionKey: "agent:main:main",
        sandboxAgentId: "main",
        sandboxSessionKey: "agent:main:main",
      }),
    ).toThrow('The agent-scoped session key belongs to "main", not "worker".');
  });

  it.each([{ disableTools: true }, { toolsAllow: [] }])(
    "does not mint terminal authority when execution tools are denied: %j",
    (restriction) => {
      const owner = createCurrentTurnDelivery({
        agentId: "worker",
        sessionKey: "agent:worker:main",
        sandboxAgentId: "main",
        sandboxSessionKey: "agent:main:main",
        ...restriction,
      });
      expect(owner.create({ terminalCompletion: "per-result" }).terminalReply).toBeUndefined();
    },
  );

  it("keeps delivery authority independent from terminal-result capability", () => {
    const owner = createCurrentTurnDelivery();

    const ordinaryDelivery = owner.create();
    const terminalDelivery = owner.create({ terminalCompletion: "per-result" });

    expect(ordinaryDelivery).toEqual({
      deliveryAuthority: expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        assertActive: expect.any(Function),
      }),
    });
    expect(terminalDelivery).toEqual({
      deliveryAuthority: ordinaryDelivery.deliveryAuthority,
      terminalReply: {
        authority: expect.objectContaining({
          abortSignal: expect.any(AbortSignal),
          assertActive: expect.any(Function),
        }),
        toolRef: {},
        completionOwner: owner.completionOwner,
      },
    });
  });

  it("keeps ordinary delivery without minting terminal authority when no writer exists", () => {
    const owner = createHostCurrentTurnDeliveryOwner({
      abortSignal: new AbortController().signal,
      assertActive: () => {},
      attempt: {
        agentId: "main",
        config: { tools: { codeMode: { enabled: true } } } as OpenClawConfig,
        model: { compat: { supportsTools: true } },
        modelId: "gpt-test",
        provider: "openai",
        sessionKey: "agent:main:main",
      } as never,
      sessionTarget: undefined,
    });

    expect(owner.create({ terminalCompletion: "per-result" })).toEqual({
      deliveryAuthority: owner.authority,
    });
  });
});
