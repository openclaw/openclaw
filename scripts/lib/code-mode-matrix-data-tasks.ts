import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createGatewayMatrixPluginSource } from "./code-mode-matrix-gateway-fixtures.ts";
import type { MatrixPerformanceFixture } from "./code-mode-matrix-performance-types.ts";

export const DATA_TASKS = ["invoice-reconciliation"] as const;
type DataTask = (typeof DATA_TASKS)[number];

type Invoice = {
  invoiceId: string;
  revision: number;
  customerId: string;
  status: "open" | "paid" | "cancelled";
  dueDate: string;
  amountCents?: number | string | null;
  creditCents: number;
  memo: string;
};
type PayableInvoice = {
  invoiceId: string;
  revision: number;
  customerId: string;
  amountCents: number;
  creditCents: number;
  netCents: number;
};

const PAGE_SIZE = 24;
const INVOICE_FIELDS = [
  "invoiceId",
  "revision",
  "customerId",
  "status",
  "dueDate",
  "amountCents",
  "creditCents",
  "memo",
] as const;
const ARTIFACTS = ["reconciliation.json", "customer-balances.csv"] as const;

export function isDataTask(task: string): task is DataTask {
  return task === "invoice-reconciliation";
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function invoiceData(repetition: number) {
  const seed = fingerprint(`invoice-reconciliation-v1:${repetition}`);
  let state = Number.parseInt(seed.slice(0, 8), 16);
  const random = (bound: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % bound;
  };
  const month = String(1 + random(9)).padStart(2, "0");
  const cutoffDate = `2026-${month}-15`;
  const invoices: Invoice[] = [];
  for (let index = 0; index < 144; index += 1) {
    for (let revision = 1; revision <= (index < 48 ? 2 : 1); revision += 1) {
      const amount = 100 + random(90_000);
      const variant = random(8);
      const row: Invoice = {
        invoiceId: `INV-${seed.slice(0, 6)}-${String(index + 1).padStart(3, "0")}`,
        revision,
        customerId: `customer-${String(1 + random(9)).padStart(2, "0")}`,
        status: (["open", "open", "open", "paid", "cancelled"] as const)[random(5)]!,
        dueDate: `2026-${month}-${["10", "15", "20"][random(3)]}`,
        ...(variant === 0
          ? {}
          : { amountCents: variant === 1 ? null : variant < 5 ? String(amount) : amount }),
        creditCents: random(100),
        memo: `Synthetic delivery ${random(10_000)}; ${["east", "west", "north"][random(3)]} desk. Packaging reviewed; supporting correspondence archived.`,
      };
      // These latest revisions distinguish zero, null, missing, and final-page coverage.
      if (index < 4 && revision === 2) {
        row.status = "open";
        row.dueDate = cutoffDate;
        row.creditCents = 0;
        if (index === 0) {
          row.amountCents = 90_000 + random(10_000);
        }
        if (index === 1) {
          row.amountCents = "0";
        }
        if (index === 2) {
          row.amountCents = null;
        }
        if (index === 3) {
          delete row.amountCents;
        }
      }
      invoices.push(row);
    }
  }
  for (let index = invoices.length - 1; index > 0; index -= 1) {
    const other = random(index + 1);
    [invoices[index], invoices[other]] = [invoices[other]!, invoices[index]!];
  }
  const finalIndex = invoices.findIndex(
    (row) => row.invoiceId.endsWith("-001") && row.revision === 2,
  );
  invoices.push(...invoices.splice(finalIndex, 1));
  const snapshotId = `invoices-${seed}`;
  const pages = Array.from({ length: invoices.length / PAGE_SIZE }, (_, index) => ({
    cursor: fingerprint(`${snapshotId}:page:${index}`),
    records: invoices.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE),
  }));
  return { snapshotId, cutoffDate, invoices, pages };
}

// The oracle works from complete records, independently of paging and tool execution.
function reconcile(invoices: readonly Invoice[], snapshotId: string, cutoffDate: string) {
  const ids = [...new Set(invoices.map((row) => row.invoiceId))].toSorted();
  const payableInvoices: PayableInvoice[] = [];
  const excludedInvoices: { invoiceId: string; revision: number; reason: string }[] = [];
  const exceptions: { invoiceId: string; revision: number; reason: string }[] = [];
  for (const invoiceId of ids) {
    const row = invoices
      .filter((invoice) => invoice.invoiceId === invoiceId)
      .toSorted((left, right) => right.revision - left.revision)[0]!;
    if (row.status !== "open" || row.dueDate > cutoffDate) {
      excludedInvoices.push({
        invoiceId,
        revision: row.revision,
        reason: row.status !== "open" ? row.status : "future",
      });
    } else if (row.amountCents === undefined || row.amountCents === null) {
      exceptions.push({ invoiceId, revision: row.revision, reason: "unknown_amount" });
    } else {
      const amountCents = Number(row.amountCents);
      payableInvoices.push({
        invoiceId,
        revision: row.revision,
        customerId: row.customerId,
        amountCents,
        creditCents: row.creditCents,
        netCents: amountCents - row.creditCents,
      });
    }
  }
  const customerTotals = [...new Set(payableInvoices.map((row) => row.customerId))]
    .toSorted()
    .map((customerId) => {
      const rows = payableInvoices.filter((row) => row.customerId === customerId);
      return {
        customerId,
        invoiceCount: rows.length,
        netCents: rows.reduce((sum, row) => sum + row.netCents, 0),
      };
    });
  return {
    snapshotId,
    sourceRecordCount: invoices.length,
    invoiceCount: ids.length,
    cutoffDate,
    payableInvoices,
    excludedInvoices,
    exceptions,
    customerTotals,
    totalNetCents: payableInvoices.reduce((sum, row) => sum + row.netCents, 0),
  };
}

export function createDataFixture(task: DataTask, repetition: number): MatrixPerformanceFixture {
  if (!isDataTask(task) || !Number.isSafeInteger(repetition) || repetition < 0) {
    throw new Error("Invoice fixture requires its task ID and a nonnegative integer repetition");
  }
  const { snapshotId, cutoffDate, invoices, pages } = invoiceData(repetition);
  const expected = reconcile(invoices, snapshotId, cutoffDate);
  const csv = [
    "customerId,invoiceCount,netCents",
    ...expected.customerTotals.map(
      (row) => `${row.customerId},${row.invoiceCount},${row.netCents}`,
    ),
    "",
  ].join("\n");
  const pageValues = pages.map((page, index) => ({
    snapshotId,
    records: page.records,
    nextCursor: pages[index + 1]?.cursor ?? null,
  }));
  if (pageValues.some((page) => Buffer.byteLength(JSON.stringify(page)) > 8 * 1024)) {
    throw new Error("Invoice fixture exceeds its 8 KiB complete-page bound");
  }
  const policy = JSON.stringify(
    {
      cutoffDate,
      rules: [
        "Keep only the highest revision for each invoiceId before applying any other rule.",
        "Exclude paid and cancelled invoices first, using their status as the reason.",
        "Then exclude open invoices with dueDate after cutoffDate, using reason future.",
        "For remaining invoices, missing or null amountCents is unknown_amount; do not convert it to zero.",
        "Decimal integer strings are valid cents. Include zero amounts. Net cents are amountCents minus creditCents.",
      ],
    },
    null,
    2,
  );
  const workspaceFiles = {
    "reconciliation-policy.json": `${policy}\n`,
    "existing-notes.txt": `Preserve this existing note for ${snapshotId}.\n`,
  };
  const requiredTools = ["matrix_invoice_snapshot", "matrix_invoice_page"];
  return {
    rubricVersion: "invoice-reconciliation-v1",
    deliveredFiles: ARTIFACTS,
    requiredTools,
    allowedTools: [...requiredTools, "read", "write", "edit", "exec", "process"],
    workspaceFiles,
    prompt: `Reconcile the complete invoice snapshot using reconciliation-policy.json. Use the invoice snapshot and page tools to obtain the source records; their optional fields projection can omit irrelevant fields. Follow all continuation cursors, including the final page. Preserve the policy and existing notes.

Write reconciliation.json with exactly these fields: {snapshotId,sourceRecordCount,invoiceCount,cutoffDate,payableInvoices,excludedInvoices,exceptions,customerTotals,totalNetCents}. sourceRecordCount counts all revisions; invoiceCount counts distinct invoice IDs. Each payableInvoices entry is {invoiceId,revision,customerId,amountCents,creditCents,netCents}, with numeric cents. Each excludedInvoices or exceptions entry is {invoiceId,revision,reason}. Sort each of these three arrays by invoiceId. Each customerTotals entry is {customerId,invoiceCount,netCents}; include only customers with payable invoices, including zero-value invoices, and sort by customerId. totalNetCents sums all payable net cents.

Write customer-balances.csv from customerTotals with exactly the header customerId,invoiceCount,netCents, one data row per customer, no quoting, LF line endings, and a final newline. Read back both files to verify the deliverables. Reply with their paths, the payable invoice count, and total net cents. Do not settle invoices or modify the source data.`,
    pluginSource: createGatewayMatrixPluginSource(`
const snapshot = ${JSON.stringify({ snapshotId, recordCount: invoices.length, firstCursor: pages[0]!.cursor, availableFields: INVOICE_FIELDS })};
const pageByCursor = ${JSON.stringify(Object.fromEntries(pages.map((page, index) => [page.cursor, pageValues[index]])))};
api.registerTool({
  name: "matrix_invoice_snapshot", label: "Invoice snapshot",
  description: "Read an immutable synthetic invoice snapshot descriptor: {snapshotId,recordCount,firstCursor,availableFields}. Pass its snapshotId and firstCursor to matrix_invoice_page. This reads no invoice records.",
  parameters: {type:"object",properties:{},additionalProperties:false},
  async execute() {
    record("call", "matrix_invoice_snapshot", {snapshotId:snapshot.snapshotId});
    return result(snapshot);
  }
});
api.registerTool({
  name: "matrix_invoice_page", label: "Invoice page",
  description: "Read one complete invoice page, at most 8 KiB: {snapshotId,records,nextCursor}. Continue until nextCursor is null. Records have invoiceId, revision, customerId, status (open/paid/cancelled), dueDate (YYYY-MM-DD), amountCents (integer, decimal integer string, null, or missing), creditCents (integer), and memo. Optional fields projects only the named fields without filtering rows or changing cursors. Pages are immutable and contain different revisions of some invoices. No aggregation is performed.",
  parameters: ${JSON.stringify({ type: "object", properties: { snapshotId: { type: "string" }, cursor: { type: "string" }, fields: { type: "array", items: { type: "string", enum: INVOICE_FIELDS }, minItems: 1, uniqueItems: true } }, required: ["snapshotId", "cursor"], additionalProperties: false })},
  async execute(_id, input) {
    if (input.snapshotId !== snapshot.snapshotId || !Object.hasOwn(pageByCursor, input.cursor)) throw new Error("Unknown invoice snapshot or cursor");
    const page = pageByCursor[input.cursor];
    const records = input.fields ? page.records.map(row => Object.fromEntries(input.fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]]))) : page.records;
    record("call", "matrix_invoice_page", {snapshotId:page.snapshotId,cursor:input.cursor,nextCursor:page.nextCursor,recordCount:records.length});
    return result({...page,records});
  }
});`),
    evaluate: async (params) => {
      const [jsonText, csvText, ...preserved] = await Promise.all(
        [...ARTIFACTS, ...Object.keys(workspaceFiles)].map((name) =>
          fs.readFile(path.join(params.workspace, name), "utf8").catch(() => undefined),
        ),
      );
      let actual: unknown;
      try {
        actual = JSON.parse(jsonText ?? "");
      } catch {
        actual = undefined;
      }
      const receipts = params.receipts.filter(
        (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
      );
      return {
        exactReconciliationArtifact: isDeepStrictEqual(actual, expected),
        exactCustomerBalancesArtifact: csvText === csv,
        preservedSourceFiles: Object.values(workspaceFiles).every(
          (value, index) => value === preserved[index],
        ),
        observedSnapshot: receipts.some(
          (row) =>
            row.kind === "call" &&
            row.tool === "matrix_invoice_snapshot" &&
            row.snapshotId === snapshotId,
        ),
        completePageCoverage: pages.every((page, index) =>
          receipts.some(
            (row) =>
              row.kind === "call" &&
              row.tool === "matrix_invoice_page" &&
              row.snapshotId === snapshotId &&
              row.cursor === page.cursor &&
              row.nextCursor === pageValues[index]!.nextCursor &&
              row.recordCount === page.records.length,
          ),
        ),
      };
    },
  };
}
