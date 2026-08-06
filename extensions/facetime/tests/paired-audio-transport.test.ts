import { describe, expect, it, vi } from "vitest";
import {
  assertPairedAudioTransport,
  pairedAudioProbeCommands,
} from "../src/paired-audio-transport.js";

describe("paired FaceTime audio transport", () => {
  it("opens both the output-only feed and input-only microphone", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    await assertPairedAudioTransport(runCommandWithTimeout);

    expect(runCommandWithTimeout.mock.calls.map(([argv]) => argv)).toEqual(
      pairedAudioProbeCommands().map(({ argv }) => argv),
    );
  });

  it("rejects a missing paired device before a call is answered", async () => {
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "device not found" });

    await expect(assertPairedAudioTransport(runCommandWithTimeout)).rejects.toThrow(
      "OpenClaw-Mic audio probe failed: device not found",
    );
  });
});
