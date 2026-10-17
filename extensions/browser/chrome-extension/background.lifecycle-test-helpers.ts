import { expect, vi, type Mock } from "vitest";
import { sendRuntimeMessage, TEST_RELAY_KEY } from "./background.test-harness.js";

export const runtime = (
  harness: Parameters<typeof sendRuntimeMessage>[0],
  type: string,
  fields: Record<string, unknown> = {},
) => sendRuntimeMessage(harness, { type, ...fields });

export const relayConfig = (accessMode = "all") => ({
  relayUrl: "ws://127.0.0.1:18797/extension",
  token: TEST_RELAY_KEY,
  authVersion: 2,
  accessMode,
});

export const createTab = (url = "about:blank") => ({ type: "createTab", url });
export const cdp = (method: string, params?: Record<string, unknown>, tabId = 101) => ({
  type: "cdp",
  tabId,
  method,
  ...(params === undefined ? {} : { params }),
});

export function expectType(response: unknown, type = "result") {
  expect(response).toMatchObject({ type });
}

export function expectUnused(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export async function waitCalled(mock: unknown, ...args: unknown[]) {
  await vi.waitFor(() => {
    if (args.length) {
      expect(mock).toHaveBeenCalledWith(...args);
    } else {
      expect(mock).toHaveBeenCalled();
    }
  });
}

export function holdNext<Args extends unknown[], Result>(
  mock: Mock<(...args: Args) => Promise<Result>>,
  gate: Promise<void>,
) {
  const original = mock.getMockImplementation()!;
  mock.mockImplementationOnce(async (...args) => {
    await gate;
    return await original(...args);
  });
}
