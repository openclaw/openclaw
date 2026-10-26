import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { createRepositoryMatrixFixture } from "../../../scripts/lib/code-mode-matrix-repository-tasks.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixedMoney = `export function parseAmountCents(amount) {
  if (!/^-?\\d+\\.\\d{2}$/.test(amount)) throw new Error("Invalid amount");
  const negative = amount.startsWith("-");
  const [whole, fraction] = (negative ? amount.slice(1) : amount).split(".");
  return (Number(whole) * 100 + Number(fraction)) * (negative ? -1 : 1);
}
`;

it("grades real CLI repairs, rejects partial fixes and copied artifacts, and preserves original tests", async () => {
  const fixture = createRepositoryMatrixFixture("repo-invoice-repair", 3);
  const repeated = createRepositoryMatrixFixture("repo-invoice-repair", 3);
  expect(repeated.prompt).toBe(fixture.prompt);
  expect(repeated.workspaceFiles).toEqual(fixture.workspaceFiles);
  expect(createRepositoryMatrixFixture("repo-invoice-repair", 4).workspaceFiles).not.toEqual(
    fixture.workspaceFiles,
  );
  const files = fixture.workspaceFiles!;
  const workspace = tempDirs.make("openclaw-repository-matrix-");
  async function write(name: string, content: string) {
    const destination = path.join(workspace, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
  for (const [name, content] of Object.entries(files)) {
    await write(name, content);
  }
  const evaluate = () =>
    fixture.evaluate({
      workspace,
      trace: { calls: [], outcomes: [], activities: [], assistantTurns: 0, models: [] },
      receipts: [],
    });

  expect(await evaluate()).toMatchObject({
    repositoryReadable: true,
    inputPreserved: true,
    originalTestsPreserved: true,
    testsPass: false,
    heldOutBalances: false,
    persistedArtifact: false,
  });
  await write("src/money.mjs", fixedMoney);
  expect(await evaluate()).toMatchObject({ testsPass: false, heldOutBalances: false });

  await write("lib/money-parser.mjs", fixedMoney);
  await write("src/money.mjs", 'export { parseAmountCents } from "../lib/money-parser.mjs";\n');
  await write(
    "src/ledger.mjs",
    files["src/ledger.mjs"]!.replace(
      "const key = invoice.customer;",
      "const key = JSON.stringify([invoice.customer, invoice.currency]);",
    ),
  );
  await write(
    "test/credit.test.mjs",
    `import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/ledger.mjs";
test("signed credits preserve an exact balance", () => {
  const rows = ["0.29", "-0.01"].map(amount => ({ customer: "credit", currency: "USD", amount, status: "open" }));
  assert.deepEqual(summarize(rows), { invoiceCount: 2, outstandingCount: 2, totals: [{ customer: "credit", currency: "USD", amountCents: 28 }] });
});
`,
  );
  const generated = await runCommandWithTimeout(
    [
      process.execPath,
      "bin/summarize.mjs",
      "data/invoices.ndjson",
      "artifacts/ledger-summary.json",
    ],
    {
      cwd: workspace,
      baseEnv: {},
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: workspace,
        TMPDIR: workspace,
      },
      timeoutMs: 15_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
    },
  );
  expect(generated.code).toBe(0);
  expect(generated.cleanup).not.toBe("uncertain");
  expect(Object.values(await evaluate()).every(Boolean)).toBe(true);

  await write("src/money.mjs", files["src/money.mjs"]!);
  expect(await evaluate()).toMatchObject({
    persistedArtifact: true,
    heldOutBalances: false,
    testsPass: false,
  });
  await write("test/money.test.mjs", "// tests removed\n");
  expect(await evaluate()).toMatchObject({ originalTestsPreserved: false, testsPass: false });
});
