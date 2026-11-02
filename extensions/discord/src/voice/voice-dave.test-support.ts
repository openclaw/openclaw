import { DAVESession } from "@discordjs/voice";
import { VoiceOpcodes, type VoiceSendPayload } from "discord-api-types/voice/v8";
import { vi } from "vitest";
import { voiceTestMocks } from "./voice-test-mocks.test-support.js";

export const installFailingDaveSession = (
  connection: ReturnType<typeof voiceTestMocks.createConnectionMock>,
  failure: "invalidation" | "native" | "key-package",
  beforeFailure?: () => void,
) => {
  const dave = new DAVESession(1, "bot", "1001", { decryptionFailureTolerance: 0 });
  const nativeSession = {
    decrypt: vi.fn(() => {
      throw new Error("UnencryptedWhenPassthroughDisabled");
    }),
    getSerializedKeyPackage: vi.fn(() => Buffer.from("new-key-package")),
    ready: true,
    reinit: vi.fn(() => {
      if (failure === "native") {
        beforeFailure?.();
        throw new Error("native DAVE reinitialization failed");
      }
    }),
    setPassthroughMode: connection.daveSetPassthroughMode,
  };
  dave.session = nativeSession as unknown as NonNullable<typeof dave.session>;
  dave.lastTransitionId = 0;
  const gateway = {
    sendPacket: vi.fn((_packet: VoiceSendPayload) => {
      if (failure === "invalidation") {
        beforeFailure?.();
        throw new Error("voice gateway invalidation failed");
      }
    }),
    sendBinaryMessage: vi.fn((_opcode: VoiceOpcodes, _keyPackage: Buffer) => {
      if (failure === "key-package") {
        beforeFailure?.();
        throw new Error("voice gateway key-package delivery failed");
      }
    }),
  };
  dave.on("invalidateTransition", (transitionId) => {
    gateway.sendPacket({
      op: VoiceOpcodes.DaveMlsInvalidCommitWelcome,
      d: { transition_id: transitionId },
    });
  });
  dave.on("keyPackage", (keyPackage) => {
    gateway.sendBinaryMessage(VoiceOpcodes.DaveMlsKeyPackage, keyPackage);
  });
  connection.state.networking.state.dave =
    dave as unknown as typeof connection.state.networking.state.dave;
  return { dave, gateway };
};

const { createConnectionMock, joinVoiceChannelMock } = voiceTestMocks;

export const makePoisonedDaveConnections = (additionalConnections = 0) => {
  const firstConnection = createConnectionMock();
  const secondConnection = createConnectionMock();
  installFailingDaveSession(firstConnection, "native");
  installFailingDaveSession(secondConnection, "key-package");
  const connections = [
    firstConnection,
    secondConnection,
    ...Array.from({ length: additionalConnections }, createConnectionMock),
  ];
  connections.forEach((connection) => joinVoiceChannelMock.mockReturnValueOnce(connection));
  return { firstConnection, secondConnection };
};
