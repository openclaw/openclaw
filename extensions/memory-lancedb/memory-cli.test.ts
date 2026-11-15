import { tableFromArrays } from "apache-arrow";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryCliHarness as createHarness } from "./memory-cli.test-support.js";

vi.mock("openclaw/plugin-sdk/cli-state-owner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/cli-state-owner")>();
  return {
    ...actual,
    runWithLocalStateOwner: vi.fn((params: Parameters<typeof actual.runWithLocalStateOwner>[0]) =>
      params.runLocal({
        env: {},
        config: {},
        signal: new AbortController().signal,
        assertCurrent: () => {},
      }),
    ),
  };
});

let stdout = "";
let harness: ReturnType<typeof createHarness>;
beforeEach(() => {
  harness = createHarness();
  stdout = "";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

it("optimizes the whole table offline and closes it after reporting counts", async () => {
  const { runWithLocalStateOwner } = await import("openclaw/plugin-sdk/cli-state-owner");
  await harness.run("optimize");
  await expect(harness.run("optimize", "--agent", "private")).rejects.toMatchObject({
    code: "commander.unknownOption",
  });

  expect(runWithLocalStateOwner).toHaveBeenCalledWith(
    expect.objectContaining({ onForeignOwner: "refuse" }),
  );
  expect(console.log).toHaveBeenCalledWith("Fragments: 6 -> 1");
  expect(console.log).toHaveBeenCalledWith("Rows: 6 -> 6");
  expect(harness.dbClose).toHaveBeenCalledOnce();
});

it("embeds a CLI search with the explicitly requested agent's authentication", async () => {
  await harness.run("search", "private account memory", "--agent", "private");

  expect(harness.embed).toHaveBeenCalledWith(
    "private",
    "private account memory",
    expect.any(Object),
  );
  expect(harness.search).toHaveBeenCalledWith("private", [0.1, 0.2], 5, 0.3);
  expect(harness.close).toHaveBeenCalledTimes(1);
});

it("rejects an invalid limit before generating an embedding", async () => {
  await expect(harness.run("search", "hello", "--limit", "5items")).rejects.toThrow(
    "--limit must be a positive integer",
  );

  expect(harness.embed).not.toHaveBeenCalled();
});

it("preserves a falsy search rejection over cleanup failure", async () => {
  harness = createHarness({ embedError: null, closeError: new Error("close failed") });
  await expect(harness.run("search", "hello")).rejects.toBeNull();
  expect(harness.close).toHaveBeenCalledTimes(1);
});
it.each([
  { order: "createdAt:asc", ids: ["first", "second"] },
  { order: "createdAt:desc", ids: ["third", "second"] },
])("projects columns ordered by $order without mutating Arrow rows", async ({ order, ids }) => {
  const table = tableFromArrays({
    id: ["third", "first", "second"],
    text: ["third memory", "first memory", "second memory"],
    createdAt: [30, 10, 20],
  });
  const originalRows = table.toArray().map((row) => row.toJSON());
  harness = createHarness({ queryRows: table.toArray() });
  await harness.run("query", "--cols", "id,text", "--order-by", order, "--limit", "2");

  const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
  expect(rows).toEqual(ids.map((id) => ({ id, text: `${id} memory` })));
  expect(table.toArray().map((row) => row.toJSON())).toEqual(originalRows);
  expect(harness.embed).not.toHaveBeenCalled();
});
it.each([
  ["category", "=", "preference"],
  ["importance", ">=", 0.8],
])("passes a typed query filter to storage: %s", async (column, operator, value) => {
  const input = `${column} ${operator} ${typeof value === "string" ? `'${value}'` : value}`;
  await harness.run("query", "--filter", input);
  expect(harness.query).toHaveBeenCalledWith(
    "main",
    expect.objectContaining({ filter: { column, operator, value } }),
  );
});

it.each(["agentId = 'beta'", "category = 'preference' OR agentId = 'beta'", "importance = 'high'"])(
  "rejects a filter before storage access: %s",
  async (filter) => {
    await expect(harness.run("query", "--filter", filter)).rejects.toThrow();
    expect(harness.query).not.toHaveBeenCalled();
  },
);
