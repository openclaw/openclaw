import { vi } from "vitest";

type ChunkActivity = {
  id?: string;
  type?: string;
  text?: string;
  channelData?: { streamType?: string };
};

/** Mock for the SDK's reply stream, including acknowledged typing chunks. */
export type StreamMock = {
  update: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  clearText: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn<() => Promise<{ id: string } | undefined>>>;
  canceled: boolean;
  events: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  acknowledge: (text: string, overrides?: Partial<ChunkActivity>) => void;
};

export function createStreamMock(): StreamMock {
  const handlers = new Map<number, (activity: ChunkActivity) => void>();
  let nextSubscriptionId = 0;
  return {
    update: vi.fn(),
    emit: vi.fn(),
    clearText: vi.fn(),
    close: vi.fn(async () => ({ id: "stream-final" })),
    canceled: false,
    events: {
      on: vi.fn((_event: "chunk", handler: (activity: ChunkActivity) => void) => {
        const id = nextSubscriptionId++;
        handlers.set(id, handler);
        return id;
      }),
      off: vi.fn((id: number) => {
        handlers.delete(id);
      }),
    },
    acknowledge: (text: string, overrides: Partial<ChunkActivity> = {}) => {
      const activity: ChunkActivity = {
        id: "stream-acknowledged",
        type: "typing",
        text,
        channelData: { streamType: "streaming" },
        ...overrides,
      };
      for (const handler of handlers.values()) {
        handler(activity);
      }
    },
  };
}
