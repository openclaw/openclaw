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
import type { CuaToolResult } from "./driver-client.js";

const recordingStates: Record<string, Record<string, unknown>> = {
  start_recording: fixtures.recordingActive,
  get_recording_state: fixtures.recordingActive,
  stop_recording: fixtures.recordingStopped,
  replay_trajectory: fixtures.replay,
};

function recordingHandle(json: string): string {
  return (JSON.parse(json) as { details: { resourceHandle: string } }).details.resourceHandle;
}

async function createRecording(
  reply: (name: string, root: string) => CuaToolResult | Promise<CuaToolResult>,
) {
  const active = Object.assign(driver(), { root: "" });
  active.callTool.mockImplementation(async (name, args) => {
    active.root = name === "start_recording" ? String(args.output_dir) : active.root;
    return reply(name, active.root);
  });
  const computer = await execution(active.session);
  return Object.assign(active, {
    computer,
    act: (action: string, params: Record<string, unknown> = {}) =>
      computer.act(JSON.stringify({ action, ...params })),
  });
}

it("maps each recording tool while projecting only opaque resource handles", async () => {
  const active = await createRecording(async (name, root) => {
    if (name === "start_recording") {
      const turn = path.join(root, "turn-00001");
      await fs.mkdir(turn);
      await fs.writeFile(path.join(turn, "action.json"), '{"tool":"click","arguments":{}}');
    }
    const text: Record<string, string> = {
      start_recording: `recording at ${root}`,
      stop_recording: `${root}/recording.mp4`,
    };
    return cuaToolResult(recordingStates[name] ?? {}, { text: text[name] ?? "ok" });
  });
  const { act, computer } = active;

  const json = await act("start_recording", { recordVideo: false });
  const resourceHandle = recordingHandle(json);
  expect([active.root, "native-session"].filter((secret) => json.includes(secret))).toEqual([]);
  expect(resourceHandle).toMatch(/^openclaw:computer-resource:v1:/u);

  for (const [action, params, hidden] of [
    ["get_recording_state", {}, "/native/"],
    ["stop_recording", {}, "recording.mp4"],
    ["replay_trajectory", { resourceHandle, delayMs: 25, stopOnError: true }, "/native/"],
  ] as const) {
    const response = await act(action, params);
    expect(response).not.toContain(hidden);
    expect(response).toContain(resourceHandle);
  }
  expect(active.callTool.mock.calls).toEqual([
    ["start_recording", { output_dir: active.root, record_video: false }, undefined],
    ["get_recording_state", {}, undefined],
    ["stop_recording", {}, undefined],
    ["replay_trajectory", { dir: active.root, delay_ms: 25, stop_on_error: true }, undefined],
  ]);

  await computer.close("cancel");
  await expect(fs.access(active.root)).rejects.toThrow();
});

it("rejects malformed, absolute, traversal, and symlink-escaped replay resources", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cua-resource-outside-"));
  onTestFinished(() => fs.rm(outside, { recursive: true, force: true }));
  const active = await createRecording((name) =>
    cuaToolResult(
      name === "start_recording" || name === "stop_recording"
        ? recordingStates[name]!
        : fixtures.replay,
    ),
  );
  const { act, computer } = active;

  for (const resourceHandle of [
    "../outside",
    outside,
    "openclaw:computer-resource:v1:unknown",
    "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000",
  ]) {
    await expect(act("replay_trajectory", { resourceHandle })).rejects.toThrow("COMPUTER_");
  }

  const resourceHandle = recordingHandle(await act("start_recording"));
  await act("stop_recording");
  for (const escapedPath of [path.join(active.root, "escaped-child"), active.root]) {
    await fs.rm(escapedPath, { recursive: true, force: true });
    await fs.symlink(outside, escapedPath, "dir");
    const callsBeforeReplay = active.callTool.mock.calls.length;
    await expect(act("replay_trajectory", { resourceHandle })).rejects.toThrow(
      "COMPUTER_INVALID_RESOURCE",
    );
    expect(active.callTool).toHaveBeenCalledTimes(callsBeforeReplay);
    await fs.rm(escapedPath);
  }
  await computer.close("cancel");
  expect((await fs.stat(outside)).isDirectory()).toBe(true);
});

it("finalizes an in-flight recording once on every execution close", async () => {
  const startEntered = createDeferred<void>();
  const startGate = createDeferred<void>();
  const active = await createRecording(async (name) => {
    if (name === "start_recording") {
      startEntered.resolve();
      await startGate.promise;
      return cuaToolResult(fixtures.recordingActive);
    }
    return cuaToolResult(fixtures.recordingStopped);
  });
  const { act, computer } = active;
  onTestFinished(async () => {
    startGate.resolve();
    await computer.close("cancel");
  });

  const start = act("start_recording");
  // Close only after the driver is in flight, regardless of resource-creation latency.
  await Promise.race([startEntered.promise, start]);
  const close = computer.close("cancel");
  startGate.resolve();
  await Promise.all([start, close]);
  await computer.close("cancel");

  const calls = active.callTool.mock.calls.map(([name]) => name);
  expect(calls).toEqual(["start_recording", "stop_recording"]);
  expect(active.dispose).toHaveBeenCalledOnce();
  await expect(fs.access(active.root)).rejects.toThrow();
});
