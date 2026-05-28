import fs from "node:fs/promises";
import path from "node:path";

async function readJson(filePath, label) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label} not readable: ${filePath}`, { cause: error });
  }
}

async function readText(filePath, label) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} not readable: ${filePath}`, { cause: error });
  }
}

async function main() {
  const repoRoot = process.cwd();
  const skillPath = path.join(
    repoRoot,
    ".agents",
    "skills",
    "openclaw-7x24-monitoring",
    "SKILL.md",
  );
  const skillMetaPath = path.join(
    repoRoot,
    ".agents",
    "skills",
    "openclaw-7x24-monitoring",
    "agents",
    "openai.yaml",
  );
  const assistantSkillPath = path.join(repoRoot, "skills", "auto-trading-assistant", "SKILL.md");
  const quoteStatusPath = path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json");
  const watchStatePath = path.join(repoRoot, ".openclaw", "ui", "auto-trading-watch-state.json");

  const [skillText, assistantText, quoteStatus, watchState] = await Promise.all([
    readText(skillPath, "7x24 monitoring skill"),
    readText(assistantSkillPath, "auto trading assistant skill"),
    readJson(quoteStatusPath, "quote status"),
    readJson(watchStatePath, "watch state"),
  ]);
  await fs.access(skillMetaPath);

  if (!skillText.includes("name: openclaw-7x24-monitoring")) {
    throw new Error("7x24 skill metadata missing");
  }
  if (!skillText.includes("read-only monitoring loop")) {
    throw new Error("7x24 skill body missing monitoring guidance");
  }
  if (!assistantText.includes("$openclaw-7x24-monitoring")) {
    throw new Error("auto-trading assistant skill not linked to 7x24 monitoring");
  }
  if (quoteStatus.quoteProof?.status !== "confirmed") {
    throw new Error(`quote proof not confirmed: ${JSON.stringify(quoteStatus.quoteProof)}`);
  }
  if (typeof quoteStatus.quoteProof?.latestStock !== "string") {
    throw new Error("missing latest trade quote");
  }
  if (
    quoteStatus.completion?.openClawReady !== true ||
    quoteStatus.completion?.openClawCompleted !== true
  ) {
    throw new Error("openclaw completion is not ready");
  }
  if (quoteStatus.diagnostics?.selectedStock?.selectedFromEventStream !== true) {
    throw new Error("quote selection is not coming from event stream");
  }
  const entrypoints = Array.isArray(watchState.assistant?.entrypoints)
    ? watchState.assistant.entrypoints
    : [];
  if (!entrypoints.includes("pnpm capital-hft:auto-trading-watch")) {
    throw new Error("assistant entrypoints missing capital-hft:auto-trading-watch");
  }
  if (!entrypoints.includes("pnpm capital-hft:auto-trading-watch:daemon")) {
    throw new Error("assistant entrypoints missing capital-hft:auto-trading-watch:daemon");
  }
  if (typeof watchState.assistant?.nextSafeTask !== "string") {
    throw new Error("missing assistant next safe task");
  }
  if (typeof watchState.tickDiagnostic?.status !== "string") {
    throw new Error("missing tick diagnostic status");
  }

  const freshnessStatus =
    quoteStatus.quoteProof.freshnessStatus ?? quoteStatus.quoteProof.freshness ?? "";
  const latestTradeQuote = quoteStatus.quoteProof.latestStock;
  const freshTradeQuote = freshnessStatus === "fresh" ? latestTradeQuote : "";
  const freshQuoteAvailable = freshTradeQuote !== "";

  if (quoteStatus.quoteProof.status !== "confirmed") {
    throw new Error(`quote proof not confirmed: ${JSON.stringify(quoteStatus.quoteProof)}`);
  }
  if (typeof quoteStatus.quoteProof?.latestStock !== "string") {
    throw new Error("missing latest trade quote");
  }
  if (freshQuoteAvailable && quoteStatus.quoteProof.freshnessStatus !== "fresh") {
    throw new Error(`fresh quote flag inconsistent: ${quoteStatus.quoteProof.freshnessStatus}`);
  }

  process.stdout.write(
    [
      "OPENCLAW_7X24_MONITORING_CHECK=OK",
      `tradeQuote=${freshTradeQuote || "NONE"}`,
      `latestTradeQuote=${latestTradeQuote}`,
      `tradeQuoteStatus=${freshnessStatus}`,
      `freshQuoteAvailable=${freshQuoteAvailable}`,
      `quoteStatus=${quoteStatus.status}`,
      `watchStatus=${watchState.status}`,
    ].join("\n") + "\n",
  );
}

await main().catch((error) => {
  process.stderr.write(
    `openclaw 7x24 monitoring check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
