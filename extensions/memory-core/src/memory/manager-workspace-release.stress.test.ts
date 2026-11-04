import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it } from "vitest";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";

it("settles accepted child writes before a failed owner releases the next writer", async () => {
  const workspace = "/memory-workspace-test/failed-owner";
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const events: string[] = [];
  const failure = new Error("owner failed after accepting a child write");
  let child: Promise<void> | undefined;
  const owner = withMemoryWorkspaceLock(workspace, async () => {
    child = withMemoryWorkspaceLock(workspace, async () => {
      entered.resolve();
      await release.promise;
      events.push("child committed");
    });
    await entered.promise;
    throw failure;
  }).catch((error: unknown) => {
    return error;
  });
  await entered.promise;
  const next = withMemoryWorkspaceLock(workspace, async () => {
    events.push("next writer");
  });
  try {
    release.resolve();
    expect(await owner).toBe(failure);
    await next;
    expect(events).toEqual(["child committed", "next writer"]);
  } finally {
    release.resolve();
    await Promise.allSettled([owner, next, child]);
  }
});
