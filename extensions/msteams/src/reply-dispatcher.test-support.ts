import { vi } from "vitest";

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
  acknowledge: (text: string) => void;
};

export function createStreamMock(): StreamMock {
  let chunkHandler:
    | ((activity: {
        id: string;
        type: string;
        text: string;
        channelData: { streamType: string };
      }) => void)
    | undefined;
  return {
    update: vi.fn(),
    emit: vi.fn(),
    clearText: vi.fn(),
    close: vi.fn(async () => ({ id: "stream-final" })),
    canceled: false,
    events: {
      on: vi.fn((_event: "chunk", handler: typeof chunkHandler) => {
        chunkHandler = handler;
        return 0;
      }),
      off: vi.fn(() => {
        chunkHandler = undefined;
      }),
    },
    acknowledge: (text: string) => {
      chunkHandler?.({
        id: "stream-acknowledged",
        type: "typing",
        text,
        channelData: { streamType: "streaming" },
      });
    },
  };
}
