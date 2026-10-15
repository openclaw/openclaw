import { afterEach, describe, expect, it, vi } from "vitest";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import { createConfig, createRuntime, createStores } from "./monitor-lifecycle.test-helpers.js";
import {
  createMSTeamsActivityHandler,
  loadMSTeamsSdkWithAuth,
  resetMSTeamsMonitorMocks,
  routeState,
} from "./monitor-lifecycle.test-support.js";
import { monitorMSTeamsProvider } from "./monitor.js";

function runProvider(abort: AbortController) {
  return monitorMSTeamsProvider({
    cfg: createConfig(),
    runtime: createRuntime(),
    abortSignal: abort.signal,
    ...createStores(),
  });
}

async function resolveSdkApp() {
  const result = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
  if (!result) {
    throw new Error("expected loadMSTeamsSdkWithAuth result");
  }
  return (await result).app;
}

describe("Microsoft Teams removal transport", () => {
  afterEach(resetMSTeamsMonitorMocks);

  it.each([
    { type: "installationUpdate", action: "remove" },
    { type: "conversationUpdate", membersRemoved: [{ id: "bot-id" }] },
  ])("requires durable admission before acknowledging $type removal", async (removal) => {
    const abort = new AbortController();
    const task = runProvider(abort);
    try {
      await routeState.ready.promise;
      const app = await resolveSdkApp();
      const activityHandler = app.on.mock.calls.find(
        (call: [string, unknown]) => call[0] === "activity",
      )?.[1];
      const ingress = getMSTeamsIngressMockState().instances[0];
      const run = createMSTeamsActivityHandler.mock.results[0]?.value;
      if (typeof activityHandler !== "function" || !ingress || !run) {
        throw new Error("expected Teams activity transport and ingress");
      }
      const activity = {
        id: "removal-event",
        ...removal,
        recipient: { id: "bot-id" },
        conversation: { id: "personal-conversation", conversationType: "personal" },
      };
      const appendFailure = new Error("synthetic removal journal unavailable");
      ingress.accept.mockRejectedValueOnce(appendFailure);
      await expect(activityHandler({ activity, send: vi.fn() })).rejects.toBe(appendFailure);
      expect(run).not.toHaveBeenCalled();

      await activityHandler({ activity, send: vi.fn() });
      expect(ingress.accept).toHaveBeenCalledWith(activity, expect.objectContaining({ activity }));
      expect(run).toHaveBeenCalledOnce();
    } finally {
      abort.abort();
      await task;
    }
  });
});
