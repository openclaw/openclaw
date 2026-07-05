// Memory Core plugin module implements embedding mocks behavior.
<<<<<<< HEAD
import { vi } from "vitest";
import "./test-runtime-mocks.js";

=======
import { vi, type Mock } from "vitest";
import "./test-runtime-mocks.js";

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
type EmbedBatchMock = Mock<(texts: string[]) => Promise<number[][]>>;

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
const hoisted = vi.hoisted(() => ({
  embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0])),
  embedQuery: vi.fn(async () => [0, 1, 0]),
}));

<<<<<<< HEAD
=======
export function getEmbedBatchMock(): EmbedBatchMock {
  return hoisted.embedBatch;
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function resetEmbeddingMocks(): void {
  hoisted.embedBatch.mockReset();
  hoisted.embedQuery.mockReset();
  hoisted.embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
  hoisted.embedQuery.mockImplementation(async () => [0, 1, 0]);
}

vi.mock("./embeddings.js", () => ({
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      maxInputTokens: 8192,
      embedQuery: hoisted.embedQuery,
      embedBatch: hoisted.embedBatch,
    },
  }),
}));
