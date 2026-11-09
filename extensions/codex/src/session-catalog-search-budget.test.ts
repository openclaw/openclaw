import { expect, it } from "vitest";
import { catalogFactory, nativeCatalogFixture } from "./session-catalog-resident.test-support.js";
import { listVisiblePage } from "./session-catalog-visible-page.js";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControl,
  pinnedConnectionMocks,
} from "./session-catalog.test-helpers.js";

it("captures each query before asynchronous pinned setup without rediscovering native rows", async () => {
  const native = nativeCatalogFixture(6);
  for (const [index, row] of native.rows.entries()) {
    row.name = index % 2 === 0 ? "Wanted" : "Other";
  }
  const control = createCodexSessionCatalogControl({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => config,
  });
  await control.withPinnedConnection(async (active) => {
    const query = { limit: 1, searchTerm: "Wanted" };
    for (const [step, positions] of [[0], [1, 3], [0, 2, 4]].entries()) {
      const reading = active.listPage(query);
      Object.assign(query, { limit: step + 2, searchTerm: step === 0 ? "Other" : "Wanted" });
      const page = await reading;
      expect(page.sessions.map(({ threadId }) => threadId)).toEqual(
        positions.map((i) => native.rows[i]!.id),
      );
      expect(page.nextCursor).toEqual(step < 2 ? expect.any(String) : undefined);
      if (step === 0) {
        await active.initialize();
        expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
        commandRpcMocks.codexControlRequest.mockClear();
      }
    }
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    expect(pinnedConnectionMocks.request).not.toHaveBeenCalled();
  });
});

it("bounds resident exclusion filling and continues without skipping the later visible match", async () => {
  const matching = Array.from({ length: 21 }, (_, index) => index * 64 + 1);
  const { rows } = nativeCatalogFixture(21 * 64);
  rows.forEach((row, index) => {
    row.name = matching.includes(index + 1) ? "Wanted" : "Other";
  });
  const control = catalogFactory({ getRuntimeConfig: () => config }).forRequest("main");
  await control.initialize();
  commandRpcMocks.codexControlRequest.mockClear();
  const list = (cursor?: string) =>
    listVisiblePage({
      control,
      cursor,
      searchTerm: "Wanted",
      limit: 1,
      excludedThreadIds: new Set(matching.slice(0, 20).map((position) => rows[position - 1]!.id)),
    });
  const first = await list();
  expect(first.sessions).toEqual([]);
  const cursor = first.nextCursor;
  expect(cursor).toBeTypeOf("string");
  expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  const second = await list(cursor);
  expect(second.sessions.map((session) => session.threadId)).toEqual([rows[1280]!.id]);
  expect(second.nextCursor).toBeUndefined();
  expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
});
