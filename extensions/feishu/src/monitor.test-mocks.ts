import { vi } from "vitest";

type TestMock = ReturnType<typeof vi.fn>;

const probeFeishuMock: TestMock = vi.hoisted(() => vi.fn());

export function getProbeFeishuMock(): TestMock {
  return probeFeishuMock;
}

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
}));
