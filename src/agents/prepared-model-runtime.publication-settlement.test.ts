// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import { publishModelRuntimeSnapshot } from "./prepared-model-runtime.owner.js";
import * as pluginLifetime from "./prepared-model-runtime.plugin-lifetime.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-publication-settlement" });

it("preserves the primary publication error when terminal generation cleanup also fails", async () => {
  const primary = new Error("plugin generation retired before publication");
  const cleanup = new Error("registration cleanup failed");
  let failedOwner: PreparedModelRuntimeOwner | undefined;
  const publish = vi
    .spyOn(pluginLifetime, "publishPreparedPluginGeneration")
    .mockImplementationOnce((owner) => {
      failedOwner = owner;
      throw primary;
    });
  const discardGeneration = pluginLifetime.discardPreparedPluginGeneration;
  const discard = vi
    .spyOn(pluginLifetime, "discardPreparedPluginGeneration")
    .mockImplementationOnce(async (generation) => {
      await discardGeneration(generation);
      throw cleanup;
    });
  try {
    const failure = await publishModelRuntimeSnapshot(
      {
        config: {},
        agentDir: fixture.state.agentDir("main"),
        workspaceDir: fixture.state.workspaceDir,
      },
      new Map(),
      new Map(),
      30_000,
      undefined,
      "explicit",
      "static",
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SuppressedError);
    expect(failure).toMatchObject({ error: cleanup, suppressed: primary });
    expect(failedOwner?.refreshError).toBe(primary);
    expect(failedOwner?.pending).toBeUndefined();
  } finally {
    publish.mockRestore();
    discard.mockRestore();
  }
});
