import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, onTestFinished } from "vitest";
import { driver, execution } from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES as fixtures,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";

const recordingStates: Record<string, Record<string, unknown>> = {
  start_recording: fixtures.recordingActive,
  get_recording_state: fixtures.recordingActive,
  stop_recording: fixtures.recordingStopped,
  replay_trajectory: fixtures.replay,
};

const recordingHandle = (json: string): string =>
  (JSON.parse(json) as { details: { resourceHandle: string } }).details.resourceHandle;

async function createRecording(
  beforeReply: (name: string, root: string) => void | Promise<void> = () => {},
) {
  const active = Object.assign(driver(), { root: "" });
  active.callTool.mockImplementation(async (name, args) => {
    active.root = name === "start_recording" ? String(args.output_dir) : active.root;
    await beforeReply(name, active.root);
    return cuaToolResult(recordingStates[name] ?? {}, {
      text: `${active.root}/recording.mp4 native-session`,
    });
  });
  const computer = await execution(active.session);
  return Object.assign(active, { computer, act: computer.send });
}

it("maps each recording tool while projecting only opaque resource handles", async () => {
  const active = await createRecording();

  const json = await active.act("start_recording", { recordVideo: false });
  const turn = path.join(active.root, "turn-00001");
  await fs.mkdir(turn);
  await fs.writeFile(path.join(turn, "action.json"), '{"tool":"click","arguments":{}}');
  const resourceHandle = recordingHandle(json);
  expect([active.root, "native-session"].filter((secret) => json.includes(secret))).toEqual([]);
  expect(resourceHandle).toMatch(/^openclaw:computer-resource:v1:/u);

  for (const [action, params, hidden] of [
    ["get_recording_state", {}, "/native/"],
    ["stop_recording", {}, "recording.mp4"],
    ["replay_trajectory", { resourceHandle, delayMs: 25, stopOnError: true }, "/native/"],
  ] as const) {
    const response = await active.act(action, params);
    expect(response).not.toContain(hidden);
    expect(response).toContain(resourceHandle);
  }
  expect(active.callTool.mock.calls).toEqual([
    ["start_recording", { output_dir: active.root, record_video: false }, undefined],
    ["get_recording_state", {}, undefined],
    ["stop_recording", {}, undefined],
    ["replay_trajectory", { dir: active.root, delay_ms: 25, stop_on_error: true }, undefined],
  ]);

  await active.computer.close("cancel");
  await expect(fs.access(active.root)).rejects.toThrow();
});

it("rejects malformed, absolute, traversal, and symlink-escaped replay resources", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cua-resource-outside-"));
  onTestFinished(() => fs.rm(outside, { recursive: true, force: true }));
  const active = await createRecording();

  for (const resourceHandle of [
    "../outside",
    outside,
    "openclaw:computer-resource:v1:unknown",
    "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000",
  ]) {
    await expect(active.act("replay_trajectory", { resourceHandle })).rejects.toThrow("COMPUTER_");
  }

  const resourceHandle = recordingHandle(await active.act("start_recording"));
  await active.act("stop_recording");
  for (const escapedPath of [path.join(active.root, "escaped-child"), active.root]) {
    await fs.rm(escapedPath, { recursive: true, force: true });
    await fs.symlink(outside, escapedPath, "dir");
    const callsBeforeReplay = active.callTool.mock.calls.length;
    await expect(active.act("replay_trajectory", { resourceHandle })).rejects.toThrow(
      "COMPUTER_INVALID_RESOURCE",
    );
    expect(active.callTool).toHaveBeenCalledTimes(callsBeforeReplay);
    await fs.rm(escapedPath);
  }
  await active.computer.close("cancel");
  expect((await fs.stat(outside)).isDirectory()).toBe(true);
});

it("finalizes an in-flight recording once on every execution close", async () => {
  const startEntered = createDeferred<void>();
  const startGate = createDeferred<void>();
  const active = await createRecording(async (name) => {
    if (name === "start_recording") {
      startEntered.resolve();
      await startGate.promise;
    }
  });
  onTestFinished(async () => {
    startGate.resolve();
    await active.computer.close("cancel");
  });

  const start = active.act("start_recording");
  // Close only after the driver is in flight, regardless of resource-creation latency.
  await Promise.race([startEntered.promise, start]);
  const close = active.computer.close("cancel");
  startGate.resolve();
  await Promise.all([start, close]);
  await active.computer.close("cancel");

  const calls = active.callTool.mock.calls.map(([name]) => name);
  expect(calls).toEqual(["start_recording", "stop_recording"]);
  expect(active.dispose).toHaveBeenCalledOnce();
  await expect(fs.access(active.root)).rejects.toThrow();
});
