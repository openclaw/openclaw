import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMissingSnapshotResult,
  filterStockList,
  normalizeStockList,
  renderStockList,
  runStockListCli,
} from "./openclaw-capital-hft-stock-list.mjs";

const sample = {
  generatedAt: "2026-05-20T00:00:00.000Z",
  markets: {
    0: [{ quoteCode: "2330", name: "TSMC", type: "stock", brokerCode: "2330" }],
    2: [
      {
        quoteCode: "TX00AM",
        name: "TAIEX Futures AM",
        type: "future",
        brokerCode: "TX00",
        expiry: "near",
      },
      {
        quoteCode: "CNM26",
        name: "SGX FTSE China A50",
        type: "overseas_future",
        brokerCode: "CNM26",
      },
    ],
  },
};

const normalized = normalizeStockList(sample);
assert.equal(normalized.status, "ready");
assert.equal(normalized.count, 3);
assert.equal(normalized.markets[2][1].quoteCode, "CNM26");
assert.equal(normalized.markets[2][1].brokerCode, "CNM26");

const filteredByMarket = filterStockList(sample, { market: "2" });
assert.equal(filteredByMarket.count, 2);
assert.deepEqual(Object.keys(filteredByMarket.markets), ["2"]);

const filteredByText = filterStockList(sample, { filter: "a50" });
assert.equal(filteredByText.count, 1);
assert.equal(filteredByText.markets[2][0].quoteCode, "CNM26");

const rendered = renderStockList(filteredByText);
assert.match(rendered, /Capital HFT stock list/u);
assert.match(rendered, /CNM26/u);
assert.match(rendered, /brokerCode=CNM26/u);

const missing = buildMissingSnapshotResult("missing.json");
assert.equal(missing.status, "blocked");
assert.equal(missing.blockerCode, "MISSING_STOCK_LIST_SNAPSHOT");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-stock-list-"));
const inputPath = path.join(tempDir, "stock-list.json");
fs.writeFileSync(inputPath, JSON.stringify(sample), "utf8");
try {
  const ok = runStockListCli(["--input", inputPath, "--market", "2", "--json"]);
  assert.equal(ok.exitCode, 0);
  const parsed = JSON.parse(ok.output);
  assert.equal(parsed.count, 2);

  const blocked = runStockListCli(["--input", path.join(tempDir, "missing.json"), "--json"]);
  assert.equal(blocked.exitCode, 2);
  assert.equal(JSON.parse(blocked.output).blockerCode, "MISSING_STOCK_LIST_SNAPSHOT");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

process.stdout.write("capital hft stock list check PASS\n");
