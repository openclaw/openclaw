import { expect, it } from "vitest";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { makeBrowserProfile } from "./server-context.test-harness.js";
import type { BrowserTab } from "./server-context.types.js";
import { markBrowserTargetCrashed } from "./target-crash.js";

const tab = (targetId: string): BrowserTab => ({
  targetId,
  title: targetId,
  url: "about:blank",
  wsUrl: `ws://127.0.0.1/devtools/page/${targetId}`,
  type: "page",
});

function selection(cdpUrl: string, tabs: BrowserTab[], lastTargetId: string | null = null) {
  const profile = makeBrowserProfile({ cdpUrl });
  return createProfileSelectionOps({
    profile,
    runtime: { profile, running: null, lastTargetId },
    getCdpControlPolicy: () => undefined,
    listTabs: async () => tabs,
    openTab: async () => tabs[0] ?? tab("OPENED"),
  });
}

it("prefers a healthy tab over a crash-observed target for implicit selection", async () => {
  const ops = selection("http://127.0.0.1:19104", [tab("CRASHED"), tab("HEALTHY")]);
  markBrowserTargetCrashed("http://127.0.0.1:19104", "CRASHED");

  await expect(ops.ensureTabAvailable(undefined)).resolves.toMatchObject({
    targetId: "HEALTHY",
  });
});

it("still resolves an explicit crash-observed target to its own error path", async () => {
  const ops = selection("http://127.0.0.1:19105", [tab("CRASHED"), tab("HEALTHY")]);
  markBrowserTargetCrashed("http://127.0.0.1:19105", "CRASHED");

  await expect(ops.ensureTabAvailable("CRASHED")).resolves.toMatchObject({
    targetId: "CRASHED",
  });
});

it("keeps the sticky crash-observed target so its own error surfaces", async () => {
  const ops = selection("http://127.0.0.1:19106", [tab("CRASHED"), tab("HEALTHY")], "CRASHED");
  markBrowserTargetCrashed("http://127.0.0.1:19106", "CRASHED");

  await expect(ops.ensureTabAvailable(undefined)).resolves.toMatchObject({
    targetId: "CRASHED",
  });
});
