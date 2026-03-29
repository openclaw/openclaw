import { vi } from "vitest";

type PiAiMockModule = Record<string, unknown>;

export async function createPiAiStreamSimpleMock(
  importOriginal: () => Promise<PiAiMockModule>,
): Promise<PiAiMockModule> {
  const original = await importOriginal();
  return {
    ...original,
    streamSimple: vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // Minimal async stream shape for wrappers that patch iteration/result.
      }),
    })),
  };
}
