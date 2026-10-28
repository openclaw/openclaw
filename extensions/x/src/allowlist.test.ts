import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { openXAllowlist } from "./allowlist.js";
import { createKeyedState } from "./test-support/monitor.js";

it("retires publication authority when the account allowlist changes, not another account", async () => {
  const stateDir = `synthetic-x-publication:${randomUUID()}`;
  const runtime = {
    state: { openKeyedStore: createKeyedState(), resolveStateDir: () => stateDir },
  };
  const store = openXAllowlist(runtime);
  const { assertCurrent: current } = await store.readSnapshot("default");
  await store.remove("other", "123");
  expect(current).not.toThrow();
  await openXAllowlist(runtime).put("default", {
    userId: "123",
    username: "author",
    name: "Author",
    addedBy: "operator",
    addedAt: 1,
  });
  expect(current).toThrow("allowlist changed");
  const { assertCurrent: after } = await store.readSnapshot("default");
  expect(after).not.toThrow();
  await store.remove("default", "123");
  expect(after).toThrow("allowlist changed");
});
