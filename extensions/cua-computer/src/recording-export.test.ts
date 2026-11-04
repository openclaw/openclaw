import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  registerComputerUseProvider,
  type ComputerUseProvider,
} from "openclaw/plugin-sdk/computer-use";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createTempHomeEnv } from "openclaw/plugin-sdk/test-env";
import { expect, it, onTestFinished } from "vitest";
import { createTestProvider, driver, result } from "./commands.test-helpers.js";
import { CUA_DRIVER_CONTRACT_FIXTURES as fixtures } from "./cua-driver-contract.test-fixtures.js";

const bytes = Buffer.from([
  0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115,
  111, 50, 0, 0, 0, 12, 109, 100, 97, 116, 0, 255, 128, 254,
]);
const owner = "agent:main:recording-owner";
async function setup(
  wrap?: (provider: ComputerUseProvider) => ComputerUseProvider,
  extraVideo = false,
) {
  const native = driver();
  let output = "";
  native.callTool.mockImplementation(async (name, args) => {
    if (name === "start_recording") {
      if (typeof args.output_dir !== "string") {
        throw new Error("missing owned recording directory");
      }
      output = args.output_dir;
      await fs.mkdir(path.join(output, "turn-1"), { recursive: true });
      await fs.writeFile(path.join(output, "turn-1", "video.mp4"), bytes);
      if (extraVideo) {
        await fs.writeFile(path.join(output, "second.mp4"), bytes);
      }
    }
    return result(
      name === "start_recording"
        ? { ...fixtures.recordingActive, output_dir: output }
        : { ...fixtures.recordingStopped, output_dir: output },
    );
  });
  const provider = createTestProvider(native.session);
  const commands: OpenClawPluginNodeHostCommand[] = [];
  registerComputerUseProvider(
    { registerNodeHostCommand: (command) => commands.push(command) },
    wrap ? wrap(provider) : provider,
  );
  const act = commands.find((command) => command.command === "computer.act");
  const reader = commands.find((command) => command.command === "computer.resource.fetch");
  if (!act || !reader) {
    throw new Error("computer resource reader not registered");
  }
  const executionId = "123e4567-e89b-42d3-a456-426614174000";
  const send = (action: string) =>
    act.handle(JSON.stringify({ executionId, action }), undefined, {
      sessionKey: owner,
      sendNodeEvent: async () => {},
    });
  onTestFinished(async () => {
    await act.handle(
      JSON.stringify({ executionId, action: "__close_execution", reason: "node-host-stop" }),
      undefined,
      { sessionKey: owner, sendNodeEvent: async () => {} },
    );
  });
  await send("start_recording");
  const stopped = asNullableRecord(JSON.parse(await send("stop_recording")));
  const details = asNullableRecord(stopped?.details);
  if (typeof details?.resourceHandle !== "string") {
    throw new Error("recording handle missing");
  }
  return {
    reader,
    handle: details.resourceHandle,
    files: details.fileResourceHandles,
    output,
    native,
  };
}
const read = (
  reader: OpenClawPluginNodeHostCommand,
  resourceHandle: string,
  sessionKey = owner,
  signal?: AbortSignal,
) =>
  reader.handle(JSON.stringify({ resourceHandle, maxBytes: 4096 }), undefined, {
    sessionKey,
    signal,
    sendNodeEvent: async () => {},
  });
it("exports a real managed MP4 byte file and persists it through the media pipeline", async () => {
  const home = await createTempHomeEnv("cua-recording-export-");
  onTestFinished(() => home.restore());
  const recording = await setup();
  const payload = asNullableRecord(JSON.parse(await read(recording.reader, recording.handle)));
  expect(payload).toMatchObject({
    ok: true,
    size: bytes.length,
    mimeType: "video/mp4",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (typeof payload?.base64 !== "string") {
    throw new Error("recording bytes missing");
  }
  const decoded = Buffer.from(payload.base64, "base64");
  expect(decoded).toEqual(bytes);
  const saved = await saveMediaBuffer(
    decoded,
    "video/mp4",
    "tool-file-transfer",
    4096,
    "recording.mp4",
  );
  expect(await fs.readFile(saved.path)).toEqual(bytes);
  expect(String(payload.path)).not.toContain(recording.output);
  expect(Array.isArray(recording.files)).toBe(true);
});
it("supports the explicit file handles returned by stop_recording", async () => {
  const recording = await setup();
  if (!Array.isArray(recording.files) || typeof recording.files[0] !== "string") {
    throw new Error("file export handle missing");
  }
  const payload = asNullableRecord(JSON.parse(await read(recording.reader, recording.files[0])));
  expect(payload?.base64).toBe(bytes.toString("base64"));
});
it("rejects a foreign session, unknown resources, URLs, and node/path substitution", async () => {
  const recording = await setup();
  await expect(read(recording.reader, recording.handle, "agent:main:foreign")).rejects.toThrow(
    "owner",
  );
  for (const handle of [
    "https://invalid.example/file",
    "/host/not-a-real-credential",
    "openclaw:computer-resource:v1:foreign",
  ]) {
    await expect(read(recording.reader, handle)).rejects.toThrow();
  }
  await expect(
    recording.reader.handle(
      JSON.stringify({
        resourceHandle: recording.handle,
        maxBytes: 4096,
        nodeId: "foreign",
        path: "/host/not-a-real-credential",
      }),
      undefined,
      { sessionKey: owner, sendNodeEvent: async () => {} },
    ),
  ).rejects.toThrow("INVALID_RESOURCE");
});
it("rejects resource-file symlink substitution without reading outside the managed root", async () => {
  const recording = await setup();
  const video = path.join(recording.output, "turn-1", "video.mp4");
  const outside = path.join(
    path.dirname(path.dirname(recording.output)),
    `outside-${path.basename(recording.output)}.bin`,
  );
  await fs.writeFile(outside, "synthetic outside canary");
  onTestFinished(() => fs.unlink(outside));
  await fs.unlink(video);
  await fs.symlink(outside, video);
  await expect(read(recording.reader, recording.handle)).rejects.toThrow();
  await fs.unlink(video);
  await fs.writeFile(video, bytes);
});
it("fences queued reads with an already revoked signal", async () => {
  const recording = await setup();
  const controller = new AbortController();
  controller.abort(new Error("guest revoked"));
  await expect(read(recording.reader, recording.handle, owner, controller.signal)).rejects.toThrow(
    "revoked",
  );
});
it("does not return bytes after revocation while the awaited reader settles", async () => {
  let ready = () => {};
  let resume = () => {};
  const loaded = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const recording = await setup((provider) => ({
    ...provider,
    openExecution: async (options) => {
      const execution = await provider.openExecution(options);
      return {
        ...execution,
        readResource: async (handle, maxBytes, signal) => {
          if (!execution.readResource) {
            throw new Error("real CUA reader missing");
          }
          const data = await execution.readResource(handle, maxBytes, signal);
          ready();
          await gate;
          return data;
        },
      };
    },
  }));
  const controller = new AbortController();
  const pending = read(recording.reader, recording.handle, owner, controller.signal);
  await loaded;
  controller.abort(new Error("guest revoked after read"));
  resume();
  await expect(pending).rejects.toThrow("revoked after read");
});

it("exports every file in multi-turn recordings without silently selecting one", async () => {
  const recording = await setup(undefined, true);
  await expect(read(recording.reader, recording.handle)).rejects.toThrow("fileResourceHandle");
  if (!Array.isArray(recording.files)) {
    throw new Error("missing file handles");
  }
  expect(recording.files).toHaveLength(2);
  for (const handle of recording.files) {
    if (typeof handle !== "string") {
      throw new Error("invalid file handle");
    }
    const payload = asNullableRecord(JSON.parse(await read(recording.reader, handle)));
    expect(payload?.base64).toBe(bytes.toString("base64"));
  }
});
