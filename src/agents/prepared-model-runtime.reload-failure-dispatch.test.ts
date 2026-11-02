// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadPublishedGatewayReplyDispatchRuntime as loadDispatch,
  refreshPreparedModelRuntimeSnapshots as refreshRuntime,
} from "./prepared-model-runtime.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";
import { PreparedReplyDispatchPublicationOwner } from "./prepared-reply-dispatch-runtime.js";

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const { createMockSubsystemLogger } = await import("../../test/helpers/mock-subsystem-logger.js");
  return {
    ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
    createSubsystemLogger: (subsystem: string) =>
      createMockSubsystemLogger(subsystem, {
        warn: (...args: unknown[]) => getPreparedModelRuntimeMocks().warn(...args),
      }),
  };
});

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-model-runtime" });
const { mocks } = fixture;
const dispatch = (agentId = "default") => loadDispatch({ agentId });
const refresh = (config: OpenClawConfig = {}) => refreshRuntime(config, { gatewayLifecycle: true });

describe("prepared model runtime dispatch after a failed publication", () => {
  it("keeps the publication buildable when one owner is not published", () => {
    const publication = new PreparedReplyDispatchPublicationOwner({
      retainOwner: () => {
        throw new Error("not used");
      },
      isGatewayLifecycleActive: () => true,
      getConfiguredOwner: () => undefined,
      getPendingReplacement: () => undefined,
      isStartupPending: () => false,
      ensureReady: async () => {},
    });
    const unpublished = {
      input: { agentId: "stale", agentDir: "/synthetic/agents/stale", config: {} },
      provenance: "configured",
      needsRefresh: true,
    } as unknown as PreparedModelRuntimeOwner;

    // One unpublished owner may not take the whole publication down with it.
    expect(() => publication.rebuild([unpublished])).not.toThrow();
  });

  it("republishes a failed reload's owner on the next inbound dispatch", async () => {
    mocks.configuredAgentIds = ["default"];
    await refresh();
    const failure = new Error("prepared model runtime publication failed");
    mocks.resolveAmbientCredentials.mockRejectedValueOnce(failure);

    await expect(refresh()).rejects.toThrow(failure.message);

    // The failed publication left the owner unpublished; the next dispatch publishes it
    // again instead of rejecting the request.
    await expect(dispatch()).resolves.toMatchObject({ agentId: "default" });
  });
});
