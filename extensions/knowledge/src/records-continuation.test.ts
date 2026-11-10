import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import type { contract } from "./contract.js";
import plugin from "./index.js";
import { sessionActions, storeFixture, toolContext, useTestTempDirs } from "./test-support.js";

const dirs = useTestTempDirs();

it("registered inventory follows every returned offset through a large filtered store", async () => {
  const factories = new Map<string, OpenClawPluginToolFactory>();
  const f = await storeFixture(dirs.make("records-continuation-"), {
    extra: {
      ...sessionActions(),
      registerTool(factory: OpenClawPluginToolFactory, options: { name: string }) {
        factories.set(options.name, factory);
      },
    },
  });
  // Physical fictional records exercise native storage and the registered input
  // validator; the smaller budget tests deliberately exercise the vault directly.
  const directory = path.join(f.root, "private", "projects");
  await mkdir(directory, { recursive: true });
  const ids = Array.from(
    { length: 552 },
    (_, i) => `project_inventory_${String(i).padStart(3, "0")}`,
  );
  const files = new Map<string, string>();
  for (const id of [...ids, "project_unrelated"]) {
    const metadata = {
      format: "knowledge-record-v1",
      id,
      revision: 1,
      kind: "page",
      title: id === "project_unrelated" ? "Unrelated control" : `Inventory ${id}`,
      scope: { visibility: "private" },
      recorded_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      lifecycle: "active",
      type: "project",
      fields: { status: "active" },
    };
    const file = path.join(directory, `${id}.md`);
    const text = `---\n${JSON.stringify(metadata)}\n---\nFictional inventory record.\n`;
    files.set(file, text);
    await writeFile(file, text);
  }
  plugin.register(f.api);
  const tool = factories.get("knowledge_records")?.(toolContext(f.api).tool);
  if (!tool || Array.isArray(tool)) {
    throw new Error("Expected registered records tool");
  }
  const call = async (input: { query: string; limit: number; offset?: number }) =>
    (await tool.execute(randomUUID(), input)).details as FeatureOutput<
      typeof contract,
      "records_detail"
    >;
  const control = await call({ query: "Unrelated control", limit: 50 });
  expect(control.records.map((r) => r.id)).toEqual(["project_unrelated"]);
  expect(control.total).toBe(1);
  // Agent listings name a next offset only while more remain.
  expect(control.nextOffset).toBeUndefined();
  const seen: string[] = [];
  let offset: number | undefined = 0;
  do {
    const page = await call({ query: "Inventory", limit: 50, offset });
    expect(page.total).toBe(ids.length);
    expect(page.records.length).toBeGreaterThan(0);
    expect(page.records.length).toBeLessThanOrEqual(50);
    seen.push(...page.records.map((r) => r.id));
    expect(page.nextOffset).toBe(seen.length < ids.length ? seen.length : undefined);
    offset = page.nextOffset ?? undefined;
  } while (offset !== undefined);
  expect(seen).toEqual(ids);
  for (const [file, text] of files) {
    expect(await readFile(file, "utf8")).toBe(text);
  }
});
