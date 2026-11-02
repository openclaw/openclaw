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
import {
  ClickButton,
  createCuaDriver,
  ScrollDirection,
  type CuaToolResult,
} from "./driver-client.js";
import { createCuaMcpDriver } from "./mcp-driver-client.js";

async function execution(...args: Parameters<typeof openExecution>) {
  const computer = await openExecution(...args);
  onTestFinished(() => computer.close("completion"));
  return computer;
}

function expectTool(
  callTool: ReturnType<typeof driver>["callTool"],
  name: string,
  args: Record<string, unknown>,
) {
  expect(callTool).toHaveBeenCalledWith(name, args, undefined);
}

function expectLastTool(
  callTool: ReturnType<typeof driver>["callTool"],
  name: string,
  args: Record<string, unknown>,
) {
  expect(callTool).toHaveBeenLastCalledWith(name, args, undefined);
}

const windowPoint = { x: 20, y: 30 };
const elementToken = { element_token: "native-element-token-7" };

function actionResult(name: "confirmedBackgroundAction" | "suspectedNoopAction") {
  return cuaToolResult({}, { action: fixtures[name] as unknown as CuaToolResult["action"] });
}

function windowDriver(handle: (name: string) => CuaToolResult = () => cuaToolResult({})) {
  const native = driver();
  native.callTool.mockImplementation(async (name, args) => {
    if (name === "list_windows") {
      return cuaToolResult(fixtures.listWindows);
    }
    if (name === "get_window_state") {
      const elements = args.tree_format === "elements" ? fixtures.windowState.elements : undefined;
      const image = args.include_screenshot !== false;
      return cuaToolResult({ ...fixtures.windowState, elements }, { image });
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

  it("advertises platform actions and validates the atomic macOS app-provided endpoint", () => {
    const { session } = driver();
    const endpoint = macOsEndpoint();
    const passive = createTestProvider(session, "darwin", endpoint);
    expect(passive.isAvailable()).toBe(true);
    const declared = passive.capabilities();
    expect(declared.features).toEqual({
      recording: true,
      agentCursor: false,
      multiDisplay: false,
    });

    expect(passive.capabilities()).toEqual(declared);
    expect(createCuaMcpDriver).not.toHaveBeenCalled();

    for (const platform of ["darwin", "linux", "win32"] as const) {
      const actions = createTestProvider(session, platform, endpoint).capabilities().actions;
      expect(actions).toEqual(
        expect.arrayContaining([
          "screenshot",
          "get_window_state",
          "browser_download",
          "replay_trajectory",
          "invoke_menu",
        ]),
      );
      expect(actions).not.toContain("hold_key");
      expect(actions).not.toContain("wait");
      expect(actions.includes("left_mouse_down")).toBe(platform === "linux");
      expect(actions.includes("left_mouse_up")).toBe(platform === "linux");
    }

    for (const [label, env] of invalidMacOsEndpoints()) {
      expect(createTestProvider(session, "darwin", env).isAvailable(), label).toBe(false);
    }
  });

  it("lazily owns one session and closes it when node-host availability stops", async () => {
    const { session, dispose } = driver();
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    onTestFinished(() => clearInterval.mockRestore());
    const createDriver = vi.mocked(createCuaDriver);
    const provider = createTestProvider(session);
    createDriver.mockReturnValueOnce(session);
    expect(createDriver).not.toHaveBeenCalled();

    const computer = await provider.openExecution({
      executionId: "123e4567-e89b-42d3-a456-426614174000",
    });
    await computer.snapshot('{"format":"png","maxWidth":100}');
    expect(createDriver).toHaveBeenCalledOnce();

    const stop = provider.watchAvailability?.({ config: {} as never, env: {} }, vi.fn());
    await stop?.();
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
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
      const first = Promise.resolve(stop?.());
      const second = Promise.resolve(stop?.());
      let settled = false;
      const results = Promise.allSettled([first, second]).then((values) => {
        settled = true;
        return values;
      });
      try {
        await entered.promise;
        await Promise.resolve();
        expect(settled).toBe(false);
        if (outcome === "reject") {
          retiring.reject(failure);
          expect(await results).toEqual([
            { status: "rejected", reason: failure },
            { status: "rejected", reason: failure },
          ]);
          await expect(Promise.resolve(stop?.())).rejects.toBe(failure);
        } else {
          retiring.resolve();
          expect(await results).toEqual([
            { status: "fulfilled", value: undefined },
            { status: "fulfilled", value: undefined },
          ]);
          await stop?.();
        }
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        retiring.resolve();
        await results;
      }
    },
  );

  it("mints actionable refs without a screenshot when the driver defaults to Markdown", async () => {
    const { session, callTool } = windowDriver((name) =>
      name === "click" ? actionResult("confirmedBackgroundAction") : cuaToolResult({}),
    );
    const computer = await execution(session);
    const listed = await computer.read<{
      details: { windows: Array<{ windowRef: string; appName: string; title: string }> };
    }>("list_windows");
    expect(listed).toMatchObject({
      ok: true,
      details: { windows: [{ appName: "Editor", title: "Notes" }] },
    });
    const windowRef = listed.details.windows[0]!.windowRef;
    expect(windowRef).toMatch(/^cua:v2:window:/);

    const observed = await computer.read<WindowObservation>("get_window_state", {
      windowRef,
      includeScreenshot: false,
    });
    expect(Boolean(observed.observation.base64)).toBe(false);
    const { observationId, elements } = observed.observation;
    expect(elements).toHaveLength(1);
    const { elementRef } = elements[0]!;
    expect(observed).toMatchObject({ details: { coordinateSpace: "image-pixels" } });
    expect(observationId).toMatch(/^cua:v2:observation:/);
    expect(elementRef).toMatch(/^cua:v2:element:/);

    const clicked = await computer.read("left_click", {
      windowRef,
      elementRef,
      observationId,
      deliveryMode: "background",
    });
    expect(clicked).toMatchObject({
      ok: true,
      effect: "confirmed",
      details: {
        route: "accessibility",
        deliveryMode: "background",
        deliveredCount: 1,
        evidence: ["value_readback"],
      },
    });
    expectLastTool(callTool, "click", {
      ...nativeWindow,
      ...elementToken,
      button: "left",
      count: 1,
      delivery_mode: "background",
    });
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
    const { session, callTool, getSessionState } = windowDriver((name) => {
      if (name === "list_apps") {
        return cuaToolResult(fixtures.listApps);
      }
      if (name === "zoom") {
        return {
          ...cuaToolResult({ width: 300, height: 200, format: "jpeg", mime_type: "image/jpeg" }),
          images: [{ mimeType: "image/jpeg", dataBase64: zoomImage }],
        };
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
    expectLastTool(callTool, "click", {
      ...nativeWindow,
      x: 0,
      y: 0,
      from_zoom: true,
      button: "left",
      count: 1,
    });
    await computer.send("escalate_scope", { reason: "background_delivery_failed" });

    expectTool(callTool, "launch_app", { launch_path: "/usr/bin/editor" });
    expectTool(callTool, "kill_app", { pid: 4242 });
    expectTool(callTool, "invoke_menu", { ...nativeWindow, path: ["File", "Save"] });
    expect(getSessionState).toHaveBeenCalledWith(undefined);
  });

  it.each([
    [
      "TextEdit",
      "com.apple.TextEdit",
      "/System/Applications/TextEdit.app",
      { bundle_id: "com.apple.TextEdit" },
    ],
    ["Example Editor", null, "/Applications/Example Editor.app", { name: "Example Editor" }],
  ] as const)(
    "launches observed Darwin app %s",
    async (appName, bundle_id, launch_path, expected) => {
      const app = { name: appName, bundle_id, launch_path };
      const { session, callTool } = driver();
      callTool.mockImplementation(async (name, args) => {
        if (name === "list_apps") {
          return cuaToolResult({ apps: [{ ...app, running: false }] });
        }
        if (!args.bundle_id && !args.name) {
          return cuaToolResult(
            {},
            {
              isError: true,
              text: "Provide either bundle_id or name to identify the app to launch.",
            },
          );
        }
        return cuaToolResult({ ...app, pid: 4242, running: true, windows: [] });
      });
      const computer = await execution(session, "darwin");
      const listed = await computer.read<AppList>("list_apps");
      const launched = await computer.read("launch_app", { app: listed.details.apps[0]!.app });
      expect(launched).toMatchObject({
        ok: true,
        details: { app: [{ name: app.name, running: true }] },
      });
      expectLastTool(callTool, "launch_app", expected);
    },
  );

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

  it("maps the complete Linux window pointer and keyboard family", async () => {
    const { session, callTool } = windowDriver(() => actionResult("confirmedBackgroundAction"));
    const computer = await execution(session);
    const { elementRef, ...target } = await windowTarget(computer);
    const pixelTarget = { ...target, ...windowPoint };
    const cases = [
      ["right_click", "click", {}, { button: "right", count: 1 }],
      ["middle_click", "click", {}, { button: "middle", count: 1 }],
      ["double_click", "click", {}, { button: "left", count: 2 }],
      ["triple_click", "click", {}, { button: "left", count: 3 }],
      [
        "left_click_drag",
        "drag",
        { fromX: 10, fromY: 15, durationMs: 250 },
        { from_x: 10, from_y: 15, to_x: 20, to_y: 30, duration_ms: 250 },
      ],
      [
        "left_mouse_down",
        "mouse_button_down",
        { deliveryMode: "background" },
        { x: 20, y: 30, button: "left" },
      ],
      ["left_mouse_up", "mouse_button_up", { deliveryMode: "background" }, { x: 20, y: 30 }],
      [
        "scroll",
        "scroll",
        { scrollDirection: "down", scrollAmount: 4 },
        { direction: "down", by: "line", amount: 4 },
      ],
      [
        "type",
        "type_text",
        { elementRef, text: "hello", x: undefined, y: undefined },
        { text: "hello", element_token: "native-element-token-7" },
      ],
      [
        "key",
        "press_key",
        { keys: "ctrl+enter", x: undefined, y: undefined },
        { key: "enter", modifiers: ["ctrl"] },
      ],
    ] as const;

    for (const [action, tool, input, expected] of cases) {
      await computer.send(action, { ...pixelTarget, deliveryMode: "foreground", ...input });
      expect(callTool).toHaveBeenCalledWith(
        tool,
        expect.objectContaining({ ...nativeWindow, ...expected }),
        undefined,
      );
    }
  });

  it("maps remaining discovery, window lifecycle, and semantic actions", async () => {
    const { session, callTool, getCursorPosition } = windowDriver((name) => {
      if (name === "get_accessibility_tree") {
        return cuaToolResult({
          processes: [{ pid: 4242, name: "Editor" }],
          windows: fixtures.listWindows.windows,
        });
      }
      return actionResult("confirmedBackgroundAction");
    });
    getCursorPosition.mockResolvedValue(cuaToolResult({ x: 11, y: 12, source: "x11" }));
    const computer = await execution(session);
    const tree = await computer.read<{ details: { windows: unknown[]; processes: unknown[] } }>(
      "get_accessibility_tree",
    );
    expect(tree.details.windows).toHaveLength(1);
    expect(tree.details.processes).toHaveLength(1);
    await expect(computer.send("get_cursor_position")).resolves.toContain('"x":11');
    expect(getCursorPosition).toHaveBeenCalledWith(undefined);

    const target = await windowTarget(computer);
    await computer.send("bring_to_front", { windowRef: target.windowRef });
    await computer.send("set_value", {
      ...target,
      value: "new",
      deliveryMode: "background",
    });
    expectTool(callTool, "bring_to_front", nativeWindow);
    expectTool(callTool, "set_value", { ...nativeWindow, ...elementToken, value: "new" });
  });

  it("invalidates observation references when the driver generation rotates", async () => {
    const { session, callTool, setGeneration } = windowDriver();
    const computer = await execution(session);
    const windowRef = await computer.window();
    setGeneration("execution-2");

    await expect(computer.send("get_window_state", { windowRef })).rejects.toThrow(
      "COMPUTER_STALE_OBSERVATION",
    );
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

describe("cua-computer desktop frames", () => {
  it("preserves native effect evidence for desktop scroll", async () => {
    const input = driver();
    input.scroll.mockResolvedValue({
      ...result({}),
      action: { effect: 3, route: 2, delivery: { mode: 1 }, escalation: { target: 3, reason: 3 } },
    });
    const computer = await execution(input.session);
    const screen = await computer.capture();
    const response = await computer.read("scroll", {
      x: 10,
      y: 20,
      scrollDirection: "down",
      ...frameTarget(screen),
      deliveryMode: "background",
    });
    expect(response).toMatchObject({
      ok: true,
      effect: "suspected_noop",
      escalation: { recommended: "desktop", reasonCode: "suspected_noop" },
      details: {
        route: "global_input",
        deliveryMode: "foreground",
        scope: "desktop",
        deliveryModeApplicable: false,
      },
    });
  });

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
      input.getDesktopState.mockResolvedValue({
        ...result(geometry),
        images: [pngImage(native[0], native[1])],
      });
      const provider = createTestProvider(input.session, platform);
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
      onTestFinished(async () => {
        await invoke("computer.act", { action: "__close_execution", reason: "completion" });
      });
      const screen = JSON.parse(
        await invoke("screen.snapshot", { format: "png", maxWidth: cap }),
      ) as {
        base64: string;
        displayFrameId: string;
        width: number;
        height: number;
      };
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
      await act("scroll", { scrollDirection: "down", scrollAmount: 4 });
      await act("left_click_drag", { fromX: 0, fromY: 0, durationMs: 500 });

      expect(input.click).toHaveBeenCalledExactlyOnceWith(
        { ...nativePoint, button: ClickButton.Left, count: 1 },
        undefined,
      );
      expect(input.moveCursor).toHaveBeenCalledExactlyOnceWith(nativePoint, undefined);
      expect(input.scroll).toHaveBeenCalledExactlyOnceWith(
        { ...nativePoint, direction: ScrollDirection.Down, amount: 4n },
        undefined,
      );
      expect(input.drag).toHaveBeenCalledExactlyOnceWith(
        { fromX: 0, fromY: 0, toX: nativePoint.x, toY: nativePoint.y, durationMs: 500n },
        undefined,
      );
      for (const [x, y] of [
        [delivered[0], 0],
        [0, delivered[1]],
      ]) {
        await expect(act("left_click", { x, y })).rejects.toThrow("COMPUTER_INVALID_REQUEST");
      }
      expect(input.click).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { action: "right_click", button: ClickButton.Right, count: 1 },
    { action: "middle_click", button: ClickButton.Middle, count: 1 },
    { action: "double_click", button: ClickButton.Left, count: 2 },
    { action: "triple_click", button: ClickButton.Left, count: 3 },
  ])(
    "uses one typed session for snapshot and frame-authorized $action",
    async ({ action, button, count }) => {
      const { computer, screen, getDesktopState, getScreenSize, click } = await desktopExecution();
      await computer.send(action, { ...frameTarget(screen), x: 10, y: 20 });
      expect(getDesktopState).toHaveBeenCalledOnce();
      expect(getScreenSize).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 20, button, count }, undefined);
    },
  );

  it("maps scroll and key through typed SDK enums", async () => {
    const { session, typeText, pressKey } = driver();
    const computer = await execution(session);
    await computer.send("type", { text: "hello" });
    await computer.send("key", { keys: "ctrl+enter" });
    expect(typeText).toHaveBeenCalledWith("hello", undefined);
    expect(pressKey).toHaveBeenCalledWith({ key: "enter", modifiers: ["ctrl"] }, undefined);
    expect(ScrollDirection.Down).toBeTypeOf("number");
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

  it("rejects a mismatched reference width before desktop input", async () => {
    const { computer, screen, click } = await desktopExecution();

    await expect(clickFrame(computer, screen, { refWidth: screen.width + 1 })).rejects.toThrow(
      "COMPUTER_STALE_FRAME: the coordinate reference width changed",
    );
    expect(click).not.toHaveBeenCalled();
  });

  it.each(["superseded capture scale", "changed display geometry", "reconnected driver"])(
    "rejects a %s before desktop input",
    async (cause) => {
      const { session, click, getDesktopState, getScreenSize, setGeneration } = driver();
      const desktop = await getDesktopState();
      desktop.images = [pngImage(100, 50)];
      getDesktopState.mockResolvedValue(desktop);
      const computer = await execution(session);
      const screen = await computer.capture();
      const action = {
        action: "left_click",
        displayFrameId: screen.displayFrameId,
        refWidth: 100,
        x: 10,
        y: 20,
      };
      switch (cause) {
        case "superseded capture scale":
          await computer.snapshot('{"format":"png","maxWidth":50}');
          action.refWidth = 50;
          break;
        case "changed display geometry":
          getScreenSize.mockResolvedValue(result({ width: 101, height: 50, scale_factor: 1 }));
          break;
        case "reconnected driver":
          setGeneration("execution-2");
          break;
      }
      await expect(computer.send(action)).rejects.toThrow("COMPUTER_STALE_FRAME");
      expect(click).not.toHaveBeenCalled();
    },
  );
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

  it("rejects unknown window click modifiers before dispatch", async () => {
    const { native, computer } = await windowExecution("darwin");
    const target = await observedWindowTarget(computer);
    await expect(
      computer.send("left_click", {
        ...target,
        ...windowPoint,
        modifiers: "Hyper",
        deliveryMode: "foreground",
      }),
    ).rejects.toThrow("COMPUTER_UNSUPPORTED_KEY");
    expect(native.callTool).toHaveBeenCalledTimes(2);
  });

  it("preserves macOS background refusal for a modified click", async () => {
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
        modifiers: "Command+Shift",
        deliveryMode: "background",
      }),
    ).rejects.toThrow("COMPUTER_REFUSED_background_unavailable");
    expect(native.callTool).toHaveBeenCalledTimes(3);
    expect(native.callTool.mock.lastCall?.[1]).toMatchObject({
      delivery_mode: "background",
      modifier: ["cmd", "shift"],
    });
  });
});

function recordingResult(enabled: boolean, outputDir: unknown) {
  return result({
    recording: enabled,
    enabled,
    output_dir: outputDir ?? null,
    next_turn: 0,
    last_error: null,
    video_active: false,
    last_video_path: null,
    owner: null,
  });
}

describe("execution authority preflight", () => {
  it("revokes stale input refs on renewal and accepts a fresh screenshot", async () => {
    const { session, click, getDesktopState, setGeneration } = driver();
    const desktop = await getDesktopState();
    desktop.images = [pngImage(100, 50)];
    getDesktopState.mockResolvedValue(desktop);
    const computer = await execution(session);
    const before = await computer.capture();
    session.prepareExecution = vi.fn(async () => setGeneration("renewed-session"));
    const action = {
      action: "left_click",
      displayFrameId: before.displayFrameId,
      refWidth: 100,
      x: 10,
      y: 20,
    };
    await expect(computer.send(action)).rejects.toThrow("COMPUTER_STALE_FRAME");
    expect(click).not.toHaveBeenCalled();
    session.prepareExecution = vi.fn(async () => {});
    const fresh = await computer.capture();
    expect(fresh.displayFrameId).not.toBe(before.displayFrameId);
    await computer.send({ ...action, displayFrameId: fresh.displayFrameId });
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
    let enabled = false;
    callTool.mockImplementation(async (name, args) => {
      if (name === "start_recording") {
        enabled = true;
      }
      if (name === "stop_recording") {
        enabled = false;
      }
      return recordingResult(enabled, args.output_dir);
    });
    const computer = await execution(session);
    const first = await computer.read<Recording>("start_recording");
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
    const after = await computer.read<Recording>("get_recording_state");
    expect(after.details).toEqual({ recording: false });
    expect(callTool.mock.calls.filter(([name]) => name === "start_recording")).toHaveLength(1);
    expect(callTool.mock.calls.filter(([name]) => name === "stop_recording")).toHaveLength(0);
    const fresh = await computer.read<Recording>("start_recording");
    expect(fresh.details.recording).toBe(true);
    expect(fresh.details.resourceHandle).not.toBe(first.details.resourceHandle);
    await computer.send("stop_recording");
  });
  it("rejects input when close revokes ownership during preparation", async () => {
    const { session, typeText } = driver();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    session.prepareExecution = async () => {
      entered.resolve();
      await release.promise;
    };
    const computer = await execution(session);
    const acting = computer.send("type", { text: "MUST_NOT_TYPE" });
    const rejected = expect(acting).rejects.toThrow(/closing|closed/);
    await entered.promise;
    const closing = computer.close("cancelled");
    release.resolve();
    await rejected;
    await closing;
    expect(typeText).not.toHaveBeenCalled();
  });
  it("does not recreate recording ownership when close interrupts a released runtime", async () => {
    const { session, setGeneration } = driver();
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) =>
      recordingResult(name !== "stop_recording", args.output_dir),
    );
    session.callTool = callTool;
    const computer = await execution(session);
    await computer.send("start_recording");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    session.prepareExecution = async (_signal, assertAuthority) => {
      entered.resolve();
      await release.promise;
      setGeneration("released-recording-runtime");
      assertAuthority?.();
    };
    const acting = computer.send("type", { text: "must not type" });
    const rejected = expect(acting).rejects.toThrow(/closing|closed/);
    await entered.promise;
    const closing = computer.close("cancelled");
    release.resolve();
    await rejected;
    await expect(closing).resolves.toBeUndefined();
    expect(callTool.mock.calls.some(([name]) => name === "stop_recording")).toBe(false);
  });
});
