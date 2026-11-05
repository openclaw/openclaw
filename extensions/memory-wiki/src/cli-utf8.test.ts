// This owner propagates UTF-8 refusals and preserves bytes; the shared CLI owns
// rendering, JSON envelopes, and exit codes (#168850, toPluginCommandFailure).
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerWikiCli } from "./cli.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault: createTestVault, createTempDir } = createMemoryWikiTestHarness();
const createCliVault = () => createTestVault({ initialize: true });

function malformedPage(header: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${header}\n\nlatin1: caf`, "utf8"),
    Buffer.from([0xff]),
    Buffer.from(" keeps dropping\n", "utf8"),
  ]);
}

const ENTITY_HEADER =
  "---\npageType: entity\nid: entity.router\ntitle: Router\nstatus: active\n---\n" +
  "# Router\n\n## Human Notes";
const REPORT_HEADER =
  "---\npageType: report\nid: report.lint\ntitle: Lint Report\nstatus: active\n---\n# Lint Report";

/** Compile reports a vault-relative path, lint reports its absolute report path. */
async function expectRefusal(run: Promise<unknown>, displayPathFragment: string): Promise<void> {
  const refusal = await run.then(
    () => {
      throw new Error("expected the UTF-8 refusal to escape the wiki action");
    },
    (error: unknown) => error,
  );
  if (!(refusal instanceof Error)) {
    throw new Error(`expected an Error refusal, received ${String(refusal)}`);
  }
  expect(refusal.name).toBe("WikiPageNotUtf8Error");
  expect(refusal.message).toContain("cannot be rewritten safely");
  expect(refusal.message).toContain(displayPathFragment);
  expect(refusal.message).toContain("The file was left unchanged.");
}

async function writeMalformed(rootDir: string, report = false) {
  const relativePath = report ? "reports/lint.md" : "entities/router.md";
  const header = report ? REPORT_HEADER : ENTITY_HEADER;
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const malformed = malformedPage(header);
  await fs.writeFile(filePath, malformed);
  return { filePath, malformed };
}

describe("memory-wiki cli UTF-8 refusals", () => {
  function parseWiki(config: ResolvedMemoryWikiConfig, args: string[]) {
    const program = new Command();
    program.name("test");
    registerWikiCli(program, { config });
    return program.parseAsync(["wiki", ...args], { from: "user" });
  }

  it.each([
    { command: "compile", report: false, json: false },
    { command: "lint", report: true, json: false },
    { command: "compile", report: false, json: true },
  ])(
    "preserves the refusal and bytes for $command (json: $json)",
    async ({ command, report, json }) => {
      const { rootDir, config } = await createCliVault();
      const { filePath, malformed } = await writeMalformed(rootDir, report);
      const args = json ? [command, "--json"] : [command];
      await expectRefusal(
        parseWiki(config, args),
        report ? path.join("reports", "lint.md") : "entities/router.md",
      );
      expect(await fs.readFile(filePath)).toEqual(malformed);
    },
  );

  it("surfaces the refusal when another action compiles the vault", async () => {
    const { rootDir, config } = await createCliVault();
    const { filePath: entityPath, malformed } = await writeMalformed(rootDir);
    const notePath = path.join(await createTempDir("memory-wiki-note-"), "ingest-note.md");
    await fs.writeFile(notePath, "# Alpha\n\nLocal note.\n");

    await expectRefusal(parseWiki(config, ["ingest", notePath]), "entities/router.md");
    expect(await fs.readFile(entityPath)).toEqual(malformed);

    await expectRefusal(parseWiki(config, ["ingest", notePath, "--json"]), "entities/router.md");
  });
});
