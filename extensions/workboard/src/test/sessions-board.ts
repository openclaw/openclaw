import { afterEach, vi } from "vitest";
import { createWorkboardSessionsBoardService } from "../sessions-board.js";
import type { WorkboardStore } from "../store.js";

const services: Array<ReturnType<typeof createWorkboardSessionsBoardService>> = [];

afterEach(async () => {
  try {
    for (const service of services.splice(0)) {
      await service.stop();
    }
  } finally {
    vi.useRealTimers();
  }
});

/** Adapter tests use real board persistence and classification with an empty session roster. */
export async function startEmptySessionsBoardService(store: WorkboardStore) {
  const service = createWorkboardSessionsBoardService({
    store,
    gateway: {
      isAvailable: async () => true,
      request: vi.fn().mockResolvedValue({ sessions: [] }),
      readSessionFacts: vi.fn().mockResolvedValue({ sessions: [] }),
    },
    getConfig: () => ({}),
    complete: async () => '{"placements":[]}',
  });
  services.push(service);
  await service.start({
    config: {},
    stateDir: "unused",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return service;
}
