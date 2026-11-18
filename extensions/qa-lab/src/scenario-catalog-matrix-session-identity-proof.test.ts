import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const matrixDriverId = "@driver:matrix.test";
const primaryRoomId = "!primary:matrix.test";
const secondaryRoomId = "!secondary:matrix.test";
const sharedSessionKey = `agent:qa:matrix:direct:${matrixDriverId}`;

function createMatrixSessionEntry(
  sessionId: string,
  roomId: string,
  updatedAt: number,
  nativeDirectUserId = matrixDriverId,
) {
  return {
    sessionId,
    updatedAt,
    delivery: {
      kind: "external",
      context: { channel: "matrix", accountId: "sut" },
      origin: {
        chatType: "direct",
        nativeChannelId: roomId,
        nativeDirectUserId,
      },
    },
  };
}

async function runMatrixSessionScenario(
  params: {
    sharedSessionKey?: boolean;
    returnedSenderId?: string;
    secondaryNativeSenderId?: string;
  } = {},
) {
  const scenario = readQaScenarioById("dm-per-room-session");
  const config = scenario.execution.config as {
    primaryConversationId: string;
    secondaryConversationId: string;
    primaryMarker: string;
    secondaryMarker: string;
  };
  const state = createQaBusState();
  const sessionKey = (room: string) =>
    params.sharedSessionKey ? sharedSessionKey : `agent:qa:matrix:channel:${room}`;
  const primarySessionKey = sessionKey(primaryRoomId);
  const secondarySessionKey = sessionKey(secondaryRoomId);
  const primarySessionId = "matrix-session-primary";

  const readRawQaSessionStore = async () => {
    const inboundMessages = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "inbound");
    if (inboundMessages.length === 0) {
      return {};
    }
    return {
      [primarySessionKey]: createMatrixSessionEntry(primarySessionId, primaryRoomId, 1),
      ...(inboundMessages.length < 2
        ? {}
        : {
            [secondarySessionKey]: createMatrixSessionEntry(
              "matrix-session-secondary",
              secondaryRoomId,
              2,
              params.secondaryNativeSenderId,
            ),
          }),
    };
  };

  let outboundWaitCount = 0;
  const transport = {
    id: "matrix",
    accountId: "sut",
    state,
    reset: async () => {
      state.reset();
    },
    sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) =>
      state.addInboundMessage({
        ...input,
        accountId: "sut",
        senderId: params.returnedSenderId ?? matrixDriverId,
      }),
    waitForOutbound: async (input: {
      conversation?: { id: string; kind: string };
      sinceIndex?: number;
      textIncludes?: string;
      timeoutMs?: number;
    }) => {
      outboundWaitCount += 1;
      if (outboundWaitCount === 1) {
        state.addOutboundMessage({
          accountId: "sut",
          to: `dm:${config.primaryConversationId}`,
          text: config.primaryMarker,
        });
      } else if (outboundWaitCount === 2) {
        state.addOutboundMessage({
          accountId: "sut",
          to: `dm:${config.secondaryConversationId}`,
          text: config.secondaryMarker,
        });
      }
      const match = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound")
        .slice(input.sinceIndex ?? 0)
        .find(
          (message) =>
            (!input.conversation || message.conversation.id === input.conversation.id) &&
            (!input.conversation || message.conversation.kind === input.conversation.kind) &&
            (!input.textIncludes || message.text.includes(input.textIncludes)),
        );
      if (!match) {
        throw new Error(`timed out after ${input.timeoutMs}ms waiting for Matrix outbound marker`);
      }
      return match;
    },
  };

  return await runLoadedScenarioFlow(scenario.id, {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        gateway: { tempRoot: "/qa-matrix-session-identity" },
      },
      transport,
      readRawQaSessionStore,
    },
  });
}

describe("Matrix DM scenario session identity evidence", () => {
  it("accepts distinct room-owned sessions on the live Matrix lane", async () => {
    await expect(runMatrixSessionScenario()).resolves.toMatchObject({ status: "pass" });
  });

  it("rejects a reused per-room session key even when its transcript id rotates", async () => {
    await expect(
      runMatrixSessionScenario({
        sharedSessionKey: true,
      }),
    ).rejects.toThrow(/session|room|isolat|shared/i);
  });

  it("rejects a different persisted Matrix sender", async () => {
    await expect(
      runMatrixSessionScenario({
        returnedSenderId: "driver",
        secondaryNativeSenderId: "@intruder:matrix.test",
      }),
    ).rejects.toThrow(/session|room|isolat|shared/i);
  });
});
