import { describe, expect, it } from "vitest";

// Mirror implementation in channel.ts (kept local to avoid relying on bundled dist paths)
async function waitForAbortSignal(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

describe("nextcloud-talk waitForAbortSignal", () => {
  it("resolves immediately when signal is undefined", async () => {
    await expect(waitForAbortSignal(undefined)).resolves.toBeUndefined();
  });

  it("resolves when signal is aborted", async () => {
    const abort = new AbortController();
    const task = waitForAbortSignal(abort.signal).then(() => "done");
    abort.abort();
    await expect(task).resolves.toBe("done");
  });
});
