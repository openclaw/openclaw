import assert from "node:assert/strict";

function nonnegative(value, name) {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0, `Invalid ${name}`);
  return value;
}
function fraction(value, name) {
  nonnegative(value, name);
  assert(value <= 1, `Invalid ${name}`);
  return value;
}
function totalKnown(values) {
  return values.some((value) => value === null)
    ? null
    : values.reduce((sum, value) => sum + value, 0);
}
function modelCost(usage) {
  if (usage === null || usage === undefined) {
    return { inputTokens: null, outputTokens: null, listUsd: null };
  }
  const inputTokens = nonnegative(usage.inputTokens, "inputTokens");
  const outputTokens = nonnegative(usage.outputTokens, "outputTokens");
  assert(
    Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens),
    "Invalid token count",
  );
  const prices = [usage.inputUsdPerMillion, usage.outputUsdPerMillion];
  const listUsd = prices.some((price) => price === null || price === undefined)
    ? null
    : (inputTokens * nonnegative(prices[0], "input token price") +
        outputTokens * nonnegative(prices[1], "output token price")) /
      1e6;
  return { inputTokens, outputTokens, listUsd };
}
const difference = (a, b) => (a === null || b === null ? null : a - b);

/** A what-if model: job allocation time is not CPU utilization or workflow latency. */
export function estimateAdaptiveCosts(input) {
  assert(
    input?.version === 1 && ["shadow", "projection"].includes(input.mode),
    "Invalid cost scenario",
  );
  assert(Array.isArray(input.jobs), "Missing jobs");
  const ids = new Set();
  const jobs = input.jobs.map((job) => {
    assert(typeof job.id === "string" && job.id && !ids.has(job.id), "Missing/duplicate job id");
    ids.add(job.id);
    const baselineSeconds = nonnegative(job.baselineSeconds, "baselineSeconds");
    const selectableSeconds = nonnegative(job.selectableSeconds, "selectableSeconds");
    assert(selectableSeconds <= baselineSeconds, "Selectable time exceeds job duration");
    const retained = fraction(job.retainedFraction, "retainedFraction");
    const audit = fraction(job.auditRate, "auditRate");
    const overhead = nonnegative(job.overheadSeconds, "overheadSeconds");
    const auditOverhead = nonnegative(job.auditOverheadSeconds, "auditOverheadSeconds");
    assert(typeof job.dropEmptyJob === "boolean", "Declare empty-job behavior");
    const fixed = baselineSeconds - selectableSeconds;
    const regularSeconds =
      (retained === 0 && job.dropEmptyJob ? 0 : fixed + selectableSeconds * retained) + overhead;
    const auditedSeconds = baselineSeconds + overhead + auditOverhead;
    const candidateSeconds =
      input.mode === "shadow"
        ? baselineSeconds + overhead
        : (1 - audit) * regularSeconds + audit * auditedSeconds;
    const price = job.usdPerMinute;
    let cost = () => null;
    if (price !== null && price !== undefined) {
      nonnegative(price, "usdPerMinute");
      const quantum = nonnegative(job.billingQuantumSeconds, "billingQuantumSeconds");
      assert(quantum > 0, "Billing quantum must be positive");
      cost = (seconds) => ((Math.ceil(seconds / quantum) * quantum) / 60) * price;
    }
    const baselineListUsd = cost(baselineSeconds);
    // Round the two possible executions separately, then weight them. Rounding an
    // averaged duration can distort the cost of sampled full-run audits.
    const candidateListUsd =
      price === null || price === undefined
        ? null
        : input.mode === "shadow"
          ? cost(candidateSeconds)
          : (1 - audit) * cost(regularSeconds) + audit * cost(auditedSeconds);
    const vcpus = job.allocatedVcpus;
    if (vcpus !== null && vcpus !== undefined) {
      nonnegative(vcpus, "allocatedVcpus");
      assert(vcpus > 0, "Allocated vCPUs must be positive");
    }
    return {
      id: job.id,
      baselineSeconds,
      candidateSeconds,
      baselineListUsd,
      candidateListUsd,
      baselineVcpuMinutes: vcpus == null ? null : (vcpus * baselineSeconds) / 60,
      candidateVcpuMinutes: vcpus == null ? null : (vcpus * candidateSeconds) / 60,
    };
  });
  const metric = (baselineKey, candidateKey) => {
    const baseline = totalKnown(jobs.map((job) => job[baselineKey]));
    const candidate = totalKnown(jobs.map((job) => job[candidateKey]));
    return { baseline, candidate, saved: difference(baseline, candidate), basis: "projected" };
  };
  const baselineModel = modelCost(input.modelUsage?.baseline);
  const candidateModel = modelCost(input.modelUsage?.candidate);
  const runnerListUsd = metric("baselineListUsd", "candidateListUsd");
  const modelListUsd = {
    baseline: baselineModel.listUsd,
    candidate: candidateModel.listUsd,
    saved: difference(baselineModel.listUsd, candidateModel.listUsd),
    basis: "projected",
  };
  return {
    version: 1,
    mode: input.mode,
    jobs,
    runnerSeconds: metric("baselineSeconds", "candidateSeconds"),
    allocatedVcpuMinutes: metric("baselineVcpuMinutes", "candidateVcpuMinutes"),
    runnerListUsd,
    modelListUsd,
    modelTokens: {
      baselineInput: baselineModel.inputTokens,
      candidateInput: candidateModel.inputTokens,
      inputSaved: difference(baselineModel.inputTokens, candidateModel.inputTokens),
      baselineOutput: baselineModel.outputTokens,
      candidateOutput: candidateModel.outputTokens,
      outputSaved: difference(baselineModel.outputTokens, candidateModel.outputTokens),
    },
    netListUsdSaved: totalKnown([runnerListUsd.saved, modelListUsd.saved]),
    criticalPathSecondsSaved: null,
  };
}

export function adaptiveCostMarkdown(report) {
  const value = (number) => (number === null ? "unknown" : Number(number.toFixed(6)).toString());
  const rows = [
    ["Runner seconds", report.runnerSeconds],
    ["Allocated vCPU-minutes", report.allocatedVcpuMinutes],
    ["Runner list USD", report.runnerListUsd],
    ["Model list USD", report.modelListUsd],
  ];
  return [
    `# Adaptive CI cost scenario (${report.mode})`,
    "",
    "Projected values; assumptions are supplied by the caller. Allocation is not CPU utilization.",
    "",
    "| Metric | Baseline | Candidate | Saved |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map(
      ([label, metric]) =>
        `| ${label} | ${value(metric.baseline)} | ${value(metric.candidate)} | ${value(metric.saved)} |`,
    ),
    "",
    `Net list USD saved: ${value(report.netListUsdSaved)}.`,
    `Input tokens saved: ${value(report.modelTokens.inputSaved)}; output tokens saved: ${value(report.modelTokens.outputSaved)}.`,
    "Critical-path latency saved: unknown (requires a workflow timeline).",
    "",
  ].join("\n");
}
