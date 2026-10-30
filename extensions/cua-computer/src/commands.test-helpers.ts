import { randomUUID } from "node:crypto";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { onTestFinished, vi } from "vitest";
import { createCuaComputerProvider } from "./commands.js";
import { cuaToolResult } from "./cua-driver-contract.test-fixtures.js";
import { createCuaDriver, type CuaDriverSession, type CuaToolResult } from "./driver-client.js";
import { createCuaMcpDriver } from "./mcp-driver-client.js";

vi.mock("./driver-client.js", { spy: true });
vi.mock("./mcp-driver-client.js", { spy: true });

const geometry = {
  platform: "linux",
  display: "primary",
  screenshot_width: 100,
  screenshot_height: 50,
  screen_width: 100,
  screen_height: 50,
  scale_factor: 1,
};
const sessionState = { captureScope: 2, effectiveScope: 1, desktopUnlocked: true };

const CUA_DRIVER_ENDPOINT_ENV = "OPENCLAW_CUA_DRIVER_ENDPOINT";

export const macOsEndpoint = (overrides: Record<string, unknown> = {}): NodeJS.ProcessEnv => ({
  [CUA_DRIVER_ENDPOINT_ENV]: JSON.stringify({
    v: 1,
    socketPath: "/tmp/openclaw-cua-test/driver.sock",
    binaryPath: process.execPath,
    ...overrides,
  }),
});

export const invalidMacOsEndpoints = (): Array<[string, NodeJS.ProcessEnv]> => [
  ["missing", {}],
  ["malformed JSON", { [CUA_DRIVER_ENDPOINT_ENV]: "{" }],
  ["partial", macOsEndpoint({ binaryPath: undefined })],
  ["unsupported version", macOsEndpoint({ v: 2 })],
  ["extra field", macOsEndpoint({ extra: true })],
  ["relative socket", macOsEndpoint({ socketPath: "relative.sock" })],
  ["relative binary", macOsEndpoint({ binaryPath: "cua-driver" })],
  ["nul socket", macOsEndpoint({ socketPath: "/tmp/cua\0.sock" })],
  ["missing binary", macOsEndpoint({ binaryPath: "/missing/cua-driver" })],
  ["oversized", macOsEndpoint({ socketPath: `/${"x".repeat(4_096)}` })],
];

export const result = (structured: Record<string, unknown>, image = false): CuaToolResult =>
  cuaToolResult(structured, { image });

export function driver(options: { geometry?: typeof geometry } = {}) {
  let generation = "execution-1";
  const activeGeometry = options.geometry ?? geometry;
  const { screen_width: width, screen_height: height, scale_factor } = activeGeometry;
  const methods = {
    getDesktopState: vi.fn(async () => result(activeGeometry, true)),
    getScreenSize: vi.fn(async () => result({ width, height, scale_factor })),
    click: vi.fn(async () => result({})),
    drag: vi.fn(async () => result({})),
    moveCursor: vi.fn(async () => result({})),
    scroll: vi.fn(async () => result({})),
    typeText: vi.fn(async () => result({})),
    pressKey: vi.fn(async () => result({})),
    callTool: vi.fn<CuaDriverSession["callTool"]>(async () => result({})),
    getCursorPosition: vi.fn<CuaDriverSession["getCursorPosition"]>(async () => result({})),
    getSessionState: vi.fn(async () => ({ ...sessionState })),
    dispose: vi.fn(async () => {}),
  };
  const session: CuaDriverSession = {
    ...methods,
    get generation() {
      return generation;
    },
    isAvailable: () => true,
    resetAvailabilityCache: () => {},
  };
  return {
    session,
    ...methods,
    setGeneration: (value: string) => {
      generation = value;
    },
  };
}

export function createTestProvider(
  session: CuaDriverSession,
  platform: NodeJS.Platform = "linux",
  env: NodeJS.ProcessEnv = macOsEndpoint(),
) {
  const createDriver = vi.mocked(platform === "darwin" ? createCuaMcpDriver : createCuaDriver);
  createDriver.mockReturnValueOnce(session);
  onTestFinished(() => createDriver.mockRestore());
  const endpoint = process.env[CUA_DRIVER_ENDPOINT_ENV];
  const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValueOnce(platform);
  vi.stubEnv(CUA_DRIVER_ENDPOINT_ENV, env[CUA_DRIVER_ENDPOINT_ENV]);
  try {
    return createCuaComputerProvider();
  } finally {
    platformSpy.mockRestore();
    vi.stubEnv(CUA_DRIVER_ENDPOINT_ENV, endpoint);
  }
}

export async function execution(session: CuaDriverSession, platform: NodeJS.Platform = "linux") {
  const provider = createTestProvider(session, platform);
  const computer = await provider.openExecution({ executionId: randomUUID() });
  const send = (action: string | Record<string, unknown>, params: Record<string, unknown> = {}) =>
    computer.act(JSON.stringify(typeof action === "string" ? { action, ...params } : action));
  const read = async <T>(action: string, params: Record<string, unknown> = {}): Promise<T> =>
    JSON.parse(await send(action, params)) as T;
  return Object.assign(computer, {
    send,
    read,
    capture: async (): Promise<Screen> =>
      JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')),
    window: async () =>
      (await read<{ details: { windows: Array<{ windowRef: string }> } }>("list_windows")).details
        .windows[0]!.windowRef,
    observe: (windowRef: string) => read<WindowObservation>("get_window_state", { windowRef }),
  });
}

export type ComputerExecution = Awaited<ReturnType<typeof execution>>;
type Screen = { base64: string; displayFrameId: string; width: number; height: number };

export type WindowObservation = {
  observation: { base64?: string; observationId: string; elements: Array<{ elementRef: string }> };
};

export const pngImage = (width: number, height: number) => ({
  mimeType: "image/png",
  dataBase64: createSolidPngBuffer(width, height, { r: 70, g: 125, b: 180 }).toString("base64"),
});

export function frameTarget(screen: Screen) {
  return { displayFrameId: screen.displayFrameId, refWidth: screen.width };
}
