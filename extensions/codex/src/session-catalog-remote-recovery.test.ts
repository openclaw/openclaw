import { expect, it, vi } from "vitest";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  catalogRow,
  catalogWebSocketOptions,
  completeCatalogState,
} from "./session-catalog-index.test-support.js";

const row = (threadId: string) => catalogRow(threadId, 100, { name: threadId });

it("finishes reconnect hydration after an offline snapshot refresh and resumes periodic currency", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const startOptions = catalogWebSocketOptions("wss://catalog-recovery.example.test/codex");
  const original = createClientHarness();
  const replacement = createClientHarness();
  const state = completeCatalogState([row("saved")]);
  const offline = new Error("remote connection unavailable");
  const readNative = vi
    .fn()
    .mockRejectedValueOnce(offline)
    .mockResolvedValue({ rows: [row("reconnected")] });
  const index = new CodexCatalogIndex({
    homeId: await codexCatalogResidentHomeKey({ startOptions }),
    readNative,
    state,
    assertCurrent: () => {},
  });
  try {
    await observeCodexCatalogClient(original.client, { startOptions });
    await expect(index.initialize()).rejects.toBe(offline);
    original.client.close();
    await observeCodexCatalogClient(replacement.client, { startOptions });
    let settled = false;
    const recovering = index.initialize().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(settled).toBe(true));
    await recovering;
    expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual([
      "reconnected",
    ]);

    readNative.mockResolvedValue({ rows: [row("later")] });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual(["later"]);
    });
  } finally {
    await index.retire();
    original.client.close();
    replacement.client.close();
    vi.useRealTimers();
  }
});
