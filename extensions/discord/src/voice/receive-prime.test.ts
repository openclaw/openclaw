import { describe, expect, it, vi } from "vitest";
import { createOpusSilenceStream, primeVoiceReceive } from "./receive-prime.js";

const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

function drain(stream: ReturnType<typeof createOpusSilenceStream>): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const frames: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => frames.push(chunk));
    stream.on("end", () => resolve(frames));
    stream.on("error", reject);
  });
}

describe("createOpusSilenceStream", () => {
  it("emits exactly the requested number of opus silence frames then ends", async () => {
    const frames = await drain(createOpusSilenceStream(5));
    expect(frames).toHaveLength(5);
    for (const frame of frames) {
      expect(frame.equals(OPUS_SILENCE_FRAME)).toBe(true);
    }
  });

  it("ends immediately for a zero or negative frame count", async () => {
    expect(await drain(createOpusSilenceStream(0))).toHaveLength(0);
    expect(await drain(createOpusSilenceStream(-3))).toHaveLength(0);
  });
});

describe("primeVoiceReceive", () => {
  function makeSdk() {
    const StreamType = { Opus: "opus" };
    const createAudioResource = vi.fn((input: unknown, opts: { inputType: unknown }) => ({
      input,
      inputType: opts.inputType,
    }));
    return { StreamType, createAudioResource };
  }

  it("creates an opus resource and plays it through the player", () => {
    const sdk = makeSdk();
    const play = vi.fn();
    const logs: string[] = [];
    const ok = primeVoiceReceive({
      player: { play },
      voiceSdk: sdk,
      guildId: "g1",
      channelId: "c1",
      log: (m) => logs.push(m),
      onWarn: (m) => logs.push(`WARN ${m}`),
      frameCount: 12,
    });
    expect(ok).toBe(true);
    expect(sdk.createAudioResource).toHaveBeenCalledTimes(1);
    expect(sdk.createAudioResource.mock.calls[0]?.[1]).toEqual({ inputType: "opus" });
    expect(play).toHaveBeenCalledTimes(1);
    expect(logs.some((m) => m.includes("receive-prime: sent op-5 Speaking"))).toBe(true);
  });

  it("returns false and warns (without throwing) when play fails", () => {
    const sdk = makeSdk();
    const play = vi.fn(() => {
      throw new Error("player destroyed");
    });
    const warns: string[] = [];
    const ok = primeVoiceReceive({
      player: { play },
      voiceSdk: sdk,
      guildId: "g1",
      channelId: "c1",
      log: () => {},
      onWarn: (m) => warns.push(m),
    });
    expect(ok).toBe(false);
    expect(warns.some((m) => m.includes("receive-prime failed"))).toBe(true);
    expect(warns.some((m) => m.includes("player destroyed"))).toBe(true);
  });

  it("defaults to a 12-frame (~240ms) burst when frameCount is omitted", async () => {
    let played: ReturnType<typeof createOpusSilenceStream> | undefined;
    const sdk = {
      StreamType: { Opus: "opus" },
      createAudioResource: vi.fn((input: ReturnType<typeof createOpusSilenceStream>) => {
        played = input;
        return {};
      }),
    };
    primeVoiceReceive({
      player: { play: vi.fn() },
      voiceSdk: sdk,
      guildId: "g1",
      channelId: "c1",
      log: () => {},
      onWarn: () => {},
    });
    expect(played).toBeDefined();
    const frames = await drain(played!);
    expect(frames).toHaveLength(12);
  });
});
