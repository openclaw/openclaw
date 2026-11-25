import { vi } from "vitest";

export function createQaLabCaptureMock() {
  const store = {
    listSessions: vi.fn(),
    getSessionEvents: vi.fn(),
    summarizeSessionCoverage: vi.fn(),
    queryPreset: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const acquire = vi.fn(async () => ({ store, release: store.close }));
  return {
    store,
    acquire,
    reset() {
      acquire.mockClear();
      for (const mock of Object.values(store)) {
        mock.mockReset();
      }
      store.listSessions.mockResolvedValue([]);
      store.close.mockResolvedValue(undefined);
    },
    seedSession(sessionId: string) {
      store.listSessions.mockResolvedValue([{ id: sessionId, eventCount: 3 }]);
      store.getSessionEvents.mockResolvedValue([
        ...["flow-1", "flow-2"].map((flowId) => ({
          flowId,
          dataText: '{"hello":"world"}',
          metaJson: JSON.stringify({
            provider: "openai",
            api: "responses",
            model: "gpt-5.6-luna",
            captureOrigin: "shared-fetch",
          }),
        })),
        {
          flowId: "flow-3",
          metaJson: JSON.stringify({
            provider: "ollama",
            model: "kimi-k2.5:cloud",
            captureOrigin: "shared-fetch",
          }),
        },
      ]);
      store.summarizeSessionCoverage.mockResolvedValue({
        sessionId,
        totalEvents: 3,
        unlabeledEventCount: 0,
        providers: [
          { value: "openai", count: 2 },
          { value: "ollama", count: 1 },
        ],
        models: [
          { value: "gpt-5.6-luna", count: 2 },
          { value: "kimi-k2.5:cloud", count: 1 },
        ],
        localPeers: [{ value: "127.0.0.1:11434", count: 1 }],
      });
      store.queryPreset.mockResolvedValue([{ host: "api.example.com", duplicateCount: 2 }]);
    },
  };
}
