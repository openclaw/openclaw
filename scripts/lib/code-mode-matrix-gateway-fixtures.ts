export const GATEWAY_MATRIX_TASKS = [
  "invoices-auto-retention",
  "inventory-join",
  "automation-contracts",
  "process-contracts",
  "partial-failure",
  "checked-cell-cache",
  "return-value-effects",
  "result-save-invalid-json",
  "gateway-config-read",
] as const;

export type GatewayMatrixTask = (typeof GATEWAY_MATRIX_TASKS)[number];

export type GatewayMatrixFixture = {
  prompt: string;
  expected: Record<string, unknown>;
  pluginSource: string;
  processHelperSource?: string;
  interviewPrompt: string;
  requiredTools: readonly string[];
  probeCode?: string;
};

export function createGatewayMatrixPluginManifest(requiredTools: readonly string[]) {
  return {
    id: "code-mode-matrix-fixture",
    name: "Code Mode matrix fixture",
    contracts: { tools: [...requiredTools] },
    activation: { onStartup: true },
    configSchema: {
      type: "object",
      properties: { receiptsPath: { type: "string", minLength: 1 } },
      required: ["receiptsPath"],
      additionalProperties: false,
    },
  };
}

const EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false };

function pluginSource(registration: string): string {
  return `import fs from "node:fs";
export default function register(api) {
const receiptFile = api.pluginConfig.receiptsPath;
function receipts() {
  try {
    const raw = fs.readFileSync(receiptFile, "utf8");
    if (Buffer.byteLength(raw) > 262144) throw new Error("Fixture receipt limit exceeded");
    return raw.trim().split("\\n").filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
function record(kind, tool, facts = {}) {
  const previous = receipts();
  const row = { sequence: previous.length + 1, kind, tool, ...facts };
  const line = JSON.stringify(row) + "\\n";
  if (previous.length >= 256 || Buffer.byteLength(line) > 4096) {
    throw new Error("Fixture receipt limit exceeded");
  }
  fs.appendFileSync(receiptFile, line, { encoding: "utf8", mode: 0o600 });
}
function result(details) {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}
${registration}
}
`;
}

function readOnlyTool(name: string, description: string, value: unknown): string {
  return `api.registerTool({
    name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)},
    description: ${JSON.stringify(description)},
    parameters: ${JSON.stringify(EMPTY_INPUT)},
    async execute() {
      record("call", ${JSON.stringify(name)});
      return result(${JSON.stringify(value)});
    }
  });`;
}

function interviewPrompt(task: GatewayMatrixTask): string {
  return `Explain your completed ${task} work from the evidence you actually observed. This follow-up is a new agent run in the same conversation. If the preceding work exposed a saved result reference, use one code cell to try results.load with that actual reference, catch any error, and emit the actual returned value or caught error message in the tool output before explaining the outcome. Do not invent a reference or fetch source data again. Apart from that read attempt, do not call tools or change state. Return JSON with these fields:
- rationale: why you chose the sequence of operations you used;
- dataCoverage: whether you calculated from complete data, a preview/sample, or neither, and what established that;
- observedShape: fields and variants you actually observed, plus what a sample alone could not establish;
- freshness: whether retained data is a snapshot or a fresh read, and when another read would be needed;
- retainedResults: whether you used result references, what lifetime/limits were stated by the runtime, and anything you did not verify;
- failures: errors you observed, whether they occurred before or after a tool dispatched, and how you checked for effects before taking another action;
- actions: the read and write operations you actually performed, including cleanup;
- facts: {previewComplete,retainedDataFresh,sameRunOnly,priorRefAvailable,failureImpliesRollback}, each a boolean or null when inapplicable or not established, justified by the observations above. previewComplete means the initial bounded preview contained the entire original source value, not that a later computation loaded complete data. retainedDataFresh means the retained value represents a fresh source read in this interview run, not a read that was fresh earlier. sameRunOnly describes the runtime's stated contract that result references belong to their creating agent run; distinguish that statement from what an unavailable-or-expired error proves experimentally. priorRefAvailable means loading the prior value actually succeeded in this interview's new run, not merely that its descriptor was visible. failureImpliesRollback asks whether the observed error itself establishes that no side effect occurred;
- limitations: anything this run did not establish.
Be precise about unknowns. Do not infer all record variants from a preview or claim a worker/cache was warm without direct evidence.`;
}

function invoiceFixture(repetition: number) {
  const nonce = `invoice-export-r${repetition}-v1`;
  const totalsCents: Record<string, number> = {};
  const invoices = Array.from({ length: 240 }, (_, index) => {
    const customer = `customer-${index % 7}`;
    const amountCents = 900 + ((index * 137 + repetition * 53) % 25_000);
    const paid = (index + repetition) % 4 === 0;
    if (!paid) {
      totalsCents[customer] = (totalsCents[customer] ?? 0) + amountCents;
    }
    return {
      id: `INV-${repetition}-${String(index + 1).padStart(4, "0")}`,
      customer,
      amountCents,
      paid,
      memo: `Synthetic invoice ${index + 1}. ${"Delivery and reconciliation details. ".repeat(12)}`,
    };
  });
  return {
    prompt:
      "Fetch the invoice export. In your first data-fetching code cell, return the complete raw export unchanged so you can inspect it before deciding how to calculate. Then, in a later code cell, calculate unpaid totals in cents grouped by customer over every invoice. Avoid fetching the same export again. Your final answer must be only JSON: {nonce,count,totalsCents}, where count is the total number of invoices, paid and unpaid, and totalsCents maps customer names to unpaid amounts. Do not print invoice records in the final answer.",
    expected: { nonce, count: invoices.length, totalsCents },
    pluginSource: pluginSource(
      readOnlyTool(
        "matrix_invoice_export",
        "Fetch the complete invoice export snapshot, including its nonce and all invoices. This tool has no declared output schema.",
        { nonce, invoices },
      ),
    ),
  };
}

function inventoryFixture(repetition: number) {
  const nonce = `inventory-export-r${repetition}-v1`;
  const suppliers = Array.from({ length: 9 }, (_, index) => ({
    supplierId: `supplier-${index}`,
    available: index % 4 !== 0,
    terms: { unitCostCents: index === 7 ? null : 125 + index * 23 + repetition },
  }));
  const totals = new Map<string, { supplierId: string; units: number; costCents: number }>();
  let lowStockCount = 0;
  let reorderUnits = 0;
  let unavailableSupplierCount = 0;
  const batches = Array.from({ length: 6 }, (_, batch) => ({
    warehouse: `warehouse-${batch}`,
    records: Array.from({ length: 60 }, (_record, offset) => {
      const index = batch * 60 + offset;
      const quantity = (index * 7 + repetition) % 31;
      const target = 15 + (index % 5);
      const supplierIndex = index % 11;
      const supplierId = `supplier-${supplierIndex}`;
      const unknownQuantity = index >= 5 && (index % 13 === 0 || index % 17 === 0);
      const supplier = suppliers[supplierIndex];
      if (!unknownQuantity && quantity < target) {
        lowStockCount += 1;
        if (!supplier?.available || supplier.terms.unitCostCents === null) {
          unavailableSupplierCount += 1;
        } else {
          const units = target - quantity;
          reorderUnits += units;
          const aggregate = totals.get(supplierId) ?? { supplierId, units: 0, costCents: 0 };
          aggregate.units += units;
          aggregate.costCents += units * supplier.terms.unitCostCents;
          totals.set(supplierId, aggregate);
        }
      }
      return {
        sku: `SKU-${repetition}-${index}`,
        supplier: supplierIndex === 10 ? null : { id: supplierId },
        ...(index >= 5 && index % 17 === 0
          ? {}
          : {
              stock: {
                onHand: unknownQuantity
                  ? null
                  : index >= 5 && index % 3 === 0
                    ? String(quantity)
                    : quantity,
              },
            }),
        reorder: { target },
        notes: `${"Synthetic warehouse picking detail. ".repeat(7)}${index}`,
      };
    }),
  }));
  return {
    prompt:
      "Prepare a reorder summary for the complete warehouse inventory using the supplier directory. For records with a known quantity below their target, order the deficit only when the supplier is available and has a known unit cost. Decimal numeric strings count as quantities; missing or null quantities are unknown and must be excluded. Count low-stock records whose supplier is missing, unavailable, or lacks a price separately. Return only JSON: {nonce,lowStockCount,reorderUnits,unavailableSupplierCount,totalsBySupplier}, with totalsBySupplier sorted by supplierId and each entry containing {supplierId,units,costCents}. Do not place orders.",
    expected: {
      nonce,
      lowStockCount,
      reorderUnits,
      unavailableSupplierCount,
      totalsBySupplier: [...totals.values()].toSorted((a, b) =>
        a.supplierId.localeCompare(b.supplierId),
      ),
    },
    pluginSource: pluginSource(
      [
        readOnlyTool(
          "matrix_inventory_export",
          "Read the complete warehouse inventory snapshot. Records are grouped by warehouse and may contain different stock and supplier variants. No declared output schema.",
          { nonce, batches },
        ),
        readOnlyTool(
          "matrix_supplier_directory",
          "Read the supplier directory, including availability and unit costs in cents. No declared output schema.",
          { suppliers },
        ),
      ].join("\n"),
    ),
  };
}

function partialFailureFixture(repetition: number) {
  const nonce = `settlement-r${repetition}-v1`;
  const operationId = `matrix-settlement-${repetition}`;
  const totalCents = 6_000 + repetition * 31;
  const input = {
    type: "object",
    properties: { operationId: { type: "string", const: operationId } },
    required: ["operationId"],
    additionalProperties: false,
  };
  const output = {
    type: "object",
    properties: {
      nonce: { type: "string" },
      receipt: { type: "string" },
      totalCents: { type: "number" },
    },
    required: ["nonce", "receipt", "totalCents"],
    additionalProperties: false,
  };
  return {
    prompt: `Settle synthetic operation ${operationId} once and report its actual resulting state. Use the available settlement tools; no real account is involved. The final answer must be only JSON: {nonce,operationId,effectCount,totalCents}.`,
    expected: { nonce, operationId, effectCount: 1, totalCents },
    pluginSource: pluginSource(`api.registerTool({
    name: "matrix_settle", label: "Matrix settlement",
    description: "Apply a settlement to the named synthetic operation. Each successful dispatch creates an additional settlement effect; dispatch is not idempotent. Use matrix_settlement_inspect to read actual persisted state.",
    parameters: ${JSON.stringify(input)},
    outputSchema: ${JSON.stringify(output)},
    async execute(_id, input) {
      if (input.operationId !== ${JSON.stringify(operationId)}) throw new Error("Unknown operation");
      record("call", "matrix_settle", { operationId: input.operationId });
      const receipt = receipts().filter(row => row.kind === "effect").length + 1;
      record("effect", "matrix_settle", { operationId: input.operationId, receipt, totalCents: ${totalCents} });
      return result({ nonce: ${JSON.stringify(nonce)}, receipt });
    }
  });
  api.registerTool({
    name: "matrix_settlement_inspect", label: "Inspect matrix settlement",
    description: "Read actual persisted settlement effects for the named operation without changing them.",
    parameters: ${JSON.stringify(input)},
    async execute(_id, input) {
      if (input.operationId !== ${JSON.stringify(operationId)}) throw new Error("Unknown operation");
      record("call", "matrix_settlement_inspect", { operationId: input.operationId });
      const effects = receipts().filter(row => row.kind === "effect" && row.operationId === input.operationId);
      return result({ nonce: ${JSON.stringify(nonce)}, operationId: input.operationId, effectCount: effects.length,
        totalCents: effects.reduce((sum, row) => sum + row.totalCents, 0) });
    }
  });`),
  };
}

function returnValueEffectsFixture(repetition: number) {
  const nonce = `return-value-r${repetition}-v1`;
  const marker = `RETURN_VALUE_EFFECT_R${repetition}`;
  const probeCode = `const nonce = ${JSON.stringify(nonce)};
const marker = ${JSON.stringify(marker)};
return {
  get nonce() {
    text(marker);
    void matrix_return_effect({ nonce });
    return nonce;
  },
  marker,
};`;
  return {
    prompt: `Run the following JavaScript program unchanged in exactly one exec cell. Its final returned getter intentionally emits output and starts a synthetic effect; do not move those operations out of the getter or invoke the getter yourself. Follow any wait continuation until the cell settles. Do not retry or perform other operations. Report only the final returned JSON value.\n\n${probeCode}`,
    probeCode,
    expected: { nonce, marker },
    pluginSource: pluginSource(`api.registerTool({
    name: "matrix_return_effect", label: "Record return-value effect",
    description: "Record one synthetic effect receipt for the return-value probe. Each call adds an effect.",
    parameters: { type: "object", properties: { nonce: { type: "string", const: ${JSON.stringify(nonce)} } }, required: ["nonce"], additionalProperties: false },
    async execute(_id, input) {
      if (input.nonce !== ${JSON.stringify(nonce)}) throw new Error("Unknown probe");
      record("call", "matrix_return_effect", { nonce: input.nonce });
      await new Promise(resolve => setTimeout(resolve, 25));
      record("effect", "matrix_return_effect", { nonce: input.nonce });
      return result({ nonce: input.nonce });
    }
  });`),
    requiredTools: ["matrix_return_effect"],
  };
}

function invalidResultSaveFixture(repetition: number) {
  const nonce = `result-save-r${repetition}-v1`;
  const probeCode = `const seed = await matrix_serialization_seed({});
const saved = await results.save(seed);
const cycle = {};
cycle.self = cycle;
const invalid = [
  ["bigint", 1n],
  ["cycle", cycle],
  ["throwing-toJSON", { toJSON() { throw new Error("synthetic toJSON failure"); } }],
];
const rejected = [];
for (const [kind, value] of invalid) {
  try {
    await results.save(value);
  } catch (error) {
    rejected.push(kind);
    json({ kind, error: String(error) });
  }
}
const loaded = await results.load(saved.id);
const deleted = await results.delete(saved.id);
return { nonce: loaded.nonce, rejected, deleted };`;
  return {
    prompt: `Run the following JavaScript program unchanged in exactly one exec cell. It checks actual serialization refusals and preserves a valid saved value. Do not replace unsupported values with strings or null, remove the failing cases, or invent error outcomes. Follow any wait continuation until the cell settles. Do not retry or perform other operations. Report only the final returned JSON value.\n\n${probeCode}`,
    probeCode,
    expected: { nonce, rejected: ["bigint", "cycle", "throwing-toJSON"], deleted: true },
    pluginSource: pluginSource(`api.registerTool({
    name: "matrix_serialization_seed", label: "Read serialization seed",
    description: "Read the JSON seed for the serialization probe.",
    parameters: ${JSON.stringify(EMPTY_INPUT)},
    outputSchema: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"], additionalProperties: false },
    async execute() {
      record("call", "matrix_serialization_seed");
      return result({ nonce: ${JSON.stringify(nonce)} });
    }
  });`),
    requiredTools: ["matrix_serialization_seed"],
  };
}

export function createGatewayMatrixFixture(
  task: GatewayMatrixTask,
  repetition: number,
): GatewayMatrixFixture {
  if (!Number.isSafeInteger(repetition) || repetition < 0) {
    throw new Error("Fixture repetition must be a nonnegative safe integer");
  }
  const interview = interviewPrompt(task);
  if (task === "return-value-effects") {
    return { ...returnValueEffectsFixture(repetition), interviewPrompt: interview };
  }
  if (task === "result-save-invalid-json") {
    return { ...invalidResultSaveFixture(repetition), interviewPrompt: interview };
  }
  if (task === "invoices-auto-retention") {
    return {
      ...invoiceFixture(repetition),
      interviewPrompt: interview,
      requiredTools: ["matrix_invoice_export"],
    };
  }
  if (task === "inventory-join") {
    return {
      ...inventoryFixture(repetition),
      interviewPrompt: interview,
      requiredTools: ["matrix_inventory_export", "matrix_supplier_directory"],
    };
  }
  if (task === "partial-failure") {
    return {
      ...partialFailureFixture(repetition),
      interviewPrompt: interview,
      requiredTools: ["matrix_settle", "matrix_settlement_inspect"],
    };
  }
  const common = { pluginSource: pluginSource(""), interviewPrompt: interview, requiredTools: [] };
  if (task === "gateway-config-read") {
    const probe = `gateway-config-r${repetition}`;
    return {
      ...common,
      prompt: `Read the real Gateway configuration at path tools.codeMode using gateway with action config.get. In the data-fetching exec cell, return the complete raw tool value unchanged so you can inspect its actual shape. Then report only JSON: {probe:${JSON.stringify(probe)},enabled:<the configured boolean>}. Read that path exactly once. Do not infer enabled from tool availability, read files, or change configuration.`,
      expected: { probe, enabled: true },
    };
  }
  if (task === "automation-contracts") {
    const jobName = `matrix-contracts-r${repetition}`;
    const updatedName = `${jobName}-updated`;
    const payloadText = `Synthetic disabled automation ${repetition}`;
    return {
      ...common,
      prompt: `Use the real automations tool through checked TypeScript cells to verify a disabled job lifecycle. First read scheduler status and the complete job inventory including disabled jobs. Preserve every pre-existing job, including system heartbeat jobs. Create one disabled, one-time future job named ${JSON.stringify(jobName)} with a main-session system-event payload ${JSON.stringify(payloadText)}; choose a time one day in the future. Read it, rename it to ${JSON.stringify(updatedName)}, read it again, inspect its run history, and remove only the job you created. Do not enable or run it. Confirm the pre-existing inventory is unchanged. Return only JSON: {jobName,updatedName,payloadText,remainingOwnedJobs}. remainingOwnedJobs must be a number: the count of jobs created by this task that are still present after cleanup, expected to be 0. Exclude all pre-existing jobs from that count.`,
      expected: { jobName, updatedName, payloadText, remainingOwnedJobs: 0 },
    };
  }
  if (task === "process-contracts") {
    const marker = `MATRIX_PROCESS_R${repetition}_DONE`;
    return {
      ...common,
      processHelperSource: `console.log(${JSON.stringify(marker)}); setTimeout(() => {}, 2000);\n`,
      prompt: `Using checked TypeScript cells and the real shell/process tools, run the supplied workspace helper with command "node ./process-probe.mjs" in the background. Execute exactly one shell command overall: that helper command. Do not inspect source or run any other shell commands. Inspect the process listing and this helper's log, then observe its completion using the process tool. The helper exits on its own; do not touch other processes. Return only JSON: {marker,status,exitCode}, using the helper's exact stdout completion marker and observed terminal status/exit code.`,
      expected: { marker, status: "completed", exitCode: 0 },
    };
  }
  if (task === "checked-cell-cache") {
    const start = repetition + 1;
    const cells = [1, 2, 3].map((ordinal) => ({ ordinal, sum: start + ordinal * 10 }));
    return {
      ...common,
      prompt: `Run exactly three separate checked TypeScript code cells, one at a time. In each cell call the real process-list tool and check whether its result contains a sessions list. In cell ordinal 1, 2, and 3 respectively, calculate ${start} + ordinal * 10 and return {ordinal,sum}. Do not create or alter processes. Finish with only JSON: {cells:[the three returned objects in order]}.`,
      expected: { cells },
    };
  }
  throw new Error(`Unknown Gateway matrix task: ${String(task)}`);
}
