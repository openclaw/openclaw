import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionsDir = path.join(repoRoot, "extensions");
const pluginManifestFilename = "openclaw.plugin.json";
const webProviderContractKeys = ["webFetchProviders", "webSearchProviders"];

function readJsonRecord(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function readContractProviderIds(contracts, contractKey) {
  return Array.isArray(contracts?.[contractKey])
    ? contracts[contractKey]
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
}

function readPluginManifest(dirName) {
  const manifest = readJsonRecord(path.join(extensionsDir, dirName, pluginManifestFilename));
  const pluginId = typeof manifest?.id === "string" ? manifest.id.trim() : "";
  if (!pluginId) {
    return undefined;
  }
  const contracts =
    manifest.contracts && typeof manifest.contracts === "object" ? manifest.contracts : undefined;
  return {
    pluginId,
    providerIdsByContract: Object.fromEntries(
      webProviderContractKeys.map((contractKey) => [
        contractKey,
        readContractProviderIds(contracts, contractKey),
      ]),
    ),
  };
}

let bundledWebProviderContractsCache;

export function listBundledWebProviderContracts() {
  bundledWebProviderContractsCache ??= fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readPluginManifest(entry.name))
    .filter((entry) => entry !== undefined)
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
  return bundledWebProviderContractsCache;
}

function uniqueSortedStrings(values) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function listBundledProviderPluginIds(contractKey) {
  return listBundledWebProviderContracts()
    .filter((entry) => entry.providerIdsByContract[contractKey].length > 0)
    .map((entry) => entry.pluginId);
}

function listBundledProviderIds(contractKey) {
  return uniqueSortedStrings(
    listBundledWebProviderContracts().flatMap((entry) => entry.providerIdsByContract[contractKey]),
  );
}

function buildBundledPluginToPrimaryProviderMap(contractKey) {
  return new Map(
    listBundledWebProviderContracts()
      .filter((entry) => entry.providerIdsByContract[contractKey].length > 0)
      .map((entry) => [entry.pluginId, entry.providerIdsByContract[contractKey][0]]),
  );
}

export function listBundledWebSearchPluginIds() {
  return listBundledProviderPluginIds("webSearchProviders");
}

export function listBundledWebSearchProviderIds() {
  return listBundledProviderIds("webSearchProviders");
}

export function buildBundledWebSearchPluginToPrimaryProviderMap() {
  return buildBundledPluginToPrimaryProviderMap("webSearchProviders");
}

export function listBundledWebFetchProviderIds() {
  return listBundledProviderIds("webFetchProviders");
}
