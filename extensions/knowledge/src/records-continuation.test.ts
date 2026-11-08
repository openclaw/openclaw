import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureInput, FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import plugin from "./index.js";
import { sessionActions, storeFixture, toolContext, useTestTempDirs } from "./test-support.js";

const dirs = useTestTempDirs();
const MATCHING_RECORDS = 502;
const query = "Lantern inventory";
const id = (index: number) => `project_lantern_${String(index).padStart(3, "0")}`;

type RecordsInput = FeatureInput<typeof contract, "records">;
type RecordsOutput = FeatureOutput<typeof contract, "records">;

/** Register the production tool against an isolated store with 502 matching pages. */
async function fixture() {
  const factories = new Map<string, OpenClawPluginToolFactory>();
  const f = await storeFixture(dirs.make("records-continuation-"), {
    extra: {
      ...sessionActions(),
      registerTool(factory: OpenClawPluginToolFactory, options: { name: string }) {
        if (typeof factory === "function" && options?.name) {
          factories.set(options.name, factory);
        }
      },
    },
  });
  const directory = path.join(f.root, "private", "projects");
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < MATCHING_RECORDS; index += 1) {
    const metadata = {
      format: "knowledge-record-v1",
      id: id(index),
      revision: 1,
      kind: "page",
      title: `${query} ${String(index).padStart(3, "0")}`,
      scope: { visibility: "private" },
      recorded_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      lifecycle: "active",
      type: "project",
      fields: { status: "active" },
    };
    await writeFile(
      path.join(directory, `${id(index)}.md`),
      ["---", JSON.stringify(metadata), "---", "Synthetic inventory page.", ""].join("\n"),
    );
  }
  plugin.register(f.api);
  const context = toolContext(f.api).tool;
  const tool = factories.get("knowledge_records")?.(context);
  if (!tool || Array.isArray(tool)) {
    throw new Error("Missing registered knowledge_records tool");
  }
  return async (input: RecordsInput): Promise<RecordsOutput> => {
    const result = await tool.execute(randomUUID(), input);
    const value: unknown = result.details;
    if (!Check(contract.operations.records.output, value)) {
      throw new Error("Invalid knowledge_records output");
    }
    return value as RecordsOutput;
  };
}

it("registered records pagination accepts its own continuation past offset 500", async () => {
  const call = await fixture();
  const filters = { kind: "page" as const, query, limit: 1 };

  const boundary = await call({ ...filters, offset: 500 });
  expect(boundary.total).toBe(MATCHING_RECORDS);
  expect(boundary.records.map((record) => record.id)).toEqual([id(500)]);
  expect(boundary.nextOffset).toBe(501);

  const continuation = await call({ ...filters, offset: boundary.nextOffset! });
  expect(continuation.records.map((record) => record.id)).toEqual([id(501)]);
  expect(continuation.nextOffset).toBe(null);
});
