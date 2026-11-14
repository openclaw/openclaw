// Covers which slot owners and loaded memory sidecars make an attempt mint a memory audience.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginRecord } from "../../../plugins/registry-types.js";

const { fakeSessionOwner, fakeSessionGenerationModule, fakeSessionEntryReadModule } =
  await vi.hoisted(() => import("../../../plugins/memory-audience.test-support.js"));

const mocks = vi.hoisted(() => ({ kind: undefined as "native" | "legacy" | undefined }));

// mock-isolation: the fake session owner replaces SQLite generation facts.
vi.mock(
  "../../../config/sessions/session-delivery-generation.js",
  () => fakeSessionGenerationModule,
);
// mock-isolation: the fake session owner replaces worker-thread session reads.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => fakeSessionEntryReadModule);
// mock-isolation: selects the slot owner's kind; the sidecar check stays real.
vi.mock("../../../plugins/memory-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/memory-state.js")>()),
  resolveLoadedMemoryProviderKind: () => mocks.kind,
}));

const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
const { clearActivePluginRegistry, setActivePluginRegistry } =
  await import("../../../plugins/runtime.js");
const { resolveEmbeddedAttemptMemoryAudience } = await import("./attempt-memory-audience.js");

const ROOT_KEY = "agent:main:root";
const STORE_PATH = "/tmp/openclaw-attempt-memory-audience/main.sqlite";

function config(sidecar?: boolean): OpenClawConfig {
  return {
    plugins: {
      slots: { memory: "memory-core" },
      entries: {
        "hindsight-native": {
          enabled: true,
          ...(sidecar === undefined ? {} : { memory: { sidecar } }),
        },
      },
    },
  };
}

function loadPlugins(...records: Array<Pick<PluginRecord, "id" | "status" | "kind">>) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(...records.map((record) => record as PluginRecord));
  setActivePluginRegistry(registry);
}

const memoryCore = { id: "memory-core", kind: "memory", status: "loaded" } as const;
const hindsight = { id: "hindsight-native", kind: "memory", status: "loaded" } as const;

// An owner's direct root turn, which the host maps to the owner-private audience.
function ownerTurn(cfg: OpenClawConfig) {
  const root = {
    sessionId: randomUUID(),
    lifecycleRevision: randomUUID(),
    updatedAt: 1,
    chatType: "direct" as const,
  };
  fakeSessionOwner.rows.set(ROOT_KEY, root);
  return {
    agentId: "main",
    sessionKey: ROOT_KEY,
    sessionId: root.sessionId,
    run: { senderIsOwner: true, config: cfg },
    admission: { entry: root, storePath: STORE_PATH },
  };
}

async function expectGranted(cfg: OpenClawConfig) {
  const resolved = await resolveEmbeddedAttemptMemoryAudience(ownerTurn(cfg));
  expect(resolved.memoryAudience).toEqual({ kind: "owner-private", agentId: "main" });
  resolved.release();
  expect(fakeSessionOwner.activeLeases).toBe(0);
}

async function expectNone(cfg: OpenClawConfig) {
  const resolved = await resolveEmbeddedAttemptMemoryAudience(ownerTurn(cfg));
  expect(resolved.memoryAudience).toBeUndefined();
  // No audience means no lineage read and no lease.
  expect(fakeSessionOwner.workerReads).toEqual([]);
  expect(fakeSessionOwner.activeLeases).toBe(0);
}

beforeEach(() => {
  mocks.kind = undefined;
  fakeSessionOwner.reset();
});

afterEach(async () => {
  await clearActivePluginRegistry();
});

it("grants an audience under a native slot owner", async () => {
  mocks.kind = "native";
  await expectGranted(config());
});

it("resolves none under a legacy slot owner without a sidecar", async () => {
  mocks.kind = "legacy";
  loadPlugins(memoryCore);
  await expectNone(config());
});

it("grants an audience under a legacy slot owner beside a loaded memory sidecar", async () => {
  mocks.kind = "legacy";
  loadPlugins(memoryCore, hindsight);
  await expectGranted(config(true));
});

it("resolves none when the sidecar setting is off or the sidecar did not load", async () => {
  mocks.kind = "legacy";
  loadPlugins(memoryCore, hindsight);
  await expectNone(config(false));

  loadPlugins(memoryCore, { ...hindsight, status: "disabled" });
  await expectNone(config(true));
});

it("applies the same denials to a sidecar audience", async () => {
  mocks.kind = "legacy";
  loadPlugins(memoryCore, hindsight);
  const turn = ownerTurn(config(true));
  const resolved = await resolveEmbeddedAttemptMemoryAudience({
    ...turn,
    admission: { ...turn.admission, entry: { ...turn.admission.entry, chatType: undefined } },
  });
  expect(resolved.memoryAudience).toBeUndefined();
  expect(fakeSessionOwner.activeLeases).toBe(0);
});
