import process from "node:process";
import { isTruthyEnvValue } from "../../../src/infra/env.js";
import { isWSL2Sync } from "../../../src/infra/wsl.js";
const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";
const TELEGRAM_DNS_RESULT_ORDER_ENV = "OPENCLAW_TELEGRAM_DNS_RESULT_ORDER";
let wsl2SyncCache;
function isWSL2SyncCached() {
  if (typeof wsl2SyncCache === "boolean") {
    return wsl2SyncCache;
  }
  wsl2SyncCache = isWSL2Sync();
  return wsl2SyncCache;
}
function resolveTelegramAutoSelectFamilyDecision(params) {
  const env = params?.env ?? process.env;
  const nodeMajor = typeof params?.nodeMajor === "number" ? params.nodeMajor : Number(process.versions.node.split(".")[0]);
  if (isTruthyEnvValue(env[TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: true, source: `env:${TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (isTruthyEnvValue(env[TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: false, source: `env:${TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (typeof params?.network?.autoSelectFamily === "boolean") {
    return { value: params.network.autoSelectFamily, source: "config" };
  }
  if (isWSL2SyncCached()) {
    return { value: false, source: "default-wsl2" };
  }
  if (Number.isFinite(nodeMajor) && nodeMajor >= 22) {
    return { value: true, source: "default-node22" };
  }
  return { value: null };
}
function resolveTelegramDnsResultOrderDecision(params) {
  const env = params?.env ?? process.env;
  const nodeMajor = typeof params?.nodeMajor === "number" ? params.nodeMajor : Number(process.versions.node.split(".")[0]);
  const envValue = env[TELEGRAM_DNS_RESULT_ORDER_ENV]?.trim().toLowerCase();
  if (envValue === "ipv4first" || envValue === "verbatim") {
    return { value: envValue, source: `env:${TELEGRAM_DNS_RESULT_ORDER_ENV}` };
  }
  const configValue = params?.network?.dnsResultOrder?.trim().toLowerCase();
  if (configValue === "ipv4first" || configValue === "verbatim") {
    return { value: configValue, source: "config" };
  }
  if (Number.isFinite(nodeMajor) && nodeMajor >= 22) {
    return { value: "ipv4first", source: "default-node22" };
  }
  return { value: null };
}
function resetTelegramNetworkConfigStateForTests() {
  wsl2SyncCache = void 0;
}
export {
  TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV,
  TELEGRAM_DNS_RESULT_ORDER_ENV,
  TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV,
  resetTelegramNetworkConfigStateForTests,
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision
};
