import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execution } from "./commands.test-helpers.js";
import { cuaToolResult } from "./cua-driver-contract.test-fixtures.js";

const mocks = vi.hoisted(() => {
  const state = async () => ({
    session: "openclaw-test",
    captureScope: "desktop",
    effectiveScope: "desktop",
    desktopCaptureAuthorized: true,
    desktopUnlocked: true,
  });
  const session = {
    callTool: vi.fn(async () => ({})),
    click: vi.fn(async () => ({ effect: 0, route: 2 })),
    close: vi.fn(),
    drag: vi.fn(async () => ({})),
    endSession: vi.fn(async () => ({})),
    escalateSession: vi.fn(state),
    getCursorPosition: vi.fn(async () => ({})),
    getDesktopState: vi.fn(async () => ({})),
    getSessionState: vi.fn(state),
    moveCursor: vi.fn(async () => ({})),
    pressKey: vi.fn(async () => ({})),
    scroll: vi.fn(async () => ({})),
    startSession: vi.fn(async () => ({})),
    typeText: vi.fn(async () => ({})),
  };
  return {
    ...session,
    session,
    create: vi.fn(),
    createConfigured: vi.fn(),
    createDesktopTarget: vi.fn(({ displayId }: { displayId: string }) => ({
      tag: "Desktop",
      inner: { displayId },
    })),
    createClickPosition: vi.fn(({ x, y }: { x: number; y: number }) => ({
      tag: "Coordinates",
      inner: { x, y },
    })),
    createTrustedSession: vi.fn(),
    isAvailable: vi.fn(() => true),
    isToolError: vi.fn((_error: unknown) => false),
    isShutdownError: vi.fn((_error: unknown) => false),
    shutdown: vi.fn(async () => {}),
  };
});

const sdk = {
  ActionTarget: { Desktop: { new: mocks.createDesktopTarget } },
  ClickPosition: { Coordinates: { new: mocks.createClickPosition } },
  ClickButton: { Left: 0, Right: 1, Middle: 2 },
  CuaDriver: { create: mocks.create, createConfigured: mocks.createConfigured },
  DriverError: {
    Tool: { instanceOf: mocks.isToolError },
    Shutdown: { instanceOf: mocks.isShutdownError },
  },
  InputDeliveryMode: { Foreground: 1 },
  ScrollBy: { Line: 0 },
  ScrollDirection: { Up: 0, Down: 1, Left: 2, Right: 3 },
  SessionPermissionMode: { Unrestricted: "unrestricted" },
  createTrustedSession: mocks.createTrustedSession,
};

import { ClickButton, createCuaDriver, ScrollDirection } from "./driver-client.js";

const authorization = {
  allowedModes: ["unrestricted"],
  compatibilityMode: "unrestricted",
  unrestrictedAcknowledged: true,
  maxSessionTtlSeconds: 3_600n,
  maxIdleTtlSeconds: 300n,
};

function expectCall(name: keyof typeof mocks, ...args: unknown[]) {
  expect(mocks[name]).toHaveBeenCalledWith(...args);
}

function expectCalls(count: number, ...names: Array<keyof typeof mocks>) {
  for (const name of names) {
    expect(mocks[name]).toHaveBeenCalledTimes(count);
  }
}

const drivers: ReturnType<typeof createCuaDriver>[] = [];
let driver: ReturnType<typeof createCuaDriver>;
function makeDriver(loadSdk = async () => sdk as never) {
  const created = createCuaDriver({ loadSdk });
  drivers.push(created);
  return created;
}
const clickInput = { x: 20, y: 30, button: ClickButton.Left, count: 1 };
const expired = (message = "Permission denied: authorization context expired") =>
  Object.assign(new Error("DriverError.Tool"), {
    inner: { tool: "get_session_state", errorCode: "permission_denied", message },
  });
async function prepareExpiry() {
  await driver.prepareExecution?.();
  mocks.isToolError.mockReturnValue(true);
  mocks.getSessionState.mockRejectedValueOnce(expired());
}

describe("CUA Driver direct session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isToolError.mockReturnValue(false);
    mocks.isShutdownError.mockReturnValue(false);
    mocks.createConfigured.mockReturnValue({
      isAvailable: mocks.isAvailable,
      shutdown: mocks.shutdown,
    });
    mocks.createTrustedSession.mockReturnValue(mocks.session);
    driver = makeDriver();
  });
  afterEach(async () => {
    for (const created of drivers.splice(0)) {
      await created.dispose();
    }
  });

  it("matches the installed CUA Driver desktop input enum contract", async () => {
    const driverSdk = await import("@trycua/cua-driver");

    expect(ClickButton).toEqual({
      Left: driverSdk.ClickButton.Left,
      Right: driverSdk.ClickButton.Right,
      Middle: driverSdk.ClickButton.Middle,
    });
    expect(ScrollDirection).toEqual({
      Up: driverSdk.ScrollDirection.Up,
      Down: driverSdk.ScrollDirection.Down,
      Left: driverSdk.ScrollDirection.Left,
      Right: driverSdk.ScrollDirection.Right,
    });
  });

  it("uses configured creation with one trusted lifecycle session", async () => {
    await driver.prepareAvailability?.();
    expect(driver.isAvailable()).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expectCall("createConfigured", { claudeCodeCompatibility: false, authorization });
    expectCalls(1, "createTrustedSession");
    expectCall(
      "createTrustedSession",
      expect.anything(),
      expect.objectContaining({
        publicSession: expect.stringMatching(/^openclaw-/),
        mode: "unrestricted",
        ttlSeconds: authorization.maxSessionTtlSeconds,
        idleTtlSeconds: authorization.maxIdleTtlSeconds,
      }),
    );

    await driver.dispose();
    await driver.dispose();
    expectCalls(1, "close", "shutdown");
  });

  it("starts the shared lifecycle session once before using driver tools", async () => {
    await Promise.all([driver.getDesktopState(), driver.callTool("list_windows", {})]);
    const sessionOptions = mocks.createTrustedSession.mock.calls[0]?.[1];

    expectCalls(1, "startSession");
    expectCall("startSession", { session: sessionOptions.publicSession }, undefined);
    expectCalls(1, "getDesktopState");
    expectCall(
      "callTool",
      "list_windows",
      JSON.stringify({ session: sessionOptions.publicSession }),
      undefined,
    );

    await driver.dispose();
    expectCalls(1, "endSession");
    expectCall("endSession", { session: sessionOptions.publicSession });
  });

  it("retries a rejected startup before admitting driver tools", async () => {
    const failure = new Error("fixture startup failed");
    mocks.startSession.mockRejectedValueOnce(failure);
    await expect(driver.getDesktopState()).rejects.toBe(failure);
    await driver.getDesktopState();
    expectCalls(2, "startSession");
    expectCalls(1, "getDesktopState");
  });

  it("targets desktop input while keeping the global cursor read untargeted", async () => {
    const clicked = await driver.click(clickInput);
    expect(clicked).toMatchObject({ isError: false, action: { effect: 0, route: 2 } });
    await driver.drag({ fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 5n });
    await driver.moveCursor({ x: 6, y: 7 });
    await driver.scroll({ x: 8, y: 9, direction: ScrollDirection.Down, amount: 3n });
    await driver.typeText("hello");
    await driver.pressKey({ key: "a", modifiers: ["cmd"] });
    await driver.getCursorPosition();
    await driver.getSessionState();

    const sessionOptions = mocks.createTrustedSession.mock.calls[0]?.[1];
    const target = { tag: "Desktop", inner: { displayId: "primary" } };
    expectCalls(1, "createDesktopTarget");
    expectCall("createDesktopTarget", { displayId: "primary" });
    const expectedInputs = [
      [
        mocks.click,
        {
          position: { tag: "Coordinates", inner: { x: 20, y: 30 } },
          deliveryMode: 1,
          button: ClickButton.Left,
          count: 1,
        },
      ],
      [mocks.drag, { fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 5n }],
      [mocks.moveCursor, { x: 6, y: 7 }],
      [mocks.scroll, { x: 8, y: 9, direction: ScrollDirection.Down, amount: 3n, by: 0 }],
      [mocks.typeText, { text: "hello" }],
      [mocks.pressKey, { key: "a", modifiers: ["cmd"] }],
    ] as const;
    for (const [mock, input] of expectedInputs) {
      expect(mock).toHaveBeenCalledWith({ ...input, target }, undefined);
    }
    expectCall("getCursorPosition", { session: sessionOptions.publicSession }, undefined);
    expectCall("getSessionState", { session: sessionOptions.publicSession }, undefined);
    expect(mocks.escalateSession).not.toHaveBeenCalled();
  });

  it("preserves typed SDK click refusals in the shared driver result", async () => {
    const { DriverError } = await import("@trycua/cua-driver");
    const refusal = DriverError.Tool.new({
      tool: "click",
      message: "desktop input is unavailable",
      errorCode: "desktop_unavailable",
    });
    mocks.isToolError.mockImplementation((error) => DriverError.Tool.instanceOf(error));
    mocks.click.mockRejectedValueOnce(refusal);
    await expect(driver.click(clickInput)).resolves.toMatchObject({
      isError: true,
      errorCode: "desktop_unavailable",
      text: "desktop input is unavailable",
    });
    const transportError = new Error("transport disconnected");
    mocks.click.mockRejectedValueOnce(transportError);
    await expect(driver.click(clickInput)).rejects.toBe(transportError);
  });

  it("awaits an ESM driver before the first availability declaration without starting an execution", async () => {
    const loading = Promise.withResolvers<typeof sdk>();
    const loadSdk = vi.fn(() => loading.promise as never);
    driver = makeDriver(loadSdk);

    const preparing = driver.prepareAvailability?.();
    expect(loadSdk).toHaveBeenCalledOnce();

    loading.resolve(sdk);
    await preparing;
    expect(driver.isAvailable()).toBe(true);
    expect(mocks.startSession).not.toHaveBeenCalled();
    await driver.getDesktopState();

    expect(loadSdk).toHaveBeenCalledOnce();
    expectCalls(1, "createConfigured", "getDesktopState");
  });

  it("retries an asynchronous ESM import failure after the availability cache resets", async () => {
    const loadSdk = vi
      .fn(async () => sdk as never)
      .mockRejectedValueOnce(new Error("native module is temporarily unavailable"));
    driver = makeDriver(loadSdk);

    expect(loadSdk).not.toHaveBeenCalled();
    expect(driver.isAvailable()).toBe(false);
    expect(loadSdk).toHaveBeenCalledOnce();
    await driver.prepareAvailability?.();
    expect(driver.isAvailable()).toBe(false);
    for (const read of [() => driver.getDesktopState(), () => driver.getScreenSize()]) {
      await expect(read()).rejects.toThrow(
        "COMPUTER_DRIVER_UNAVAILABLE: failed to load CUA Driver SDK: native module is temporarily unavailable",
      );
    }
    expect(loadSdk).toHaveBeenCalledOnce();

    driver.resetAvailabilityCache();
    expect(driver.isAvailable()).toBe(false);
    await driver.prepareAvailability?.();
    expect(driver.isAvailable()).toBe(true);

    expect(loadSdk).toHaveBeenCalledTimes(2);
  });

  it("re-establishes an expired session on the next provider action without replaying input", async () => {
    const computer = await execution(driver);
    mocks.getCursorPosition.mockResolvedValueOnce(cuaToolResult({ x: 10, y: 20 }));
    await computer.send("get_cursor_position");
    const generation = driver.generation;
    mocks.isToolError.mockReturnValue(true);
    mocks.getSessionState.mockRejectedValueOnce(expired());
    mocks.endSession.mockRejectedValueOnce(expired());

    mocks.typeText.mockResolvedValueOnce(cuaToolResult({}));
    expect(JSON.parse(await computer.send("type", { text: "hello" }))).toMatchObject({
      ok: true,
    });
    expect(driver.generation).not.toBe(generation);
    expectCalls(2, "createConfigured");
    expect(mocks.createConfigured).toHaveBeenNthCalledWith(2, {
      claudeCodeCompatibility: false,
      authorization,
    });
    expectCalls(2, "createTrustedSession");
    const first = mocks.createTrustedSession.mock.calls[0]?.[1];
    const second = mocks.createTrustedSession.mock.calls[1]?.[1];
    expect(second).toMatchObject({ ttlSeconds: 3_600n, idleTtlSeconds: 300n });
    expect(second.publicSession).not.toBe(first.publicSession);
    expectCalls(1, "close", "shutdown", "typeText");
    await computer.close("completion");
  });

  it("does not renew a real permission denial and exposes its structured cause", async () => {
    const computer = await execution(driver);
    await driver.prepareExecution?.();
    const generation = driver.generation;
    const denied = expired("Desktop scope denied");
    mocks.isToolError.mockReturnValue(true);
    mocks.getSessionState.mockRejectedValueOnce(denied);
    await expect(computer.send("type", { text: "must not type" })).rejects.toMatchObject({
      message: "CUA_DRIVER_TOOL_ERROR: get_session_state: Desktop scope denied (permission_denied)",
      cause: denied,
    });
    expect(driver.generation).toBe(generation);
    expectCalls(1, "createConfigured");
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.typeText).not.toHaveBeenCalled();
    await computer.close("completion");
  });

  it("shares concurrent preparation and performs at most one replacement", async () => {
    await prepareExpiry();
    await Promise.all([driver.prepareExecution?.(), driver.prepareExecution?.()]);
    expectCalls(2, "createConfigured");
    expectCalls(3, "getSessionState");
    const generation = driver.generation;
    await driver.prepareExecution?.();
    expect(driver.generation).toBe(generation);
    expectCalls(2, "createConfigured");
  });

  it.each(["disposal", "cancellation", "revocation"] as const)(
    "does not reopen when %s interrupts expired-session cleanup",
    async (interruption) => {
      await prepareExpiry();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      mocks.endSession.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw expired();
      });
      const controller = new AbortController();
      let admitted = true;
      const preparing = driver.prepareExecution?.(controller.signal, () => {
        if (!admitted) {
          throw new Error("owning execution revoked");
        }
      });
      const rejected = expect(preparing).rejects.toThrow(/stopping|cancelled|revoked/);
      await entered.promise;
      const disposal = interruption === "disposal" ? driver.dispose() : undefined;
      if (interruption === "cancellation") {
        controller.abort(new Error("cancelled"));
      }
      admitted = interruption !== "revocation";
      release.resolve();
      await rejected;
      await disposal;
      expectCalls(1, "createConfigured", "close", "shutdown");
      if (interruption === "cancellation") {
        await driver.prepareExecution?.();
        expectCalls(2, "createConfigured");
      }
    },
  );

  it("reports failed expired-session cleanup and recovers on the next provider action", async () => {
    const computer = await execution(driver);
    await driver.prepareExecution?.();
    const generation = driver.generation;
    const denied = expired("Desktop scope denied");
    mocks.isToolError.mockReturnValue(true);
    mocks.getSessionState.mockRejectedValueOnce(expired());
    mocks.endSession.mockRejectedValueOnce(denied);
    const action = '{"action":"type","text":"hello"}';
    await expect(computer.act(action)).rejects.toBe(denied);
    expect(driver.generation).not.toBe(generation);
    expectCalls(1, "close", "shutdown");
    expect(mocks.typeText).not.toHaveBeenCalled();
    mocks.typeText.mockResolvedValueOnce(cuaToolResult({}));
    expect(JSON.parse(await computer.act(action))).toMatchObject({ ok: true });
    expectCalls(1, "typeText");
    await computer.close("completion");
  });

  it("does not loop if the replacement session also refuses authority", async () => {
    await driver.prepareExecution?.();
    mocks.isToolError.mockReturnValue(true);
    const refusal = expired();
    mocks.getSessionState.mockRejectedValueOnce(expired()).mockRejectedValueOnce(refusal);
    await expect(driver.prepareExecution?.()).rejects.toMatchObject({
      message:
        "CUA_DRIVER_TOOL_ERROR: get_session_state: Permission denied: authorization context expired (permission_denied)",
      cause: refusal,
    });
    expectCalls(2, "createConfigured");
  });
  it("does not admit native authority for an already-revoked owner", async () => {
    await expect(
      driver.prepareExecution?.(undefined, () => {
        throw new Error("owning execution revoked");
      }),
    ).rejects.toThrow("owning execution revoked");
    expect(mocks.createConfigured).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("does not start a native session when the execution closes during SDK loading", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    driver = makeDriver(async () => {
      entered.resolve();
      await release.promise;
      return sdk as never;
    });
    const computer = await execution(driver);
    const acting = computer.send("type", { text: "must not type" });
    const rejected = expect(acting).rejects.toThrow("provider execution is closing");
    await entered.promise;
    const closing = computer.close("cancelled");
    release.resolve();
    await rejected;
    await closing;
    expect(mocks.startSession).not.toHaveBeenCalled();
    expect(mocks.typeText).not.toHaveBeenCalled();
  });

  it("does not renew a terminally revoked native session and still releases its runtime", async () => {
    await driver.prepareExecution?.();
    const shutdown = new Error("DriverError.Shutdown");
    mocks.isShutdownError.mockImplementation((error) => error === shutdown);
    mocks.getSessionState.mockRejectedValueOnce(shutdown);
    await expect(driver.prepareExecution?.()).rejects.toBe(shutdown);
    expectCalls(1, "createConfigured");
    expect(mocks.click).not.toHaveBeenCalled();
    mocks.endSession.mockRejectedValueOnce(shutdown);
    await expect(driver.dispose()).resolves.toBeUndefined();
    expectCalls(1, "close", "shutdown");
  });
});
