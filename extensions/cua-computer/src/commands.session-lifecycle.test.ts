import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createCuaComputerProvider } from "./commands.js";
import { driver, result } from "./commands.test-helpers.js";

describe("execution authority preflight", () => {
  it("revokes stale input refs on renewal and accepts a fresh screenshot", async () => {
    const { session, click, getDesktopState, setGeneration } = driver();
    const desktop = await getDesktopState();
    desktop.images = [
      {
        mimeType: "image/png",
        dataBase64: createSolidPngBuffer(100, 50, { r: 70, g: 125, b: 180 }).toString("base64"),
      },
    ];
    getDesktopState.mockResolvedValue(desktop);
    const computer = await createCuaComputerProvider({
      platform: "linux",
      driver: session,
    }).openExecution({ executionId: "123e4567-e89b-42d3-a456-426614174000" });
    const before = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}'));
    session.prepareExecution = vi.fn(async () => setGeneration("renewed-session"));
    const action = {
      action: "left_click",
      displayFrameId: before.displayFrameId,
      refWidth: 100,
      x: 10,
      y: 20,
    };
    await expect(computer.act(JSON.stringify(action))).rejects.toThrow("COMPUTER_STALE_FRAME");
    expect(click).not.toHaveBeenCalled();
    session.prepareExecution = vi.fn(async () => {});
    const fresh = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}'));
    expect(fresh.displayFrameId).not.toBe(before.displayFrameId);
    await computer.act(JSON.stringify({ ...action, displayFrameId: fresh.displayFrameId }));
    expect(click).toHaveBeenCalledTimes(1);
    await computer.close("completion");
  });

  it("does not dispatch actions when preparation refuses authority", async () => {
    const { session, getDesktopState, click } = driver();
    session.prepareExecution = vi.fn(async () => {
      throw new Error("Desktop scope denied");
    });
    const computer = await createCuaComputerProvider({
      platform: "linux",
      driver: session,
    }).openExecution({ executionId: "123e4567-e89b-42d3-a456-426614174000" });
    await expect(computer.snapshot('{"format":"png"}')).rejects.toThrow("Desktop scope denied");
    expect(getDesktopState).not.toHaveBeenCalled();
    await expect(
      computer.act(
        JSON.stringify({
          action: "left_click",
          displayFrameId: "old",
          refWidth: 100,
          x: 1,
          y: 1,
        }),
      ),
    ).rejects.toThrow("Desktop scope denied");
    expect(click).not.toHaveBeenCalled();
    await computer.close("completion");
  });
  it("retires an old recording without replay and allows an explicit fresh start", async () => {
    const { session, callTool, setGeneration } = driver();
    let enabled = false;
    callTool.mockImplementation(async (name, args) => {
      if (name === "start_recording") {
        enabled = true;
      }
      if (name === "stop_recording") {
        enabled = false;
      }
      return result({
        recording: enabled,
        enabled,
        output_dir: args.output_dir ?? null,
        next_turn: 0,
        last_error: null,
        video_active: false,
        last_video_path: null,
        owner: null,
      });
    });
    const computer = await createCuaComputerProvider({
      platform: "linux",
      driver: session,
    }).openExecution({ executionId: "123e4567-e89b-42d3-a456-426614174000" });
    const first = JSON.parse(await computer.act('{"action":"start_recording"}'));
    expect(first.details.recording).toBe(true);
    expect(first.details.resourceHandle).toBeDefined();
    let renewed = false;
    session.prepareExecution = vi.fn(async () => {
      if (!renewed) {
        setGeneration("renewed-recording-session");
        enabled = false;
        renewed = true;
      }
    });
    const after = JSON.parse(await computer.act('{"action":"get_recording_state"}'));
    expect(after.details).toEqual({ recording: false });
    expect(callTool.mock.calls.filter(([name]) => name === "start_recording")).toHaveLength(1);
    expect(callTool.mock.calls.filter(([name]) => name === "stop_recording")).toHaveLength(0);
    const fresh = JSON.parse(await computer.act('{"action":"start_recording"}'));
    expect(fresh.details.recording).toBe(true);
    expect(fresh.details.resourceHandle).not.toBe(first.details.resourceHandle);
    await computer.act('{"action":"stop_recording"}');
    await computer.close("completion");
  });
});
