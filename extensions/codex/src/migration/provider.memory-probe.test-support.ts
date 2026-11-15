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

  // chmod(0o000) only denies traversal on non-root POSIX; Windows has no such
  // permission model and POSIX root can still traverse, so lstat would succeed
  // and the item would be planned, making the "error" assertion wrong despite
  // correct production behavior. Gate the EACCES case off those environments.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps other Codex migration items when memory probing fails with EACCES",
    async () => {
      const fixture = await createCodexFixture();
      await writeFile(path.join(fixture.codexHome, "memories", "MEMORY.md"), "# Memory\n");
      await fs.chmod(path.join(fixture.codexHome, "memories"), 0o000);
      try {
        const plan = await buildCodexMigrationProvider().plan(params.contextFor(fixture));
        expect(findItem(plan.items, "memory:codex:MEMORY.md")).toMatchObject({
          status: "error",
          reason: expect.stringContaining("EACCES"),
        });
        expect(plan.items.some((item) => item.kind === "skill")).toBe(true);
      } finally {
        await fs.chmod(path.join(fixture.codexHome, "memories"), 0o755).catch(() => undefined);
      }
    },
  );

  it("keeps other Codex migration items when memory probing fails with ENOTDIR", async () => {
    const fixture = await createCodexFixture();
    await fs.writeFile(path.join(fixture.codexHome, "memories"), "leftover", "utf8");
    const plan = await buildCodexMigrationProvider().plan(params.contextFor(fixture));
    expect(findItem(plan.items, "memory:codex:MEMORY.md")).toMatchObject({
      status: "error",
      reason: expect.stringContaining("ENOTDIR"),
    });
    expect(plan.items.some((item) => item.kind === "skill")).toBe(true);
  });
}
