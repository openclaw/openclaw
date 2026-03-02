import { vi } from "vitest";

export const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
}));
