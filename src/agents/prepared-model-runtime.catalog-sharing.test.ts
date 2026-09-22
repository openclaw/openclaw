// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as cryptoDigest from "../infra/crypto-digest.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-catalog-sharing" });
  await resetPreparedModelRuntimeHarness(state);
});

afterEach(async ({ task }) => {
  vi.restoreAllMocks();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

async function publishedNativeSource(input: PreparedModelRuntimeInput): Promise<string> {
  const snapshot = await publishPreparedModelRuntimeSnapshot(input, {
    catalogMode: "static",
    force: true,
  });
  await snapshot.loadFullModelCatalog!({ refresh: true });
  const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
  expect(owner?.catalogInventory?.nativeSource).toEqual(expect.any(String));
  return owner!.catalogInventory!.nativeSource;
}

describe("prepared catalog source sharing", () => {
  it("keeps full-roster digest work constant as the fleet grows", async () => {
    const marker = "synthetic-roster-hash-boundary";
    const digests = vi.spyOn(cryptoDigest, "sha256Base64Url");
    const counts: number[] = [];
    for (const size of [8, 16]) {
      mocks.configuredAgentIds = Array.from({ length: size }, (_, index) => `agent-${index}`);
      const config: OpenClawConfig = {
        agents: {
          entries: Object.fromEntries(mocks.configuredAgentIds.map((id) => [id, { name: marker }])),
        },
      };
      digests.mockClear();
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      counts.push(
        digests.mock.calls.filter(([value]) => typeof value === "string" && value.includes(marker))
          .length,
      );
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
  });

  it("refreshes native source facts for mutable roster and plugin changes", async () => {
    const config: OpenClawConfig = {
      agents: { entries: { selected: {}, sibling: { name: "before" } } },
      plugins: { entries: { fixture: { config: { revision: 1 } } } },
    };
    const input = { config, agentId: "selected", agentDir: state.agentDir("selected") };
    const first = await publishedNativeSource(input);
    config.logging = { level: "debug" };
    expect(await publishedNativeSource(input)).toBe(first);
    config.agents!.entries!.sibling!.name = "after";
    const rosterChanged = await publishedNativeSource(input);
    expect(rosterChanged).not.toBe(first);
    config.plugins!.entries!.fixture!.config = { revision: 2 };
    expect(await publishedNativeSource(input)).not.toBe(rosterChanged);
  });

  it("keeps configured refs and runtime selections agent-specific", async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: { first: { model: "custom/first" }, second: { model: "custom/second" } },
      },
    };
    const input = { config, agentId: "first", agentDir: state.agentDir("first") };
    const first = await publishedNativeSource(input);
    expect(
      await publishedNativeSource({
        ...input,
        agentId: "second",
        agentDir: state.agentDir("second"),
      }),
    ).not.toBe(first);
    expect(
      await publishedNativeSource({
        ...input,
        runtimePluginSelections: [{ provider: "custom", modelId: "selected" }],
      }),
    ).not.toBe(first);
  });
});
