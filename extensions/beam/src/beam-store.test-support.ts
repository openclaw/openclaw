import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  PluginStateEntry,
  PluginStateOperationCommand,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { vi } from "vitest";
import { executeBeamUpload, type BeamUploadOperations } from "../upload-operation-api.js";
import { createBeamStore } from "./store.js";
import type { BeamStoredSession } from "./types.js";

const { guardFixtures } = vi.hoisted(() => ({
  guardFixtures: new WeakMap<
    object,
    (key: string, predicate: (value: unknown) => void) => { assertCurrent(): void; release(): void }
  >(),
}));

vi.mock("openclaw/plugin-sdk/plugin-state-runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-state-runtime")>();
  return {
    ...runtime,
    preparePluginStateGuard: (...args: Parameters<typeof runtime.preparePluginStateGuard>) =>
      guardFixtures.get(args[0])?.(args[1], args[2]) ?? runtime.preparePluginStateGuard(...args),
  };
});

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
  const handoffValues = new Map<string, BeamStoredSession>();
  const namespaces = [values, handoffValues];
  const createNamespace = (rows: Map<string, BeamStoredSession>) => {
    const keyed = {
      createOperation: vi.fn(
        (_stores: unknown, _handler: unknown, authority: { assertCurrent(): void }) => ({
          async execute(command: PluginStateOperationCommand<BeamUploadOperations>) {
            authority.assertCurrent();
            const pending = namespaces.map((namespace) => new Map(namespace));
            const result = executeBeamUpload(command, {
              lookup: (store, key) => pending[store]!.get(key),
              lookupMany: <T>(keys: readonly { store: number; key: string }[]) =>
                keys.map(({ store, key }) => pending[store]!.get(key)) as Array<T | undefined>,
              entries<T>(store: number): PluginStateEntry<T>[] {
                return [...pending[store]!].map(([key, value]) => ({
                  key,
                  value: value as T,
                  createdAt: 0,
                }));
              },
              set: (store, key, value) => pending[store]!.set(key, value as BeamStoredSession),
              delete: (store, key) => pending[store]!.delete(key),
            });
            authority.assertCurrent();
            namespaces.forEach((namespace, index) => {
              namespace.clear();
              pending[index]!.forEach((row, key) => namespace.set(key, row));
            });
            return { value: result, assertCurrent: () => authority.assertCurrent() };
          },
        }),
      ),
      lookup: async (beamId: string) => rows.get(beamId),
      delete: async (beamId: string) => rows.delete(beamId),
      entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
      entriesInKeyRange: async (range: {
        keyStartInclusive: string;
        keyEndExclusive: string;
        limit: number;
      }) =>
        [...rows]
          .filter(([key]) => key >= range.keyStartInclusive && key < range.keyEndExclusive)
          .slice(0, range.limit)
          .map(([key, value]) => ({ key, value, createdAt: 0 })),
    };
    guardFixtures.set(keyed, (key, predicate) => ({
      assertCurrent: () => predicate(rows.get(key)),
      release() {},
    }));
    return keyed;
  };
  const keyedStore = createNamespace(values);
  const handoffStore = createNamespace(handoffValues);
  return {
    ...createBeamStore({
      state: {
        openKeyedStoreV2: ({ namespace }: { namespace: string }) =>
          namespace === "handoffs" ? handoffStore : keyedStore,
      },
    } as unknown as PluginRuntime),
    values,
    handoffValues,
    keyedStore,
  };
}

export const staffReceipt = (receivedAt: number) => ({
  receivedAt,
  publisher: { kind: "staff" as const },
  assertCurrent() {},
});

export async function releaseSource(
  store: Pick<ReturnType<typeof createBeamStore>, "upload">,
  receivedAt = 100,
  profileId = "source-publisher",
) {
  const receipt = { ...staffReceipt(receivedAt), publisher: { kind: "staff" as const, profileId } };
  const payload = sampleUpload();
  const published = await store.upload(payload, receipt);
  if (typeof published !== "object" || published.kind !== "published" || !published.id) {
    throw new Error("fixture publication was not accepted");
  }
  const released = await store.upload({ ...payload, handoffId: published.id }, receipt);
  if (typeof released !== "object" || released.kind !== "handoff" || !released.accepted) {
    throw new Error("fixture source release was not accepted");
  }
  return published.id;
}
