import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import plugin from "./index.js";
import { sessionActions, storeFixture, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

// Drives the plugin's registered session actions over the real storage implementation.
async function fixture() {
  const { api, config } = await storeFixture(tempDirs.make("knowledge-workflows-"), {
    policy: { writesEnabled: true, operatorRead: true },
  });
  const actions = new Map<string, any>();
  plugin.register({
    ...api,
    registerTool() {},
    session: {
      ...api.session,
      controls: {
        ...api.session?.controls,
        ...sessionActions((action) => {
          actions.set(action.id, action);
        }).session.controls,
      },
    },
  });
  async function call(name: keyof typeof contract.operations, payload = {}) {
    expect(Check(contract.operations[name].input, payload), `${name} input`).toBeTruthy();
    const response = await actions
      .get(name)
      .handler({ payload, client: { connId: "workflow-trial", scopes: ["operator.write"] } });
    expect(response.ok, response.error).toBe(true);
    expect(Check(contract.operations[name].output, response.result), `${name} output`).toBeTruthy();
    return response.result;
  }
  return { call, vaultId: config.vaultId };
}
// Reads a settled call already asserted to have fulfilled.
const value = <T>(result: PromiseSettledResult<T>) => (result as PromiseFulfilledResult<T>).value;

it("concurrent service calls publish once, allow reads, and recover after a rejected edit", async () => {
  const f = await fixture();
  await f.call("status");
  const inputs = Array.from({ length: 4 }, (_, i) => ({
    requestId: randomUUID(),
    expectedVaultId: f.vaultId,
    title: `Concurrent person ${i}`,
    type: "person",
    body: `Person ${i}`,
  }));
  const results = await Promise.allSettled([
    ...inputs.map((input) => f.call("save_page", input)),
    f.call("records"),
    f.call("save_page", inputs[0]),
  ]);
  expect(results.filter((r) => r.status === "rejected").map((r) => r.reason.message)).toStrictEqual(
    [],
  );
  const receipts = results.slice(0, 4).map((r) => value(r));
  expect(value(results[5]!)).toStrictEqual(receipts[0]);
  expect((await f.call("records")).total).toBe(4);
  const current = receipts[0];
  const edit = {
    ...inputs[0],
    requestId: randomUUID(),
    id: current.id,
    expectedRevision: current.revision,
    expectedHash: current.hash,
    body: "Updated person",
  };
  await f.call("save_page", edit);
  const afterConflict = await Promise.allSettled([
    f.call("save_page", { ...edit, requestId: randomUUID(), body: "Stale draft" }),
    f.call("record", { id: current.id }),
    f.call("save_page", inputs[1]),
  ]);
  expect(afterConflict[0].status).toBe("rejected");
  expect((afterConflict[0] as PromiseRejectedResult).reason.message).toMatch(/Edit conflict/);
  expect(value(afterConflict[1]).record.body).toBe("Updated person");
  expect(value(afterConflict[2])).toStrictEqual(receipts[1]);
  expect((await f.call("records")).total).toBe(4);
});
