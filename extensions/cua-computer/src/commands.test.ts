import { registerComputerUseProvider } from "openclaw/plugin-sdk/computer-use";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resizeToJpeg } from "openclaw/plugin-sdk/media-runtime";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { readImageMetadataFromHeader } from "rastermill";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createCuaComputerProvider } from "./commands.js";
import {
  driver,
  execution,
  invalidMacOsEndpoints,
  macOsEndpoint,
  result,
} from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";
import { ClickButton, ScrollDirection, type CuaToolResult } from "./driver-client.js";

type ComputerExecution = Awaited<ReturnType<typeof execution>>;
type WindowObservation = {
  observation: { observationId: string; elements: Array<{ elementRef: string }> };
};

async function listWindow(computer: ComputerExecution) {
  const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
    details: { windows: Array<{ windowRef: string }> };
  };
  return listed.details.windows[0]!.windowRef;
}

async function observeWindow(computer: ComputerExecution, windowRef: string) {
  return JSON.parse(
    await computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
  ) as WindowObservation;
}

function windowDriver(handle: (name: string) => CuaToolResult = () => cuaToolResult({})) {
  const native = driver();
  native.callTool.mockImplementation(async (name) => {
    if (name === "list_windows") {
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
    }
    if (name === "get_window_state") {
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
    }
    return handle(name);
  });
  return native;
}

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
    const provider = createCuaComputerProvider({ platform: "linux", driver: session });
    const preparing = provider.prepare?.({ config: {}, env: {} });
    expect(provider.isAvailable()).toBe(false);
    ready.resolve();
    await preparing;
    expect(provider.isAvailable()).toBe(true);
    expect(getDesktopState).not.toHaveBeenCalled();
  });

  it("advertises the macOS mapping only with a valid atomic app-provided endpoint", () => {
    const { session } = driver();
    const endpoint = macOsEndpoint();
    const provider = createCuaComputerProvider({
      platform: "darwin",
      env: endpoint,
      driver: session,
    });

    expect(provider.isAvailable()).toBe(true);
    expect(provider.capabilities().actions).toContain("get_window_state");
    expect(provider.capabilities().actions).not.toContain("left_mouse_down");
    expect(provider.capabilities().features).toEqual({
      recording: true,
      agentCursor: false,
      multiDisplay: false,
    });

    const createDriver = vi.fn(() => session);
    const passive = createCuaComputerProvider({ platform: "darwin", env: endpoint, createDriver });
    expect(passive.isAvailable()).toBe(true);
    const declared = passive.capabilities();
    expect(passive.capabilities()).toEqual(declared);
    expect(declared.actions).toContain("get_window_state");
    expect(createDriver).not.toHaveBeenCalled();

    for (const [label, env] of invalidMacOsEndpoints()) {
      expect(
        createCuaComputerProvider({ platform: "darwin", env, driver: session }).isAvailable(),
        label,
      ).toBe(false);
    }
  });

  it("lazily owns one session and closes it when node-host availability stops", async () => {
    const { session, dispose } = driver();
    const createDriver = vi.fn(() => session);
    const clearInterval = vi.fn();
    const provider = createCuaComputerProvider({
      platform: "linux",
      createDriver,
      imageProcessor: {
        encode: vi.fn(async () => ({ data: Buffer.from("jpeg"), width: 100, height: 50 })),
      },
      setInterval: vi.fn(() => Object.assign(1, { unref: vi.fn() })) as never,
      clearInterval: clearInterval as never,
    });
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
      const provider = createCuaComputerProvider({
        platform: "linux",
        createDriver: () => session,
      });
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

  it("mints opaque refs without a screenshot and maps background evidence", async () => {
    const includeScreenshot = false;
    const { session, callTool } = driver();
    callTool.mockImplementation(async (name, args) => {
      switch (name) {
        case "list_windows":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
        case "get_window_state":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, {
            image: args.include_screenshot !== false,
          });
        case "click":
          return cuaToolResult(
            {},
            {
              action:
                CUA_DRIVER_CONTRACT_FIXTURES.confirmedBackgroundAction as unknown as CuaToolResult["action"],
            },
          );
        default:
          return cuaToolResult({});
      }
    });
    const computer = await execution(session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;
    expect(windowRef).toMatch(/^cua:v2:window:/);

    const observed = JSON.parse(
      await computer.act(
        JSON.stringify({ action: "get_window_state", windowRef, includeScreenshot }),
      ),
    ) as {
      observation: {
        base64?: string;
        observationId: string;
        elements: Array<{ elementRef: string }>;
      };
    };
    expect(Boolean(observed.observation.base64)).toBe(includeScreenshot);
    const { observationId } = observed.observation;
    const elementRef = observed.observation.elements[0]!.elementRef;
    expect(observed).toMatchObject({ details: { coordinateSpace: "image-pixels" } });
    expect(observationId).toMatch(/^cua:v2:observation:/);
    expect(elementRef).toMatch(/^cua:v2:element:/);

    const clicked = JSON.parse(
      await computer.act(
        JSON.stringify({
          action: "left_click",
          windowRef,
          elementRef,
          observationId,
          deliveryMode: "background",
        }),
      ),
    ) as { effect: string; details: Record<string, unknown> };
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
    expect(callTool).toHaveBeenLastCalledWith(
      "click",
      {
        pid: 4242,
        window_id: 99,
        element_token: "native-element-token-7",
        button: "left",
        count: 1,
        delivery_mode: "background",
      },
      undefined,
    );
  });

  it("rejects forged window, observation, and element refs before native resolution", async () => {
    const { session, callTool } = windowDriver();
    const computer = await execution(session);
    const windowRef = await listWindow(computer);
    const observed = await observeWindow(computer, windowRef);
    const callsBeforeHostileRefs = callTool.mock.calls.length;

    for (const input of [
      { action: "get_window_state", windowRef: "/tmp/native-window" },
      {
        action: "left_click",
        windowRef,
        observationId: "/tmp/native-observation",
        elementRef: observed.observation.elements[0]!.elementRef,
      },
      {
        action: "left_click",
        windowRef,
        observationId: observed.observation.observationId,
        elementRef: "../native-element",
      },
    ]) {
      await expect(computer.act(JSON.stringify(input))).rejects.toThrow(
        "COMPUTER_STALE_OBSERVATION",
      );
    }
    expect(callTool).toHaveBeenCalledTimes(callsBeforeHostileRefs);
  });

  it("maps window pixels, app lifecycle, menu, zoom, and escalation tools", async () => {
    const { session, callTool, getSessionState } = driver();
    const zoomImage = (
      await resizeToJpeg({
        buffer: createSolidPngBuffer(300, 200, { r: 70, g: 125, b: 180 }),
        maxSide: 300,
        quality: 85,
      })
    ).toString("base64");
    callTool.mockImplementation(async (name) => {
      switch (name) {
        case "list_apps":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listApps);
        case "list_windows":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
        case "get_window_state":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
        case "zoom":
          return {
            ...cuaToolResult({ width: 300, height: 200, format: "jpeg", mime_type: "image/jpeg" }),
            images: [{ mimeType: "image/jpeg", dataBase64: zoomImage }],
          };
        default:
          return cuaToolResult(
            {},
            {
              action:
                CUA_DRIVER_CONTRACT_FIXTURES.suspectedNoopAction as unknown as CuaToolResult["action"],
            },
          );
      }
    });
    const computer = await execution(session);
    const apps = JSON.parse(await computer.act('{"action":"list_apps"}')) as {
      details: { apps: Array<{ app: string }> };
    };
    const app = apps.details.apps[0]!.app;
    const windowRef = await listWindow(computer);
    const observed = await observeWindow(computer, windowRef);

    await computer.act(JSON.stringify({ action: "launch_app", app }));
    await computer.act(JSON.stringify({ action: "kill_app", app }));
    await computer.act(
      JSON.stringify({ action: "invoke_menu", windowRef, path: ["File", "Save"] }),
    );
    const zoomed = JSON.parse(
      await computer.act(
        JSON.stringify({
          action: "zoom",
          windowRef,
          observationId: observed.observation.observationId,
          x1: 0,
          y1: 0,
          x2: 100,
          y2: 100,
        }),
      ),
    ) as { observation: { observationId: string } };
    expect(zoomed.observation.observationId).not.toBe(observed.observation.observationId);
    expect(zoomed.observation).toMatchObject({
      base64: zoomImage,
      format: "jpeg",
      width: 300,
      height: 200,
    });
    await computer.act(
      JSON.stringify({
        action: "left_click",
        windowRef,
        observationId: zoomed.observation.observationId,
        x: 0,
        y: 0,
      }),
    );
    expect(callTool).toHaveBeenLastCalledWith(
      "click",
      { pid: 4242, window_id: 99, x: 0, y: 0, from_zoom: true, button: "left", count: 1 },
      undefined,
    );
    await computer.act(
      JSON.stringify({ action: "escalate_scope", reason: "background_delivery_failed" }),
    );

    expect(callTool).toHaveBeenCalledWith(
      "launch_app",
      { launch_path: "/usr/bin/editor" },
      undefined,
    );
    expect(callTool).toHaveBeenCalledWith("kill_app", { pid: 4242 }, undefined);
    expect(callTool).toHaveBeenCalledWith(
      "invoke_menu",
      { pid: 4242, window_id: 99, path: ["File", "Save"] },
      undefined,
    );
    expect(getSessionState).toHaveBeenCalledWith(undefined);
  });

  it.each([
    {
      label: "Darwin bundle identifier despite an observed path",
      platform: "darwin",
      app: {
        name: "TextEdit",
        bundle_id: "com.apple.TextEdit",
        launch_path: "/System/Applications/TextEdit.app",
      },
      expected: { bundle_id: "com.apple.TextEdit" },
    },
    {
      label: "Darwin display name without a bundle identifier",
      platform: "darwin",
      app: {
        name: "Example Editor",
        bundle_id: null,
        launch_path: "/Applications/Example Editor.app",
      },
      expected: { name: "Example Editor" },
    },
  ] as const)("launches an observed app using its $label", async ({ platform, app, expected }) => {
    const { session, callTool } = driver();
    callTool.mockImplementation(async (name, args) => {
      if (name === "list_apps") {
        return cuaToolResult({ apps: [{ ...app, running: false }] });
      }
      if (platform === "darwin" && !args.bundle_id && !args.name) {
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
    const computer = await execution(session, platform);
    try {
      const listed = JSON.parse(await computer.act('{"action":"list_apps"}')) as {
        details: { apps: Array<{ app: string }> };
      };
      const launched = JSON.parse(
        await computer.act(
          JSON.stringify({ action: "launch_app", app: listed.details.apps[0]!.app }),
        ),
      );

      expect(launched).toMatchObject({
        ok: true,
        details: { app: [{ name: app.name, running: true }] },
      });
      expect(callTool).toHaveBeenLastCalledWith("launch_app", expected, undefined);
    } finally {
      await computer.close("completion");
    }
  });

  it("rejects model-supplied app paths and commands before driver dispatch", async () => {
    const { session, callTool } = driver();
    const computer = await execution(session, "darwin");
    try {
      for (const app of ["/usr/bin/open", "../outside", "sh -c 'touch /tmp/owned'"]) {
        await expect(computer.act(JSON.stringify({ action: "launch_app", app }))).rejects.toThrow(
          "COMPUTER_STALE_OBSERVATION",
        );
      }

      expect(callTool).not.toHaveBeenCalled();
    } finally {
      await computer.close("completion");
    }
  });

  it("maps the complete Linux window pointer and keyboard family", async () => {
    const { session, callTool } = windowDriver(() => {
      return cuaToolResult(
        {},
        {
          action:
            CUA_DRIVER_CONTRACT_FIXTURES.confirmedBackgroundAction as unknown as CuaToolResult["action"],
        },
      );
    });
    const computer = await execution(session);
    const windowRef = await listWindow(computer);
    const observed = await observeWindow(computer, windowRef);
    const observationId = observed.observation.observationId;
    const elementRef = observed.observation.elements[0]!.elementRef;
    const pixelTarget = { windowRef, observationId, x: 20, y: 30 };
    const cases = [
      ["right_click", "click", { button: "right", count: 1 }],
      ["middle_click", "click", { button: "middle", count: 1 }],
      ["double_click", "click", { button: "left", count: 2 }],
      ["triple_click", "click", { button: "left", count: 3 }],
      ["left_click_drag", "drag", { from_x: 10, from_y: 15, to_x: 20, to_y: 30, duration_ms: 250 }],
      ["left_mouse_down", "mouse_button_down", { x: 20, y: 30, button: "left" }],
      ["left_mouse_up", "mouse_button_up", { x: 20, y: 30 }],
      ["scroll", "scroll", { direction: "down", by: "line", amount: 4 }],
      ["type", "type_text", { text: "hello", element_token: "native-element-token-7" }],
      ["key", "press_key", { key: "enter", modifiers: ["ctrl"] }],
    ] as const;

    for (const [action, tool, expected] of cases) {
      const actionInput: Record<string, unknown> = {
        action,
        ...pixelTarget,
        deliveryMode: action.startsWith("left_mouse_") ? "background" : "foreground",
      };
      if (action === "left_click_drag") {
        actionInput.fromX = 10;
        actionInput.fromY = 15;
        actionInput.durationMs = 250;
      } else if (action === "scroll") {
        actionInput.scrollDirection = "down";
        actionInput.scrollAmount = 4;
      } else if (action === "type") {
        actionInput.elementRef = elementRef;
        actionInput.text = "hello";
        delete actionInput.x;
        delete actionInput.y;
      } else if (action === "key") {
        actionInput.keys = "ctrl+enter";
        delete actionInput.x;
        delete actionInput.y;
      }
      await computer.act(JSON.stringify(actionInput));
      expect(callTool).toHaveBeenCalledWith(
        tool,
        expect.objectContaining({ pid: 4242, window_id: 99, ...expected }),
        undefined,
      );
    }
  });

  it("maps remaining discovery, window lifecycle, and semantic actions", async () => {
    const { session, callTool, getCursorPosition } = windowDriver((name) => {
      if (name === "get_accessibility_tree") {
        return cuaToolResult({
          processes: [{ pid: 4242, name: "Editor" }],
          windows: CUA_DRIVER_CONTRACT_FIXTURES.listWindows.windows,
        });
      }
      return cuaToolResult(
        {},
        {
          action:
            CUA_DRIVER_CONTRACT_FIXTURES.confirmedBackgroundAction as unknown as CuaToolResult["action"],
        },
      );
    });
    getCursorPosition.mockResolvedValue(cuaToolResult({ x: 11, y: 12, source: "x11" }));
    const computer = await execution(session);
    const tree = JSON.parse(await computer.act('{"action":"get_accessibility_tree"}')) as {
      details: { windows: unknown[]; processes: unknown[] };
    };
    expect(tree.details.windows).toHaveLength(1);
    expect(tree.details.processes).toHaveLength(1);
    await expect(computer.act('{"action":"get_cursor_position"}')).resolves.toContain('"x":11');
    expect(getCursorPosition).toHaveBeenCalledWith(undefined);

    const windowRef = await listWindow(computer);
    const observed = await observeWindow(computer, windowRef);
    await computer.act(JSON.stringify({ action: "bring_to_front", windowRef }));
    await computer.act(
      JSON.stringify({
        action: "set_value",
        windowRef,
        observationId: observed.observation.observationId,
        elementRef: observed.observation.elements[0]!.elementRef,
        value: "new",
        deliveryMode: "background",
      }),
    );
    expect(callTool).toHaveBeenCalledWith(
      "bring_to_front",
      { pid: 4242, window_id: 99 },
      undefined,
    );
    expect(callTool).toHaveBeenCalledWith(
      "set_value",
      {
        pid: 4242,
        window_id: 99,
        element_token: "native-element-token-7",
        value: "new",
      },
      undefined,
    );
  });

  it("invalidates observation references when the driver generation rotates", async () => {
    const { session, callTool, setGeneration } = driver();
    callTool.mockImplementation(async (name) =>
      name === "list_windows"
        ? cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows)
        : cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true }),
    );
    const computer = await execution(session);
    const windowRef = await listWindow(computer);
    setGeneration("execution-2");

    await expect(
      computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
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
    try {
      const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}'));
      const response = JSON.parse(
        await computer.act(
          JSON.stringify({
            action: "scroll",
            x: 10,
            y: 20,
            scrollDirection: "down",
            displayFrameId: screen.displayFrameId,
            refWidth: screen.width,
            deliveryMode: "background",
          }),
        ),
      );
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
    } finally {
      await computer.close("completion");
    }
  });

  it.each([
    {
      name: "portrait Linux display",
      platform: "linux",
      native: [1080, 1920],
      scale: 1,
      cap: 1280,
      delivered: [720, 1280],
      reference: "capture cap",
    },
    {
      name: "macOS Retina display",
      platform: "darwin",
      native: [200, 100],
      scale: 2,
      cap: 100,
      delivered: [100, 50],
      reference: "returned width",
    },
  ] as const)(
    "maps the returned bitmap on a $name using its $reference",
    async ({ platform, native, scale, cap, delivered, reference }) => {
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
        images: [
          {
            mimeType: "image/png",
            dataBase64: createSolidPngBuffer(native[0], native[1], {
              r: 70,
              g: 125,
              b: 180,
            }).toString("base64"),
          },
        ],
      });
      const provider = createCuaComputerProvider({
        platform,
        env: macOsEndpoint(),
        driver: input.session,
      });
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
      try {
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

        await invoke("computer.act", { action: "left_click", ...frame, ...point });
        await invoke("computer.act", { action: "mouse_move", ...frame, ...point });
        await invoke("computer.act", {
          action: "scroll",
          ...frame,
          ...point,
          scrollDirection: "down",
          scrollAmount: 4,
        });
        await invoke("computer.act", {
          action: "left_click_drag",
          ...frame,
          fromX: 0,
          fromY: 0,
          durationMs: 500,
          ...point,
        });

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
          await expect(
            invoke("computer.act", { action: "left_click", ...frame, x, y }),
          ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
        }
        expect(input.click).toHaveBeenCalledOnce();
      } finally {
        await invoke("computer.act", { action: "__close_execution", reason: "completion" });
      }
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
      const { session, getDesktopState, getScreenSize, click } = driver();
      const computer = await execution(session);
      try {
        const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
          displayFrameId: string;
          width: number;
        };
        await computer.act(
          JSON.stringify({
            action,
            displayFrameId: screen.displayFrameId,
            refWidth: screen.width,
            x: 10,
            y: 20,
          }),
        );
        expect(getDesktopState).toHaveBeenCalledOnce();
        expect(getScreenSize).toHaveBeenCalledOnce();
        expect(click).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 20, button, count }, undefined);
      } finally {
        await computer.close("completion");
      }
    },
  );

  it("maps scroll and key through typed SDK enums", async () => {
    const { session, typeText, pressKey } = driver();
    const computer = await execution(session);
    await computer.act('{"action":"type","text":"hello"}');
    await computer.act('{"action":"key","keys":"ctrl+enter"}');
    expect(typeText).toHaveBeenCalledWith("hello", undefined);
    expect(pressKey).toHaveBeenCalledWith({ key: "enter", modifiers: ["ctrl"] }, undefined);
    expect(ScrollDirection.Down).toBeTypeOf("number");
  });

  it("turns a direct SDK refusal into a typed computer error", async () => {
    const { session, click } = driver();
    click.mockResolvedValueOnce({
      ...result({}),
      isError: true,
      errorCode: "desktop_unavailable",
      text: "desktop input is unavailable",
    });
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    await expect(
      computer.act(
        JSON.stringify({
          action: "left_click",
          displayFrameId: screen.displayFrameId,
          refWidth: screen.width,
          x: 10,
          y: 20,
        }),
      ),
    ).rejects.toThrow("COMPUTER_REFUSED_desktop_unavailable");
  });

  it("rejects a mismatched reference width before desktop input", async () => {
    const { session, click } = driver();
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };

    await expect(
      computer.act(
        JSON.stringify({
          action: "left_click",
          displayFrameId: screen.displayFrameId,
          refWidth: screen.width + 1,
          x: 10,
          y: 20,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_FRAME: the coordinate reference width changed");
    expect(click).not.toHaveBeenCalled();
  });

  it.each(["superseded capture scale", "changed display geometry", "reconnected driver"])(
    "rejects a %s before desktop input",
    async (cause) => {
      const { session, click, getDesktopState, getScreenSize, setGeneration } = driver();
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
      const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
        displayFrameId: string;
      };
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
      await expect(computer.act(JSON.stringify(action))).rejects.toThrow("COMPUTER_STALE_FRAME");
      expect(click).not.toHaveBeenCalled();
      await computer.close("completion");
    },
  );
});

async function observedWindowTarget(computer: ComputerExecution) {
  const windowRef = await listWindow(computer);
  const observed = await observeWindow(computer, windowRef);
  return { windowRef, observationId: observed.observation.observationId };
}

async function windowExecution(platform: NodeJS.Platform) {
  const native = windowDriver();
  const computer = await execution(native.session, platform);
  onTestFinished(() => computer.close("completion"));
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
    const frame = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    const target =
      scope === "window"
        ? await observedWindowTarget(computer)
        : { displayFrameId: frame.displayFrameId, refWidth: frame.width };
    await expect(
      computer.act(
        JSON.stringify({
          action,
          ...target,
          x: 20,
          y: 30,
          ...(action === "scroll" ? { scrollDirection: "down" } : {}),
          modifiers: "cmd",
        }),
      ),
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
      computer.act(
        JSON.stringify({
          action: "left_click",
          ...target,
          x: 20,
          y: 30,
          modifiers: "Hyper",
          deliveryMode: "foreground",
        }),
      ),
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
      computer.act(
        JSON.stringify({
          action: "left_click",
          ...target,
          x: 20,
          y: 30,
          modifiers: "Command+Shift",
          deliveryMode: "background",
        }),
      ),
    ).rejects.toThrow("COMPUTER_REFUSED_background_unavailable");
    expect(native.callTool).toHaveBeenCalledTimes(3);
    expect(native.callTool.mock.lastCall?.[1]).toMatchObject({
      delivery_mode: "background",
      modifier: ["cmd", "shift"],
    });
  });
});
