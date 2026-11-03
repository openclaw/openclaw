import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  PluginStateEntry,
  PluginStateOperationCommand,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { vi } from "vitest";
import { executeBeamUpload, type BeamUploadOperations } from "../upload-operation-api.js";
import { createBeamStore } from "./store.js";
import type { BeamStoredSession } from "./types.js";

type BeamUploadFixture = Omit<BeamStoredSession, "createdAt" | "receivedAt">;

export function sampleUpload(overrides: Record<string, unknown> = {}): BeamUploadFixture {
  return {
    version: 1,
    beamId: "0123456789abcdef0123456789abcdef",
    source: "claude",
    title: "Fix the upload flow",
    updatedAt: "2026-07-20T12:00:00.000Z",
    completed: false,
    items: [
      { type: "userMessage", text: "Please fix the upload flow." },
      { type: "agentMessage", text: "Implemented and tested." },
    ],
    ...overrides,
  } as BeamUploadFixture;
}

export function memoryStore() {
  const values = new Map<string, BeamStoredSession>();
  const keyedStore = {
    createOperation: vi.fn(
      (_stores: unknown, _handler: unknown, authority: { assertCurrent(): void }) => ({
        async execute(command: PluginStateOperationCommand<BeamUploadOperations>) {
          authority.assertCurrent();
          const pending = new Map(values);
          const result = executeBeamUpload(command, {
            lookup: (_store, key) => pending.get(key),
            // The fixture owns one Beam namespace, like the production worker transaction.
            lookupMany: <T>(keys: readonly { store: number; key: string }[]) =>
              keys.map(({ key }) => pending.get(key)) as Array<T | undefined>,
            entries<T>(_store: number): PluginStateEntry<T>[] {
              return [...pending].map(([key, value]) => ({ key, value: value as T, createdAt: 0 }));
            },
            set: (_store, key, value) => pending.set(key, value as BeamStoredSession),
            delete: (_store, key) => pending.delete(key),
          });
          authority.assertCurrent();
          values.clear();
          pending.forEach((row, key) => values.set(key, row));
          return { value: result, assertCurrent: () => authority.assertCurrent() };
        },
      }),
    ),
    lookup: async (beamId: string) => values.get(beamId),
    delete: async (beamId: string) => values.delete(beamId),
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
  return {
    ...createBeamStore({
      state: { openKeyedStoreV2: () => keyedStore },
    } as unknown as PluginRuntime),
    values,
    keyedStore,
  };
}

export const staffReceipt = (receivedAt: number) => ({
  receivedAt,
  publisher: { kind: "staff" as const },
  assertCurrent() {},
});
