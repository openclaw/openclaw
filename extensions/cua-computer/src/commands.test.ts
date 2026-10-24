import { registerComputerUseProvider } from "openclaw/plugin-sdk/computer-use";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resizeToJpeg } from "openclaw/plugin-sdk/media-runtime";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { readImageMetadataFromHeader } from "rastermill";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createTestProvider,
  driver,
  execution as openExecution,
  invalidMacOsEndpoints,
  macOsEndpoint,
  result,
  pngImage,
  frameTarget,
  type ComputerExecution,
  type WindowObservation,
} from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES as fixtures,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";
import { ClickButton, ScrollDirection, type CuaToolResult } from "./driver-client.js";
import { createCuaMcpDriver } from "./mcp-driver-client.js";

async function execution(...args: Parameters<typeof openExecution>) {
  const computer = await openExecution(...args);
  onTestFinished(() => computer.close("completion"));
  return computer;
}

const windowPoint = { x: 20, y: 30 };
const elementToken = { element_token: "native-element-token-7" };

function actionResult(name: "confirmedBackgroundAction" | "suspectedNoopAction") {
  return cuaToolResult({}, { action: fixtures[name] as unknown as CuaToolResult["action"] });
}

function windowDriver(handle: (name: string) => CuaToolResult = () => cuaToolResult({})) {
  const native = driver();
  native.callTool.mockImplementation(async (name) => {
    if (name === "list_windows") {
      return cuaToolResult(fixtures.listWindows);
    }
    if (name === "get_window_state") {
      return cuaToolResult(fixtures.windowState, { image: true });
    }
    return handle(name);
  });
  return native;
}

const nativeWindow = { pid: 4242, window_id: 99 };
async function windowTarget(computer: ComputerExecution) {
  const windowRef = await computer.window();
  const { observation } = await computer.observe(windowRef);
  return {
    windowRef,
    observationId: observation.observationId,
    elementRef: observation.elements[0]!.elementRef,
  };
}

function clickFrame(
  computer: ComputerExecution,
  screen: Parameters<typeof frameTarget>[0],
  extra: Record<string, unknown> = {},
) {
  return computer.send("left_click", { ...frameTarget(screen), x: 10, y: 20, ...extra });
}

async function desktopExecution() {
  const native = driver();
  const desktop = await native.getDesktopState();
  native.getDesktopState.mockResolvedValue({ ...desktop, images: [pngImage(100, 50)] });
  const computer = await execution(native.session);
  return { ...native, computer, screen: await computer.capture() };
}

type AppList = { details: { apps: Array<{ app: string }> } };
type Recording = { details: { recording: boolean; resourceHandle: string } };

describe("cua-computer provider", () => {
  it("settles the native driver during node preparation without opening a computer execution", async () => {
    const { session, getDesktopState } = driver();
    const ready = createDeferred<void>();
    let available = false;
    session.isAvailable = () => available;
    session.prepareAvailability = async () => {
      await ready.promise;
      available = true;
    };
    const provider = createTestProvider(session);
    const preparing = provider.prepare?.({ config: {}, env: {} });
    expect(provider.isAvailable()).toBe(false);
    ready.resolve();
    await preparing;
    expect(provider.isAvailable()).toBe(true);
    expect(getDesktopState).not.toHaveBeenCalled();
  });

  it("validates the atomic macOS endpoint without starting its driver", () => {
    const { session } = driver();
    const passive = createTestProvider(session, "darwin", macOsEndpoint());
    expect(passive.isAvailable()).toBe(true);
    expect(createCuaMcpDriver).not.toHaveBeenCalled();
    for (const [label, env] of invalidMacOsEndpoints()) {
      expect(createTestProvider(session, "darwin", env).isAvailable(), label).toBe(false);
    }
  });

  it.each(["resolve", "reject"] as const)(
    "joins availability disposal through concurrent and later stops when it will %s",
    async (outcome) => {
      const { session, dispose } = driver();
      const retiring = createDeferred<void>();
      const entered = createDeferred<void>();
      const failure = new Error("availability driver retirement failed");
      dispose.mockImplementation(() => {
        entered.resolve();
        return retiring.promise;
      });
      const provider = createTestProvider(session);
      const stop = provider.watchAvailability?.({ config: {}, env: {} }, vi.fn());
      let settled = false;
      const results = Promise.allSettled([stop?.(), stop?.()]).then((values) => {
        settled = true;
        return values;
      });
      try {
        await entered.promise;
        await Promise.resolve();
        expect(settled).toBe(false);
        const expected =
          outcome === "reject"
            ? { status: "rejected", reason: failure }
            : { status: "fulfilled", value: undefined };
        if (outcome === "reject") {
          retiring.reject(failure);
        } else {
          retiring.resolve();
        }
        expect(await results).toEqual([expected, expected]);
        if (outcome === "reject") {
          await expect(Promise.resolve(stop?.())).rejects.toBe(failure);
        } else {
          await stop?.();
        }
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        retiring.resolve();
        await results;
      }
    },
  );

  it("forwards the no-screenshot observation request", async () => {
    const { session, callTool } = windowDriver();
    const computer = await execution(session);
    const windowRef = await computer.window();
    callTool.mockImplementationOnce(async (_name, args) =>
      cuaToolResult(fixtures.windowState, { image: args.include_screenshot !== false }),
    );
    const observed = await computer.read<WindowObservation>("get_window_state", {
      windowRef,
      includeScreenshot: false,
    });
    expect(observed.observation).not.toHaveProperty("base64");
    expect(observed).toMatchObject({ details: { coordinateSpace: "image-pixels" } });
  });

  it("rejects forged window, observation, and element refs before native resolution", async () => {
    const { session, callTool } = windowDriver();
    const computer = await execution(session);
    const target = await windowTarget(computer);
    const callsBeforeHostileRefs = callTool.mock.calls.length;

    for (const input of [
      { action: "get_window_state", windowRef: "/tmp/native-window" },
      { action: "left_click", ...target, observationId: "/tmp/native-observation" },
      { action: "left_click", ...target, elementRef: "../native-element" },
    ]) {
      await expect(computer.send(input)).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    }
    expect(callTool).toHaveBeenCalledTimes(callsBeforeHostileRefs);
  });

  it("maps window pixels, app lifecycle, menu, zoom, and escalation tools", async () => {
    const { session, callTool, getCursorPosition } = windowDriver((name) => {
      if (name === "list_apps") {
        return cuaToolResult(fixtures.listApps);
      }
      if (name === "zoom") {
        return {
          ...cuaToolResult({ width: 300, height: 200, format: "jpeg", mime_type: "image/jpeg" }),
          images: [{ mimeType: "image/jpeg", dataBase64: zoomImage }],
        };
      }
      if (name === "get_accessibility_tree") {
        return cuaToolResult({
          processes: [{ pid: 4242, name: "Editor" }],
          windows: fixtures.listWindows.windows,
        });
      }
      return actionResult("suspectedNoopAction");
    });
    const zoomImage = (
      await resizeToJpeg({
        buffer: createSolidPngBuffer(300, 200, { r: 70, g: 125, b: 180 }),
        maxSide: 300,
        quality: 85,
      })
    ).toString("base64");
    const computer = await execution(session);
    const apps = await computer.read<AppList>("list_apps");
    const app = apps.details.apps[0]!.app;
    const windowRef = await computer.window();
    const observed = await computer.observe(windowRef);
    getCursorPosition.mockResolvedValue(cuaToolResult({ x: 11, y: 12, source: "x11" }));
    const tree = await computer.read<{ details: { windows: unknown[]; processes: unknown[] } }>(
      "get_accessibility_tree",
    );
    expect(tree.details.windows).toHaveLength(1);
    expect(tree.details.processes).toHaveLength(1);
    await expect(computer.send("get_cursor_position")).resolves.toContain('"x":11');
    await computer.send("bring_to_front", { windowRef });
    await computer.send("set_value", {
      windowRef,
      observationId: observed.observation.observationId,
      elementRef: observed.observation.elements[0]!.elementRef,
      value: "new",
      deliveryMode: "background",
    });
    await computer.send("launch_app", { app });
    await computer.send("kill_app", { app });
    await computer.send("invoke_menu", { windowRef, path: ["File", "Save"] });
    const zoomed = await computer.read<{ observation: { observationId: string } }>("zoom", {
      windowRef,
      observationId: observed.observation.observationId,
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 100,
    });
    expect(zoomed.observation.observationId).not.toBe(observed.observation.observationId);
    expect(zoomed.observation).toMatchObject({
      base64: zoomImage,
      format: "jpeg",
      width: 300,
      height: 200,
    });
    await computer.send("left_click", {
      windowRef,
      observationId: zoomed.observation.observationId,
      x: 0,
      y: 0,
    });
    expect(callTool.mock.lastCall?.[1]).toMatchObject({ x: 0, y: 0, from_zoom: true });
    await computer.send("escalate_scope", { reason: "background_delivery_failed" });

    expect(callTool.mock.calls).toEqual(
      expect.arrayContaining([
        ["launch_app", { launch_path: "/usr/bin/editor" }, undefined],
        ["kill_app", { pid: 4242 }, undefined],
        ["invoke_menu", { ...nativeWindow, path: ["File", "Save"] }, undefined],
        ["bring_to_front", nativeWindow, undefined],
        ["set_value", { ...nativeWindow, ...elementToken, value: "new" }, undefined],
      ]),
    );
  });

  it.each([
    ["com.example.Editor", { bundle_id: "com.example.Editor" }],
    [null, { name: "Editor" }],
  ] as const)("launches the observed Darwin app with bundle ID %s", async (bundle_id, expected) => {
    const app = { name: "Editor", bundle_id, launch_path: "/Applications/Editor.app" };
    const { session, callTool } = driver();
    callTool
      .mockResolvedValueOnce(cuaToolResult({ apps: [{ ...app, running: false }] }))
      .mockResolvedValueOnce(cuaToolResult({ ...app, pid: 4242, running: true, windows: [] }));
    const computer = await execution(session, "darwin");
    const listed = await computer.read<AppList>("list_apps");
    const launched = await computer.read("launch_app", { app: listed.details.apps[0]!.app });
    expect(launched).toMatchObject({
      ok: true,
      details: { app: [{ name: app.name, running: true }] },
    });
    expect(callTool.mock.lastCall).toEqual(["launch_app", expected, undefined]);
  });

  it("rejects model-supplied app paths and commands before driver dispatch", async () => {
    const { session, callTool } = driver();
    const computer = await execution(session, "darwin");
    for (const app of ["/usr/bin/open", "../outside", "sh -c 'touch /tmp/owned'"]) {
      await expect(computer.send("launch_app", { app })).rejects.toThrow(
        "COMPUTER_STALE_OBSERVATION",
      );
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it("maps each Linux window input branch", async () => {
    const { session, callTool } = windowDriver(() => actionResult("confirmedBackgroundAction"));
    const computer = await execution(session);
    const { elementRef, ...target } = await windowTarget(computer);
    const pixelTarget = { ...target, ...windowPoint };
    const elementTarget = { elementRef, x: undefined, y: undefined };
    const cases = [
      ["left_click", "click", { ...elementTarget, deliveryMode: "background" }],
      ["right_click", "click", {}],
      ["left_click_drag", "drag", { fromX: 10, fromY: 15, durationMs: 250 }],
      ["left_mouse_down", "mouse_button_down", { deliveryMode: "background" }],
      ["left_mouse_up", "mouse_button_up", { deliveryMode: "background" }],
      ["scroll", "scroll", { scrollDirection: "down", scrollAmount: 4 }],
      ["type", "type_text", { ...elementTarget, text: "hello" }],
      ["key", "press_key", { keys: "ctrl+enter", x: undefined, y: undefined }],
    ] as const;
    for (const [action, tool, input] of cases) {
      expect(
        await computer.read(action, { ...pixelTarget, deliveryMode: "foreground", ...input }),
      ).toMatchObject({
        effect: "confirmed",
        details: {
          route: "accessibility",
          deliveryMode: "background",
          deliveredCount: 1,
          evidence: ["value_readback"],
        },
      });
      expect(callTool.mock.lastCall?.[0]).toBe(tool);
      expect(callTool.mock.lastCall?.[1]).toMatchObject(nativeWindow);
      if (action === "left_click") {
        expect(callTool.mock.lastCall?.[1]).toMatchObject({
          ...elementToken,
          delivery_mode: "background",
        });
      }
    }
  });
});

describe("cua-computer desktop frames", () => {
  it.each([
    ["linux", [1080, 1920], 1, 1280, [720, 1280], "capture cap"],
    ["darwin", [200, 100], 2, 100, [100, 50], "returned width"],
  ] as const)(
    "maps the returned bitmap on %s",
    async (platform, native, scale, cap, delivered, reference) => {
      const geometry = {
        platform: platform === "darwin" ? "macos" : platform,
        display: "primary",
        screenshot_width: native[0],
        screenshot_height: native[1],
        screen_width: native[0] / scale,
        screen_height: native[1] / scale,
        scale_factor: scale,
      };
      const input = driver({ geometry });
      input.scroll.mockResolvedValue({
        ...result({}),
        action: {
          effect: 3,
          route: 2,
          delivery: { mode: 1 },
          escalation: { target: 3, reason: 3 },
        },
      });
      input.getDesktopState.mockResolvedValue({
        ...result(geometry),
        images: [pngImage(native[0], native[1])],
      });
      const provider = createTestProvider(input.session, platform);
      expect(provider.capabilities().actions.includes("left_mouse_down")).toBe(
        platform === "linux",
      );
      const commands: OpenClawPluginNodeHostCommand[] = [];
      registerComputerUseProvider(
        { registerNodeHostCommand: (command) => commands.push(command) },
        provider,
      );
      const executionId = "123e4567-e89b-42d3-a456-426614174000";
      const invoke = (command: string, params: Record<string, unknown>) =>
        commands
          .find((entry) => entry.command === command)!
          .handle(JSON.stringify({ executionId, ...params }));
      onTestFinished(() =>
        invoke("computer.act", { action: "__close_execution", reason: "completion" }),
      );
      const screen = JSON.parse(
        await invoke("screen.snapshot", { format: "png", maxWidth: cap }),
      ) as Parameters<typeof frameTarget>[0];
      expect([screen.width, screen.height]).toEqual(delivered);
      expect(readImageMetadataFromHeader(Buffer.from(screen.base64, "base64"))).toEqual({
        width: screen.width,
        height: screen.height,
      });
      const frame = {
        displayFrameId: screen.displayFrameId,
        refWidth: reference === "capture cap" ? cap : screen.width,
      };
      const point = { x: screen.width / 2, y: screen.height / 2 };
      const nativePoint = { x: Math.round(native[0] / 2), y: Math.round(native[1] / 2) };
      const act = (action: string, params: Record<string, unknown> = {}) =>
        invoke("computer.act", { action, ...frame, ...point, ...params });

      await act("left_click");
      await act("mouse_move");
      const scroll = await act("scroll", {
        scrollDirection: "down",
        scrollAmount: 4,
        deliveryMode: "background",
      });
      expect(JSON.parse(scroll)).toMatchObject({
        effect: "suspected_noop",
        escalation: { recommended: "desktop", reasonCode: "suspected_noop" },
        details: {
          route: "global_input",
          deliveryMode: "foreground",
          scope: "desktop",
          deliveryModeApplicable: false,
        },
      });
      await act("left_click_drag", { fromX: 0, fromY: 0, durationMs: 500 });

      expect([
        input.click.mock.lastCall?.[0],
        input.moveCursor.mock.lastCall?.[0],
        input.scroll.mock.lastCall?.[0],
        input.drag.mock.lastCall?.[0],
      ]).toEqual([
        { ...nativePoint, button: ClickButton.Left, count: 1 },
        nativePoint,
        { ...nativePoint, direction: ScrollDirection.Down, amount: 4n },
        { fromX: 0, fromY: 0, toX: nativePoint.x, toY: nativePoint.y, durationMs: 500n },
      ]);
      for (const [x, y] of [
        [delivered[0], 0],
        [0, delivered[1]],
      ]) {
        await expect(act("left_click", { x, y })).rejects.toThrow("COMPUTER_INVALID_REQUEST");
      }
      expect(input.click).toHaveBeenCalledOnce();
    },
  );

  it("types text and presses a desktop key chord", async () => {
    const { session, typeText, pressKey } = driver();
    const computer = await execution(session);
    await computer.send("type", { text: "hello" });
    await computer.send("key", { keys: "ctrl+enter" });
    expect(typeText).toHaveBeenCalledWith("hello", undefined);
    expect(pressKey).toHaveBeenCalledWith({ key: "enter", modifiers: ["ctrl"] }, undefined);
  });

  it("turns a direct SDK refusal into a typed computer error", async () => {
    const { computer, screen, click } = await desktopExecution();
    click.mockResolvedValueOnce({
      ...result({}),
      isError: true,
      errorCode: "desktop_unavailable",
      text: "desktop input is unavailable",
    });
    await expect(clickFrame(computer, screen)).rejects.toThrow(
      "COMPUTER_REFUSED_desktop_unavailable",
    );
  });

  it.each([
    "mismatched reference width",
    "superseded capture scale",
    "changed display geometry",
    "reconnected driver",
  ])("rejects a %s before desktop input", async (cause) => {
    const { computer, screen, click, getScreenSize, setGeneration } = await desktopExecution();
    let refWidth = screen.width;
    switch (cause) {
      case "mismatched reference width":
        refWidth += 1;
        break;
      case "superseded capture scale":
        await computer.snapshot('{"format":"png","maxWidth":50}');
        refWidth = 50;
        break;
      case "changed display geometry":
        getScreenSize.mockResolvedValue(result({ width: 101, height: 50, scale_factor: 1 }));
        break;
      case "reconnected driver":
        setGeneration("execution-2");
        break;
    }
    await expect(clickFrame(computer, screen, { refWidth })).rejects.toThrow(
      "COMPUTER_STALE_FRAME",
    );
    expect(click).not.toHaveBeenCalled();
  });
});

async function observedWindowTarget(computer: ComputerExecution) {
  const windowRef = await computer.window();
  const observed = await computer.observe(windowRef);
  return { windowRef, observationId: observed.observation.observationId };
}

async function windowExecution(platform: NodeJS.Platform) {
  const native = windowDriver();
  const computer = await execution(native.session, platform);
  return { native, computer };
}

describe("cua-computer platform modifiers", () => {
  it.each([
    {
      scope: "desktop",
      keys: "Command+Shift+Left",
      expected: { key: "left", modifiers: ["cmd", "shift"] },
    },
    {
      scope: "window",
      keys: "Command+Shift+Left",
      expected: { key: "left", modifiers: ["cmd", "shift"] },
    },
    { scope: "desktop", keys: "Cmd", expected: { key: "cmd", modifiers: [] } },
  ] as const)("preserves $keys on macOS $scope input", async ({ scope, keys, expected }) => {
    const { native, computer } = await windowExecution("darwin");
    const target = scope === "window" ? await observedWindowTarget(computer) : {};
    await computer.act(JSON.stringify({ action: "key", keys, ...target }));

    if (scope === "desktop") {
      expect(native.pressKey).toHaveBeenCalledExactlyOnceWith(expected, undefined);
    } else {
      expect(native.callTool).toHaveBeenLastCalledWith(
        "press_key",
        { pid: 4242, window_id: 99, ...expected },
        undefined,
      );
      expect(native.pressKey).not.toHaveBeenCalled();
    }
  });

  it.each([
    { action: "left_click", scope: "desktop" },
    { action: "scroll", scope: "desktop" },
    { action: "scroll", scope: "window" },
  ])("keeps modified $scope $action unavailable", async ({ action, scope }) => {
    const { native, computer } = await windowExecution("darwin");
    const frame = await computer.capture();
    const target = scope === "window" ? await observedWindowTarget(computer) : frameTarget(frame);
    await expect(
      computer.send(action, {
        ...target,
        ...windowPoint,
        ...(action === "scroll" ? { scrollDirection: "down" } : {}),
        modifiers: "cmd",
      }),
    ).rejects.toThrow("COMPUTER_UNSUPPORTED_ACTION");
    expect(native.click).not.toHaveBeenCalled();
    expect(native.drag).not.toHaveBeenCalled();
    expect(native.scroll).not.toHaveBeenCalled();
    expect(native.callTool).toHaveBeenCalledTimes(scope === "window" ? 2 : 0);
  });

  it.each([
    ["Hyper", "foreground", "COMPUTER_UNSUPPORTED_KEY", 2],
    ["Command+Shift", "background", "COMPUTER_REFUSED_background_unavailable", 3],
  ] as const)(
    "rejects modified macOS clicks: %s",
    async (modifiers, deliveryMode, error, calls) => {
      const { native, computer } = await windowExecution("darwin");
      const target = await observedWindowTarget(computer);
      native.callTool.mockResolvedValueOnce(
        cuaToolResult(
          { code: "background_unavailable" },
          { isError: true, errorCode: "background_unavailable", text: "foreground required" },
        ),
      );
      await expect(
        computer.send("left_click", {
          ...target,
          ...windowPoint,
          modifiers,
          deliveryMode,
        }),
      ).rejects.toThrow(error);
      expect(native.callTool).toHaveBeenCalledTimes(calls);
      if (deliveryMode === "background") {
        expect(native.callTool.mock.lastCall?.[1]).toMatchObject({
          delivery_mode: "background",
          modifier: ["cmd", "shift"],
        });
      }
    },
  );
});

function recordingResult(enabled: boolean, outputDir: unknown) {
  return result({
    ...fixtures.recordingActive,
    recording: enabled,
    enabled,
    output_dir: outputDir ?? null,
  });
}

describe("execution authority preflight", () => {
  it("revokes stale input refs on renewal and accepts a fresh screenshot", async () => {
    const { session, click, setGeneration, computer, screen: before } = await desktopExecution();
    session.prepareExecution = vi.fn(async () => setGeneration("renewed-session"));
    await expect(clickFrame(computer, before)).rejects.toThrow("COMPUTER_STALE_FRAME");
    expect(click).not.toHaveBeenCalled();
    session.prepareExecution = vi.fn(async () => {});
    const fresh = await computer.capture();
    expect(fresh.displayFrameId).not.toBe(before.displayFrameId);
    await clickFrame(computer, fresh);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch actions when preparation refuses authority", async () => {
    const { session, getDesktopState, click } = driver();
    session.prepareExecution = vi.fn(async () => {
      throw new Error("Desktop scope denied");
    });
    const computer = await execution(session);
    await expect(computer.snapshot('{"format":"png"}')).rejects.toThrow("Desktop scope denied");
    expect(getDesktopState).not.toHaveBeenCalled();
    await expect(
      computer.send("left_click", { displayFrameId: "old", refWidth: 100, x: 1, y: 1 }),
    ).rejects.toThrow("Desktop scope denied");
    expect(click).not.toHaveBeenCalled();
  });
  it("retires an old recording without replay and allows an explicit fresh start", async () => {
    const { session, callTool, setGeneration } = driver();
    callTool.mockImplementation(async (name, args) =>
      recordingResult(name !== "stop_recording", args.output_dir),
    );
    const computer = await execution(session);
    const first = await computer.read<Recording>("start_recording");
    session.prepareExecution = vi
      .fn(async () => {})
      .mockImplementationOnce(async () => setGeneration("renewed-recording-session"));
    const after = await computer.read<Recording>("get_recording_state");
    expect(after.details).toEqual({ recording: false });
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(["start_recording"]);
    const fresh = await computer.read<Recording>("start_recording");
    expect(fresh.details.recording).toBe(true);
    expect(fresh.details.resourceHandle).not.toBe(first.details.resourceHandle);
    await computer.send("stop_recording");
  });
  it.each([false, true])(
    "close revokes input and recording ownership (released runtime: %s)",
    async (recording) => {
      const { session, setGeneration, callTool, typeText } = driver();
      callTool.mockImplementation(async (name, args) =>
        recordingResult(name !== "stop_recording", args.output_dir),
      );
      const computer = await execution(session);
      if (recording) {
        await computer.send("start_recording");
      }
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      session.prepareExecution = async (_signal, assertAuthority) => {
        entered.resolve();
        await release.promise;
        if (recording) {
          setGeneration("released-recording-runtime");
          assertAuthority?.();
        }
      };
      const acting = computer.send("type", { text: "must not type" });
      const rejected = expect(acting).rejects.toThrow(/closing|closed/);
      await entered.promise;
      const closing = computer.close("cancelled");
      release.resolve();
      await rejected;
      await expect(closing).resolves.toBeUndefined();
      expect(typeText).not.toHaveBeenCalled();
      expect(callTool.mock.calls.some(([name]) => name === "stop_recording")).toBe(false);
    },
  );
});
