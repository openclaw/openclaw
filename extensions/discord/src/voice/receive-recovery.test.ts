// Discord tests cover receive recovery plugin behavior.
import { DAVESession, NetworkingStatusCode, VoiceConnectionStatus } from "@discordjs/voice";
import { VoiceOpcodes } from "discord-api-types/voice/v8";
import { OpusError } from "libopus-wasm";
import { describe, expect, it, vi } from "vitest";
import { analyzeVoiceReceiveError, recoverDaveZeroTransition } from "./receive-recovery.js";

const OPUS_INVALID_PACKET_CODE = -4;

describe("voice receive recovery", () => {
  it("treats corrupt Opus packets as non-recoverable decode noise", () => {
    expect(
      analyzeVoiceReceiveError(new OpusError(OPUS_INVALID_PACKET_CODE, "not inspected", "decode")),
    ).toEqual({
      message: "not inspected",
      isAbortLike: false,
      isDecodeCorruption: true,
      shouldAttemptPassthrough: false,
      countsAsDecryptFailure: false,
    });
  });

  it("treats structurally equivalent Opus errors as decode corruption", () => {
    const analysis = analyzeVoiceReceiveError({
      name: "OpusError",
      message: "libopus decode failed (-4): corrupted stream",
      code: OPUS_INVALID_PACKET_CODE,
      codeName: "InvalidPacket",
      operation: "decode",
    });

    expect(analysis).toMatchObject({
      isAbortLike: false,
      isDecodeCorruption: true,
      shouldAttemptPassthrough: false,
      countsAsDecryptFailure: false,
    });
  });

  it("does not classify corrupt Opus packet text without the Opus error contract", () => {
    expect(
      analyzeVoiceReceiveError(new Error("libopus decode failed (-4): corrupted stream")),
    ).toEqual({
      message: "libopus decode failed (-4): corrupted stream",
      isAbortLike: false,
      isDecodeCorruption: false,
      shouldAttemptPassthrough: false,
      countsAsDecryptFailure: false,
    });
  });

  it("treats premature stream close as an expected receive end", () => {
    expect(analyzeVoiceReceiveError(new Error("Premature close"))).toEqual({
      message: "Premature close",
      isAbortLike: true,
      isDecodeCorruption: false,
      shouldAttemptPassthrough: false,
      countsAsDecryptFailure: false,
    });
  });

  it("recovers transition zero through the real DAVE invalidation and key-package events", () => {
    const dave = new DAVESession(1, "bot", "c1", { decryptionFailureTolerance: 0 });
    const keyPackage = Buffer.from("new-key-package");
    const nativeSession = {
      decrypt: vi.fn(() => {
        throw new Error("UnencryptedWhenPassthroughDisabled");
      }),
      getSerializedKeyPackage: vi.fn(() => keyPackage),
      ready: true,
      reinit: vi.fn(),
      setPassthroughMode: vi.fn(),
    };
    dave.session = nativeSession as unknown as NonNullable<typeof dave.session>;
    dave.lastTransitionId = 0;
    const gateway = {
      sendBinaryMessage: vi.fn(),
      sendPacket: vi.fn(),
    };
    dave.on("invalidateTransition", (transitionId) => {
      gateway.sendPacket({
        op: VoiceOpcodes.DaveMlsInvalidCommitWelcome,
        d: { transition_id: transitionId },
      });
    });
    dave.on("keyPackage", (nextKeyPackage) => {
      gateway.sendBinaryMessage(VoiceOpcodes.DaveMlsKeyPackage, nextKeyPackage);
    });
    const onWarn = vi.fn();

    expect(() => dave.decrypt(Buffer.from("encrypted-audio"), "speaker")).toThrow(
      "UnencryptedWhenPassthroughDisabled",
    );

    expect(
      recoverDaveZeroTransition({
        target: {
          guildId: "g1",
          channelId: "c1",
          connection: {
            state: {
              status: VoiceConnectionStatus.Ready,
              networking: {
                state: {
                  code: NetworkingStatusCode.Ready,
                  dave,
                },
              },
            },
          },
        },
        sdk: { VoiceConnectionStatus, NetworkingStatusCode },
        onWarn,
      }),
    ).toBe("recovered");

    expect(nativeSession.reinit).toHaveBeenCalledWith(1, "bot", "c1");
    expect(gateway.sendPacket).toHaveBeenCalledWith({
      op: VoiceOpcodes.DaveMlsInvalidCommitWelcome,
      d: { transition_id: 0 },
    });
    expect(gateway.sendBinaryMessage).toHaveBeenCalledWith(
      VoiceOpcodes.DaveMlsKeyPackage,
      keyPackage,
    );
    expect(gateway.sendPacket.mock.invocationCallOrder[0]).toBeLessThan(
      gateway.sendBinaryMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(dave.reinitializing).toBe(true);
    expect(dave.decrypt(Buffer.from("encrypted-audio"), "speaker")).toBeNull();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("keeps bounded recovery when a real DAVE debug listener fails before invalidation", () => {
    const dave = new DAVESession(1, "bot", "c1", { decryptionFailureTolerance: 0 });
    dave.lastTransitionId = 0;
    dave.on("debug", () => {
      throw new Error("debug subscriber unavailable");
    });
    const onWarn = vi.fn();

    expect(
      recoverDaveZeroTransition({
        target: {
          guildId: "g1",
          channelId: "c1",
          connection: {
            state: {
              status: VoiceConnectionStatus.Ready,
              networking: {
                state: { code: NetworkingStatusCode.Ready, dave },
              },
            },
          },
        },
        sdk: { VoiceConnectionStatus, NetworkingStatusCode },
        onWarn,
      }),
    ).toBe("not-attempted");

    expect(dave.reinitializing).toBe(false);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("failed to recover DAVE transition 0"),
    );
  });

  it("does not invalidate disconnected voice connections", () => {
    const recoverFromInvalidTransition = vi.fn();

    expect(
      recoverDaveZeroTransition({
        target: {
          guildId: "g1",
          channelId: "c1",
          connection: {
            state: {
              status: VoiceConnectionStatus.Disconnected,
              networking: {
                state: {
                  code: NetworkingStatusCode.Ready,
                  dave: {
                    lastTransitionId: 0,
                    reinitializing: false,
                    recoverFromInvalidTransition,
                  },
                },
              },
            },
          },
        },
        sdk: { VoiceConnectionStatus, NetworkingStatusCode },
        onWarn: vi.fn(),
      }),
    ).toBe("not-attempted");

    expect(recoverFromInvalidTransition).not.toHaveBeenCalled();
  });
});
