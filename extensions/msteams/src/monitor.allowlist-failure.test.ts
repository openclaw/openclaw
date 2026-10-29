import { afterEach, expect, it } from "vitest";
import {
  createConfig,
  createRuntime,
  createStores,
  updateMSTeamsConfig,
} from "./monitor-lifecycle.test-helpers.js";
import {
  createMSTeamsActivityHandler,
  resolveAllowlistMocks,
  routeState,
  resetMSTeamsMonitorMocks,
} from "./monitor-lifecycle.test-support.js";
import { monitorMSTeamsProvider } from "./monitor.js";
import { MSTEAMS_UNMATCHABLE_ALLOW_ENTRY } from "./resolve-allowlist.js";
afterEach(resetMSTeamsMonitorMocks);

it("keeps unresolved name-only allowlists configured so they do not fall back or widen", async () => {
  const cfg = createConfig();
  updateMSTeamsConfig(cfg, {
    dmPolicy: "open",
    allowFrom: ["*"],
    groupPolicy: "allowlist",
    groupAllowFrom: ["Bob Builder"],
    teams: { Engineering: {} },
  });
  resolveAllowlistMocks.resolveMSTeamsTeamsConfig.mockRejectedValueOnce(
    new Error("Graph unavailable"),
  );

  const abort = new AbortController();
  const task = monitorMSTeamsProvider({
    cfg,
    runtime: createRuntime(),
    abortSignal: abort.signal,
    ...createStores(),
  });
  await routeState.ready.promise;
  expect(createMSTeamsActivityHandler).toHaveBeenCalled();

  // The operator's stored configuration keeps its original entries; only the in-memory
  // projection handed to the handler carries the placeholder.
  expect(cfg.channels?.msteams?.groupAllowFrom).toEqual(["Bob Builder"]);
  expect(cfg.channels?.msteams?.teams).toEqual({ Engineering: {} });

  const registered = createMSTeamsActivityHandler.mock.calls[0]?.[0].cfg.channels?.msteams;
  expect(registered?.groupAllowFrom).toEqual([MSTEAMS_UNMATCHABLE_ALLOW_ENTRY]);
  expect(Object.keys(registered?.teams ?? {})).toHaveLength(1);
  expect(Object.keys(registered?.teams ?? {})).not.toContain("*");
  abort.abort();
  await task;
});
