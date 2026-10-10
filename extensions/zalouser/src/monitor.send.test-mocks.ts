// Zalouser plugin module implements monitor.send mocks behavior.
import { vi } from "vitest";

const sendMocks = vi.hoisted(() => ({
  sendMessageZalouserMock: vi.fn(async () => {}),
}));

export const sendMessageZalouserMock = sendMocks.sendMessageZalouserMock;

vi.mock("./send.js", () => ({
  sendMessageZalouser: sendMessageZalouserMock,
}));
