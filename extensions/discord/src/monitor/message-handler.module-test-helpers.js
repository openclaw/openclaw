import { vi } from "vitest";
const preflightDiscordMessageMock = vi.fn();
const processDiscordMessageMock = vi.fn();
vi.mock("./message-handler.preflight.js", () => ({
  preflightDiscordMessage: preflightDiscordMessageMock
}));
vi.mock("./message-handler.process.js", () => ({
  processDiscordMessage: processDiscordMessageMock
}));
const { createDiscordMessageHandler } = await import("./message-handler.js");
export {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock
};
