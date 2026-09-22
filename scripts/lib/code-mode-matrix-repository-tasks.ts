import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  MatrixPerformanceEvaluation,
  MatrixPerformanceFixture,
} from "./code-mode-matrix-performance-types.ts";

export const REPOSITORY_MATRIX_TASKS = ["repo-invoice-repair"] as const;
export type RepositoryMatrixTask = (typeof REPOSITORY_MATRIX_TASKS)[number];

export function isRepositoryMatrixTask(task: string): task is RepositoryMatrixTask {
  return REPOSITORY_MATRIX_TASKS.some((candidate) => candidate === task);
}

type InvoiceSeed = {
  id: string;
  customer: string;
  currency: string;
  cents: number;
  status: "open" | "closed";
};

function invoiceSeeds(repetition: number, heldOut: boolean): InvoiceSeed[] {
  const customers = heldOut
    ? ["__proto__", "customer|USD", "customer", "alpha", "éclair"]
    : ["north", "south", "west", `customer-${repetition}`];
  const currencies = ["USD", "EUR", "JPY"];
  const rows = Array.from({ length: heldOut ? 97 : 61 }, (_, index): InvoiceSeed => ({
    id: `${heldOut ? "batch" : "invoice"}-${repetition}-${index}`,
    customer: customers[(index * 7 + repetition) % customers.length]!,
    currency: currencies[(index + repetition) % currencies.length]!,
    cents: ((index * 173 + repetition * 31) % 90_001) * (index % 7 === 0 ? -1 : 1),
    status: index % 4 === 0 ? "closed" : "open",
  }));
  rows.push(
    { id: "fraction", customer: "fraction", currency: "USD", cents: 29, status: "open" },
    { id: "credit", customer: "fraction", currency: "EUR", cents: -1, status: "open" },
    { id: "zero", customer: "fraction", currency: "JPY", cents: 0, status: "open" },
    { id: "closed", customer: "closed-only", currency: "USD", cents: 12_345, status: "closed" },
  );
  return rows;
}

function invoiceInput(rows: readonly InvoiceSeed[]): string {
  return rows
    .map(({ cents, ...invoice }) => {
      const absolute = Math.abs(cents);
      const amount = `${cents < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
      return `${JSON.stringify({ ...invoice, amount })}\n`;
    })
    .join("");
}

// Expected totals start from integer seed facts, never the candidate's decimal parser.
function expectedSummary(rows: readonly InvoiceSeed[]) {
  const open = rows.filter((invoice) => invoice.status === "open");
  const groups = open.filter(
    (invoice, index) =>
      open.findIndex(
        (other) => other.customer === invoice.customer && other.currency === invoice.currency,
      ) === index,
  );
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return {
    invoiceCount: rows.length,
    outstandingCount: open.length,
    totals: groups
      .map(({ customer, currency }) => ({
        customer,
        currency,
        amountCents: open
          .filter((invoice) => invoice.customer === customer && invoice.currency === currency)
          .reduce((sum, invoice) => sum + invoice.cents, 0),
      }))
      .toSorted(
        (left, right) =>
          compare(left.customer, right.customer) || compare(left.currency, right.currency),
      ),
  };
}

function repositoryFiles(repetition: number): Record<string, string> {
  return {
    "README.md": `# Invoice ledger

This dependency-free Node ESM repository summarizes invoice exports.

Run the tests: node --test test/*.test.mjs
Generate a summary: node bin/summarize.mjs data/invoices.ndjson artifacts/ledger-summary.json

Each input line is an invoice with id, customer, currency, amount, and status.
Amounts are signed decimal strings with exactly two fractional digits. All
amounts and aggregate totals fit within safe integer cents. Customers are opaque
strings; currencies are uppercase three-letter codes. Status is open or closed.
Empty files and blank lines are allowed. Credits are negative amounts.

The output JSON contains invoiceCount (all invoices), outstandingCount (open
invoices), and totals (open invoices grouped by both customer and currency).
Each total contains customer, currency, and integer amountCents. Include zero
totals for groups with open invoices. Sort by customer then currency using
JavaScript string comparison, independent of the machine's locale.

Keep the original tests, package.json, and data/invoices.ndjson unchanged.
Add regression coverage in new test/*.test.mjs files. Do not install packages.
`,
    "package.json": `${JSON.stringify({ name: "invoice-ledger", private: true, type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2)}\n`,
    "src/money.mjs": `export function parseAmountCents(amount) {
  if (!/^-?\\d+\\.\\d{2}$/.test(amount)) throw new Error("Invalid amount");
  return Number.parseFloat(amount) * 100;
}
`,
    "src/ledger.mjs": `import { parseAmountCents } from "./money.mjs";

export function summarize(invoices) {
  const totals = new Map();
  let outstandingCount = 0;
  for (const invoice of invoices) {
    if (invoice.status !== "open") continue;
    outstandingCount += 1;
    const key = invoice.customer;
    const total = totals.get(key) ?? {
      customer: invoice.customer, currency: invoice.currency, amountCents: 0,
    };
    total.amountCents += parseAmountCents(invoice.amount);
    totals.set(key, total);
  }
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  return {
    invoiceCount: invoices.length,
    outstandingCount,
    totals: [...totals.values()].sort((a, b) => compare(a.customer, b.customer) || compare(a.currency, b.currency)),
  };
}
`,
    "bin/summarize.mjs": `import fs from "node:fs/promises";
import path from "node:path";
import { summarize } from "../src/ledger.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node bin/summarize.mjs INPUT OUTPUT");
const invoices = (await fs.readFile(input, "utf8")).split(/\\r?\\n/).filter(line => line.trim()).map(line => JSON.parse(line));
const summary = summarize(invoices);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(summary, null, 2) + "\\n");
console.log(JSON.stringify({ output, invoiceCount: summary.invoiceCount }));
`,
    "test/money.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { parseAmountCents } from "../src/money.mjs";

test("decimal amounts produce exact integer cents", () => {
  assert.equal(parseAmountCents("0.29"), 29);
  assert.equal(parseAmountCents("-0.01"), -1);
});
`,
    "test/ledger.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/ledger.mjs";

test("one customer can have separate currency balances", () => {
  assert.deepEqual(summarize([
    { id: "a", customer: "customer", currency: "USD", amount: "1.00", status: "open" },
    { id: "b", customer: "customer", currency: "EUR", amount: "2.00", status: "open" },
  ]), {
    invoiceCount: 2, outstandingCount: 2,
    totals: [
      { customer: "customer", currency: "EUR", amountCents: 200 },
      { customer: "customer", currency: "USD", amountCents: 100 },
    ],
  });
});
`,
    "data/invoices.ndjson": invoiceInput(invoiceSeeds(repetition, false)),
  };
}

async function snapshotRepository(workspace: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let bytes = 0;
  let entries = 0;
  const visit = async (name: string) => {
    if (++entries > 256) {
      throw new Error("Repository fixture exceeds its entry bound");
    }
    const filePath = path.join(workspace, name);
    const stat = await fs.lstat(filePath);
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(filePath)) {
        await visit(path.join(name, child));
      }
      return;
    }
    if (!stat.isFile() || stat.size > 65_536 || Object.keys(files).length >= 128) {
      throw new Error("Repository fixture contains unsupported files");
    }
    bytes += stat.size;
    if (bytes > 1_048_576) {
      throw new Error("Repository fixture exceeds its byte bound");
    }
    files[name.split(path.sep).join("/")] = await fs.readFile(filePath, "utf8");
  };
  await visit(".");
  return files;
}

function jsonMatches(text: string | undefined, expected: unknown): boolean {
  if (text === undefined) {
    return false;
  }
  try {
    return isDeepStrictEqual(JSON.parse(text), expected);
  } catch {
    return false;
  }
}

async function evaluateInvoiceRepository(
  { workspace }: MatrixPerformanceEvaluation,
  repetition: number,
  original: Record<string, string>,
): Promise<Record<string, boolean>> {
  const checks = {
    repositoryReadable: false,
    inputPreserved: false,
    originalTestsPreserved: false,
    packagePreserved: false,
    regressionAdded: false,
    regressionRejectsOriginal: false,
    testsPass: false,
    persistedArtifact: false,
    heldOutBalances: false,
    heldOutOrderIndependent: false,
    emptyInput: false,
  };
  let files: Record<string, string>;
  try {
    files = await snapshotRepository(workspace);
  } catch {
    return checks;
  }
  checks.repositoryReadable = true;
  checks.inputPreserved = files["data/invoices.ndjson"] === original["data/invoices.ndjson"];
  checks.originalTestsPreserved = ["test/money.test.mjs", "test/ledger.test.mjs"].every(
    (name) => files[name] === original[name],
  );
  checks.packagePreserved = files["package.json"] === original["package.json"];
  const tests = Object.keys(files)
    .filter((name) => /^test\/[^/]+\.test\.mjs$/.test(name))
    .toSorted();
  checks.regressionAdded = tests.some((name) => !(name in original));
  checks.persistedArtifact = jsonMatches(
    files["artifacts/ledger-summary.json"],
    expectedSummary(invoiceSeeds(repetition, false)),
  );
  if (!checks.inputPreserved || !checks.originalTestsPreserved || !checks.packagePreserved) {
    return checks;
  }

  const gradingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repository-grade-"));
  let cleanupConfirmed = true;
  try {
    const gradingRepo = path.join(gradingRoot, "repo");
    const home = path.join(gradingRoot, "home");
    const temp = path.join(gradingRoot, "tmp");
    await fs.mkdir(home);
    await fs.mkdir(temp);
    for (const [name, content] of Object.entries(files)) {
      const destination = path.join(gradingRepo, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }
    const { runCommandWithTimeout } = await import("../../src/process/exec.js");
    const run = async (args: string[], expectedExitCode = 0) => {
      cleanupConfirmed = false;
      const result = await runCommandWithTimeout([process.execPath, ...args], {
        cwd: gradingRepo,
        baseEnv: {},
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
        },
        timeoutMs: 15_000,
        maxOutputBytes: 65_536,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
      });
      cleanupConfirmed = result.cleanup !== "uncertain";
      if (!cleanupConfirmed) {
        throw new Error(`Repository grader process cleanup uncertain: ${gradingRoot}`);
      }
      return result.code === expectedExitCode && result.termination === "exit";
    };
    const probe = async (name: string, rows: readonly InvoiceSeed[]) => {
      const input = path.join(gradingRoot, `${name}.ndjson`);
      const output = path.join(gradingRoot, `${name}.json`);
      await fs.writeFile(input, invoiceInput(rows));
      const succeeded = await run(["bin/summarize.mjs", input, output]);
      const stat = await fs.lstat(output).catch(() => undefined);
      return (
        succeeded &&
        stat?.isFile() === true &&
        stat.size <= 65_536 &&
        jsonMatches(await fs.readFile(output, "utf8"), expectedSummary(rows))
      );
    };
    const heldOut = invoiceSeeds(repetition + 101, true);
    checks.heldOutBalances = await probe("balances", heldOut);
    checks.heldOutOrderIndependent = await probe("reordered", heldOut.toReversed());
    checks.emptyInput = await probe("empty", []);
    // Candidate tests cannot prepare a different implementation for the independent probes.
    checks.testsPass = await run(["--test", ...tests]);
    const regressions = tests.filter((name) => !(name in original));
    if (checks.testsPass && regressions.length > 0) {
      for (const [name, content] of Object.entries(original)) {
        if (name.startsWith("src/") || name.startsWith("bin/")) {
          await fs.writeFile(path.join(gradingRepo, name), content);
        }
      }
      checks.regressionRejectsOriginal = await run(["--test", ...regressions], 1);
    }
    return checks;
  } finally {
    if (cleanupConfirmed) {
      await fs.rm(gradingRoot, { recursive: true, force: true });
    }
  }
}

export function createRepositoryMatrixFixture(
  task: RepositoryMatrixTask,
  repetition: number,
): MatrixPerformanceFixture {
  if (!isRepositoryMatrixTask(task)) {
    throw new Error(`Unknown repository matrix task: ${String(task)}`);
  }
  if (!Number.isSafeInteger(repetition) || repetition < 0) {
    throw new Error("Fixture repetition must be a nonnegative safe integer");
  }
  const workspaceFiles = repositoryFiles(repetition);
  return {
    prompt:
      "The invoice summary command is producing incorrect totals for decimal amounts and customers billed in multiple currencies. Read README.md and the affected code, reproduce the failures with the existing tests, and repair the underlying implementation. Preserve signed credits, exclude closed invoices from outstanding totals, and keep customer/currency groups separate. Keep the existing tests, package.json, and input data unchanged; add focused regression coverage in a new test file. Run the relevant tests, then use the documented command to regenerate artifacts/ledger-summary.json from data/invoices.ndjson and inspect the result. Do not install dependencies. Finish with a concise explanation of the cause, changes, and checks actually run.",
    rubricVersion: "repo-invoice-repair-v1",
    requiredTools: [],
    allowedTools: ["read", "write", "edit", "exec", "process"],
    deliveredFiles: [
      "artifacts/ledger-summary.json",
      "src/money.mjs",
      "src/ledger.mjs",
      "bin/summarize.mjs",
    ],
    workspaceFiles,
    evaluate: (params) => evaluateInvoiceRepository(params, repetition, workspaceFiles),
  };
}
