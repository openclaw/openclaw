import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startTalk: vi.fn(),
  run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
}));

vi.mock("../src/plugin-paths.js", () => ({
  ensureCaptureBinary: vi.fn(async () => "/usr/bin/true"),
}));
vi.mock("../src/talk-driver.js", () => ({ startFaceTimeTalkDriver: mocks.startTalk }));
vi.mock("../src/config.js", async (original) => {
  const actual = await original<typeof import("../src/config.js")>();
  return {
    ...actual,
    validateFaceTimeConfig(config: import("../src/config.js").FaceTimeConfig) {
      const result = actual.validateFaceTimeConfig(config);
      const errors = result.errors.filter((error) => error !== "facetime requires macOS");
      return { valid: errors.length === 0, errors };
    },
  };
});

import { resolveFaceTimeConfig } from "../src/config.js";
import { createFaceTimeRuntime } from "../src/runtime.js";

function talkDriver() {
  return {
    callUUID: "ignored",
    recentTalkEvents: [],
    readyForAudio: vi.fn(async () => {}),
    processOutputSuppressed: vi.fn(() => true),
    realtimeActive: vi.fn(() => true),
    videoStatus: vi.fn(() => undefined),
    activate: vi.fn(),
    suspendMedia: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

async function createRuntime() {
  return await createFaceTimeRuntime({
    config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
    fullConfig: {} as never,
    runtime: { system: { runCommandWithTimeout: mocks.run } } as never,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    pluginRoot: "/plugin",
  });
}

describe("operator-assisted FaceTime runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.run.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    mocks.startTalk.mockResolvedValue(talkDriver());
  });

  it("opens FaceTime but does not claim the call is attached", async () => {
    const runtime = await createRuntime();
    const result = await runtime.dial({ handle: "owner@example.com", mode: "video" });
    expect(mocks.run).toHaveBeenCalledWith(["/usr/bin/open", "facetime://owner%40example.com"], {
      timeoutMs: 10_000,
    });
    expect(result.state).toBe("operator-action-required");
    expect((await runtime.status()).calls).toHaveLength(0);
  });

  it("starts media only after an explicit configured-owner attachment", async () => {
    const runtime = await createRuntime();
    const attached = await runtime.attach({ handle: "owner@example.com", mode: "video" });
    expect(attached).toMatchObject({ state: "attached", admission: "operator-confirmed-owner" });
    expect(mocks.startTalk).toHaveBeenCalledOnce();
    expect((await runtime.status()).calls[0]).toMatchObject({
      carrierMode: "active",
      modelMediaMode: "active",
    });
  });

  it("rejects an attachment claiming an unconfigured owner", async () => {
    const runtime = await createRuntime();
    await expect(runtime.attach({ handle: "stranger@example.com", mode: "audio" })).rejects.toThrow(
      "not an authorized owner handle",
    );
    expect(mocks.startTalk).not.toHaveBeenCalled();
  });

  it("detaches local media and requires manual carrier hangup", async () => {
    const runtime = await createRuntime();
    const attached = await runtime.attach({ handle: "owner@example.com", mode: "audio" });
    await expect(runtime.hangup({ callUUID: attached.callUUID })).resolves.toEqual({
      callUUID: attached.callUUID,
      detached: true,
      manualHangupRequired: true,
    });
    expect((await runtime.status()).calls).toHaveLength(0);
  });
});
