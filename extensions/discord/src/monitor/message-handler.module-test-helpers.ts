import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, vi } from "vitest";
import * as preflightRuntime from "./message-handler.preflight.js";
import { processDiscordMessage } from "./message-handler.process.js";

vi.mock("./message-handler.process.js", { spy: true });

export { createDiscordMessageDispatcher as createDiscordMessageHandler } from "./message-dispatcher.js";

export const preflightDiscordMessageMock: MockFn = vi.fn();
export const processDiscordMessageMock: MockFn = vi.fn();
let restore = () => {};

beforeEach(() => {
  preflightDiscordMessageMock.mockReset();
  processDiscordMessageMock.mockReset();
  const preflight = vi
    .spyOn(preflightRuntime, "preflightDiscordMessage")
    .mockImplementation((...args) => preflightDiscordMessageMock(...args));
  const process = vi
    .mocked(processDiscordMessage)
    .mockImplementation((...args) => processDiscordMessageMock(...args));
  restore = () => {
    preflight.mockRestore();
    process.mockRestore();
  };
});
afterEach(() => restore());
