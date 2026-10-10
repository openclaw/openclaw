// Memory Wiki CLI tests cover UTF-8 refusal output for whole-page rewrites.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWikiCli } from "./cli.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();
let suiteRoot = "";
let caseIndex = 0;
let stdoutWriteMock: ReturnType<typeof vi.fn>;

function malformedPage(header: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${header}\n\nlatin1: caf`, "utf8"),
    Buffer.from([0xff]),
    Buffer.from(" keeps dropping\n", "utf8"),
  ]);
}

const ENTITY_HEADER =
  "---\npageType: entity\nid: entity.router\ntitle: Router\nstatus: active\n---\n# Router\n\n## Human Notes";
const REPORT_HEADER =
  "---\npageType: report\nid: report.lint\ntitle: Lint Report\nstatus: active\n---\n# Lint Report";

describe("memory-wiki cli UTF-8 refusals", () => {
  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-cli-utf8-suite-"));
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    stdoutWriteMock = vi.fn(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(
      stdoutWriteMock as unknown as typeof process.stdout.write,
    );
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function createCliVault() {
    return createVault({
      prefix: "memory-wiki-cli-utf8-",
      rootDir: path.join(suiteRoot, `case-${caseIndex++}`),
      initialize: true,
    });
  }

  function parseWiki(config: ResolvedMemoryWikiConfig, args: string[]) {
    const program = new Command();
    program.name("test");
    registerWikiCli(program, { config });
    return program.parseAsync(["wiki", ...args], { from: "user" });
  }

  it("prints the compile refusal and leaves the malformed page unchanged", async () => {
    const { rootDir, config } = await createCliVault();
    const entityDir = path.join(rootDir, "entities");
    await fs.mkdir(entityDir, { recursive: true });
    const entityPath = path.join(entityDir, "router.md");
    const malformed = malformedPage(ENTITY_HEADER);
    await fs.writeFile(entityPath, malformed);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await parseWiki(config, ["compile"]);

    const stderr = consoleError.mock.calls.map(([chunk]) => String(chunk)).join("\n");
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain("Wiki page is not valid UTF-8 and cannot be rewritten safely");
    expect(stderr).toContain(path.join("entities", "router.md"));
    expect(stderr).toContain("The file was left unchanged.");
    expect(await fs.readFile(entityPath)).toEqual(malformed);
  });

  it("prints the lint refusal and leaves the malformed report unchanged", async () => {
    const { rootDir, config } = await createCliVault();
    const reportsDir = path.join(rootDir, "reports");
    await fs.mkdir(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, "lint.md");
    const malformed = malformedPage(REPORT_HEADER);
    await fs.writeFile(reportPath, malformed);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await parseWiki(config, ["lint"]);

    const stderr = consoleError.mock.calls.map(([chunk]) => String(chunk)).join("\n");
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain("Wiki page is not valid UTF-8 and cannot be rewritten safely");
    expect(stderr).toContain(path.join("reports", "lint.md"));
    expect(stderr).toContain("The file was left unchanged.");
    expect(await fs.readFile(reportPath)).toEqual(malformed);
  });

  it("rethrows the refusal in JSON mode for the shared machine envelope", async () => {
    const { rootDir, config } = await createCliVault();
    const entityDir = path.join(rootDir, "entities");
    await fs.mkdir(entityDir, { recursive: true });
    await fs.writeFile(path.join(entityDir, "router.md"), malformedPage(ENTITY_HEADER));

    await expect(parseWiki(config, ["compile", "--json"])).rejects.toMatchObject({
      name: "WikiPageNotUtf8Error",
    });
  });
});
