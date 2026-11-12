import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { buildCodexMigrationProvider } from "./provider.js";
import { createCodexFixture, findItem, makeContext, writeFile } from "./provider.test-support.js";

type CodexFixture = Awaited<ReturnType<typeof createCodexFixture>>;

export function registerCodexMemoryProbeTests(params: {
  contextFor: (
    fixture: CodexFixture,
    options?: Partial<Parameters<typeof makeContext>[0]>,
  ) => MigrationProviderContext;
}): void {
  it("rejects non-file Codex consolidated memory candidates", async () => {
    const fixture = await createCodexFixture();
    await fs.mkdir(path.join(fixture.codexHome, "memories", "MEMORY.md"), { recursive: true });

    await expect(
      buildCodexMigrationProvider().plan(params.contextFor(fixture, { itemKinds: ["memory"] })),
    ).rejects.toThrow("must be a regular file");
  });

  it.each([
    {
      label: "EACCES",
      prepare: async (codexHome: string) => {
        await writeFile(path.join(codexHome, "memories", "MEMORY.md"), "# Memory\n");
        await fs.chmod(path.join(codexHome, "memories"), 0o000);
      },
    },
    {
      label: "ENOTDIR",
      prepare: (codexHome: string) =>
        fs.writeFile(path.join(codexHome, "memories"), "leftover", "utf8"),
    },
  ])(
    "keeps other Codex migration items when memory probing fails with $label",
    async ({ label, prepare }) => {
      const fixture = await createCodexFixture();
      await prepare(fixture.codexHome);
      try {
        const plan = await buildCodexMigrationProvider().plan(params.contextFor(fixture));
        expect(findItem(plan.items, "memory:codex:MEMORY.md")).toMatchObject({
          status: "error",
          reason: expect.stringContaining(label),
        });
        expect(plan.items.some((item) => item.kind === "skill")).toBe(true);
      } finally {
        await fs.chmod(path.join(fixture.codexHome, "memories"), 0o755).catch(() => undefined);
      }
    },
  );
}
