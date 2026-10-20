import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, onTestFinished } from "vitest";
import { driver, execution } from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";

type Computer = Awaited<ReturnType<typeof execution>>;

function act(computer: Computer, action: string, params: Record<string, unknown> = {}) {
  return computer.act(JSON.stringify({ action, ...params }));
}

async function startRecording(computer: Computer, params: Record<string, unknown> = {}) {
  const json = await act(computer, "start_recording", params);
  const { details } = JSON.parse(json) as { details: { resourceHandle: string } };
  return { json, resourceHandle: details.resourceHandle };
}

describe("cua-computer recording actions", () => {
  it("maps each recording tool while projecting only opaque resource handles", async () => {
    const active = driver();
    let nativeRecordingRoot = "";
    active.callTool.mockImplementation(async (name, args) => {
      if (name === "start_recording") {
        nativeRecordingRoot = String(args.output_dir);
        await fs.mkdir(path.join(nativeRecordingRoot, "turn-00001"));
        await fs.writeFile(
          path.join(nativeRecordingRoot, "turn-00001", "action.json"),
          JSON.stringify({ tool: "click", arguments: {} }),
        );
      }
      const responses: Record<string, ReturnType<typeof cuaToolResult>> = {
        start_recording: cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingActive, {
          text: `recording at ${nativeRecordingRoot}`,
        }),
        get_recording_state: cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingActive),
        stop_recording: cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingStopped, {
          text: `${nativeRecordingRoot}/recording.mp4`,
        }),
        replay_trajectory: cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.replay),
      };
      return responses[name] ?? cuaToolResult({});
    });
    const computer = await execution(active.session);

    const { json, resourceHandle } = await startRecording(computer, { recordVideo: false });
    expect(json).not.toContain(nativeRecordingRoot);
    expect(json).not.toContain("native-session");
    expect(resourceHandle).toMatch(/^openclaw:computer-resource:v1:/u);

    const stateJson = await act(computer, "get_recording_state");
    expect(stateJson).not.toContain("/native/");
    expect(stateJson).toContain(resourceHandle);

    const stoppedJson = await act(computer, "stop_recording");
    expect(stoppedJson).not.toContain("recording.mp4");
    expect(stoppedJson).toContain(resourceHandle);

    const replayJson = await act(computer, "replay_trajectory", {
      resourceHandle,
      delayMs: 25,
      stopOnError: true,
    });
    expect(replayJson).not.toContain("/native/");
    expect(replayJson).toContain(resourceHandle);
    expect(active.callTool.mock.calls).toEqual([
      ["start_recording", { output_dir: nativeRecordingRoot, record_video: false }, undefined],
      ["get_recording_state", {}, undefined],
      ["stop_recording", {}, undefined],
      [
        "replay_trajectory",
        { dir: nativeRecordingRoot, delay_ms: 25, stop_on_error: true },
        undefined,
      ],
    ]);

    await computer.close("cancel");
    await expect(fs.access(nativeRecordingRoot)).rejects.toThrow();
  });

  it("rejects malformed, absolute, traversal, and symlink-escaped replay resources", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cua-resource-outside-"));
    onTestFinished(() => fs.rm(outside, { recursive: true, force: true }));
    const active = driver();
    let nativeRecordingRoot = "";
    active.callTool.mockImplementation(async (name, args) => {
      if (name === "start_recording") {
        nativeRecordingRoot = String(args.output_dir);
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingActive);
      }
      if (name === "stop_recording") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingStopped);
      }
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.replay);
    });
    const computer = await execution(active.session);

    for (const resourceHandle of [
      "../outside",
      outside,
      "openclaw:computer-resource:v1:unknown",
      "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000",
    ]) {
      await expect(act(computer, "replay_trajectory", { resourceHandle })).rejects.toThrow(
        "COMPUTER_",
      );
    }

    const { resourceHandle } = await startRecording(computer);
    await act(computer, "stop_recording");
    const escapedChild = path.join(nativeRecordingRoot, "escaped-child");
    await fs.symlink(outside, escapedChild, "dir");
    const callsBeforeChildEscape = active.callTool.mock.calls.length;
    await expect(act(computer, "replay_trajectory", { resourceHandle })).rejects.toThrow(
      "COMPUTER_INVALID_RESOURCE",
    );
    expect(active.callTool).toHaveBeenCalledTimes(callsBeforeChildEscape);
    await fs.rm(escapedChild);

    await fs.rm(nativeRecordingRoot, { recursive: true });
    await fs.symlink(outside, nativeRecordingRoot, "dir");
    const callsBeforeReplay = active.callTool.mock.calls.length;
    await expect(act(computer, "replay_trajectory", { resourceHandle })).rejects.toThrow(
      "COMPUTER_INVALID_RESOURCE",
    );
    expect(active.callTool).toHaveBeenCalledTimes(callsBeforeReplay);

    await fs.rm(nativeRecordingRoot);
    await computer.close("cancel");
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
  });

  it("finalizes an in-flight recording once on every execution close", async () => {
    const active = driver();
    let nativeRecordingRoot = "";
    const startEntered = createDeferred<void>();
    const startGate = createDeferred<void>();
    active.callTool.mockImplementation(async (name, args) => {
      if (name === "start_recording") {
        nativeRecordingRoot = String(args.output_dir);
        startEntered.resolve();
        await startGate.promise;
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingActive);
      }
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.recordingStopped);
    });
    const computer = await execution(active.session);
    onTestFinished(async () => {
      startGate.resolve();
      await computer.close("cancel");
    });

    const start = act(computer, "start_recording");
    // Close only after the driver is in flight, regardless of resource-creation latency.
    await Promise.race([startEntered.promise, start]);
    const close = computer.close("cancel");
    startGate.resolve();
    await Promise.all([start, close]);
    await computer.close("cancel");

    expect(active.callTool.mock.calls.map(([name]) => name)).toEqual([
      "start_recording",
      "stop_recording",
    ]);
    expect(active.dispose).toHaveBeenCalledOnce();
    await expect(fs.access(nativeRecordingRoot)).rejects.toThrow();
  });
});
