import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { vi } from "vitest";
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
  const observe = (beamId: string) => ({
    value: structuredClone(values.get(beamId)),
    comparison: JSON.stringify(values.get(beamId) ?? null),
  });
  const keyedStore = {
    observe: vi.fn(async (beamId: string) => observe(beamId)),
    compareAndApply: vi.fn<
      NonNullable<PluginStateKeyedStore<BeamStoredSession>["compareAndApply"]>
    >(async (beamId, comparison, intent) => {
      const current = observe(beamId);
      if (current.comparison !== comparison) {
        return { status: "conflict", current };
      }
      if (intent.action === "keep") {
        return { status: "unchanged" };
      }
      if (intent.action !== "set") {
        throw new Error("unexpected Beam mutation");
      }
      values.set(beamId, structuredClone(intent.value));
      return { status: "applied" };
    }),
    lookup: async (beamId: string) => values.get(beamId),
    delete: async (beamId: string) => values.delete(beamId),
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
  };
  return {
    ...createBeamStore({
      state: { openKeyedStore: () => keyedStore },
    } as unknown as PluginRuntime),
    values,
    keyedStore,
  };
}
