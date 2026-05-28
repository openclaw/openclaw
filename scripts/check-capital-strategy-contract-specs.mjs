import assert from "node:assert/strict";
import {
  CONTRACT_SPECS,
  MONTH_CODES,
  SPEC_METADATA,
  calcIndicativeMargin,
  calcMargin,
  calcPnl,
  formatSpecs,
  getByCategory,
  getByExchange,
  getNearbyContracts,
  getSpec,
  isListedContractMonth,
  listSymbols,
  parseContractCode,
} from "./strategy-engine/brokers/ContractSpecs.mjs";

assert.equal(SPEC_METADATA.liveOrderPolicy, "read_only_reference_data_no_order_execution");
assert.equal(SPEC_METADATA.marginPolicy, "indicative_only_not_broker_authoritative");
assert.ok(Object.keys(CONTRACT_SPECS).length >= 35);

assert.equal(getSpec("cl").description, "WTI Crude Oil");
assert.equal(getSpec("CN").underlying, "FTSE China A50 Index");
assert.equal(getSpec("TX").exchange, "TAIFEX");
assert.equal(getSpec("UNKNOWN"), null);

assert.ok(listSymbols().includes("MCL"));
assert.ok(getByCategory("energy").some((item) => item.symbol === "CL"));
assert.ok(getByExchange("SGX").some((item) => item.symbol === "CN"));

assert.equal(calcPnl("CL", 70, 71.25, 2), 2500);
assert.equal(calcPnl("CL", 70, 71.25, 2, "short"), -2500);
assert.equal(calcIndicativeMargin("MCL", 3), 1500);
assert.equal(calcMargin("MCL", -3), 1500);
assert.throws(() => calcPnl("BAD", 1, 2), /Unknown contract symbol/u);

assert.deepEqual(parseContractCode("MCLM26"), {
  symbol: "MCL",
  monthCode: "M",
  month: 6,
  year: 2026,
  fullCode: "MCLM26",
});
assert.deepEqual(parseContractCode("ESZ2026"), {
  symbol: "ES",
  monthCode: "Z",
  month: 12,
  year: 2026,
  fullCode: "ESZ2026",
});
assert.equal(parseContractCode("BAD"), null);
assert.equal(MONTH_CODES.Z, 12);
assert.equal(isListedContractMonth("ES", "Z"), true);
assert.equal(isListedContractMonth("ES", "F"), false);

assert.deepEqual(getNearbyContracts("ES", 4, new Date("2026-05-20T00:00:00Z")), [
  "ESM26",
  "ESU26",
  "ESZ26",
  "ESH27",
]);
assert.deepEqual(getNearbyContracts("CL", 3, new Date("2026-11-01T00:00:00Z")), [
  "CLX26",
  "CLZ26",
  "CLF27",
]);
assert.deepEqual(getNearbyContracts("BAD", 3, new Date("2026-11-01T00:00:00Z")), []);

const formatted = formatSpecs(["CL", "CN"]);
assert.match(formatted, /CL \| NYMEX \| WTI Crude Oil/u);
assert.match(formatted, /marginPolicy=indicative_only_not_broker_authoritative/u);
assert.doesNotMatch(formatted, /undefined/u);

process.stdout.write("capital strategy contract specs check PASS\n");
