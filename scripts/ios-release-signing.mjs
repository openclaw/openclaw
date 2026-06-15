#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = path.join(rootDir, "apps", "ios", "Config", "AppStoreSigning.json");
const generatedSigningDir = path.join(rootDir, "apps", "ios", "build", "signing");
const generatedProfileDir = path.join(generatedSigningDir, "profiles");
const generatedKeyPath = path.join(generatedSigningDir, "OpenClaw-IOS-Distribution.key");
const generatedCsrPath = path.join(generatedSigningDir, "OpenClaw-IOS-Distribution.csr");
const generatedCertificatePath = path.join(generatedSigningDir, "OpenClaw-IOS-Distribution.cer");

function usage() {
  process.stdout.write(`Usage:
  scripts/ios-release-signing.mjs --mode plan
  scripts/ios-release-signing.mjs --mode xcconfig
  scripts/ios-release-signing.mjs --mode check
  scripts/ios-release-signing.mjs --mode setup
  scripts/ios-release-signing.mjs --mode sync-push
  scripts/ios-release-signing.mjs --mode sync-pull

Options:
  --manifest PATH   Signing manifest path. Defaults to apps/ios/Config/AppStoreSigning.json.

The check/setup/sync modes require asc authentication. sync modes require ASC_MATCH_PASSWORD
or an asc --password value supplied through the environment.
`);
}

function parseArgs(argv) {
  let mode = "";
  let manifestPath = defaultManifestPath;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      mode = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--manifest") {
      manifestPath = path.resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!mode) {
    throw new Error("Missing required --mode.");
  }

  return { mode, manifestPath };
}

function readManifest(manifestPath) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const requiredStrings = ["teamId", "signingRepo", "certificateType", "profileType"];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      throw new Error(`Signing manifest missing ${key}.`);
    }
  }
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error("Signing manifest must include targets.");
  }

  for (const target of parsed.targets) {
    for (const key of [
      "target",
      "displayName",
      "bundleId",
      "platform",
      "profileKey",
      "profileName",
    ]) {
      if (typeof target[key] !== "string" || target[key].trim() === "") {
        throw new Error(`Signing target is missing ${key}.`);
      }
    }
    if (!Array.isArray(target.capabilities)) {
      throw new Error(`Signing target ${target.target} must include capabilities array.`);
    }
  }

  return parsed;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    env: process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const detail = stderr || stdout || `${command} exited with status ${result.status}`;
    if (
      options.allowAlreadyExists &&
      detail.includes("The specified item already exists in the keychain")
    ) {
      return result.stdout ?? "";
    }
    throw new Error(detail);
  }

  return result.stdout ?? "";
}

function runAscJson(args) {
  const stdout = run("asc", [...args, "--output", "json"]);
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`asc returned non-JSON output for ${args.join(" ")}: ${trimmed.slice(0, 500)}`);
  }
}

function runAsc(args, options = {}) {
  return run("asc", args, options);
}

function records(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload.data)) {
    return payload.data;
  }
  if (Array.isArray(payload.results)) {
    return payload.results;
  }
  if (Array.isArray(payload.items)) {
    return payload.items;
  }
  return [];
}

function recordFromPayload(payload) {
  if (Array.isArray(payload)) {
    return payload.find((record) => recordId(record)) ?? null;
  }
  if (payload?.data && !Array.isArray(payload.data) && recordId(payload.data)) {
    return payload.data;
  }
  if (recordId(payload)) {
    return payload;
  }
  return records(payload).find((record) => recordId(record)) ?? null;
}

function recordId(record) {
  return String(record?.id ?? record?.attributes?.id ?? "");
}

function recordAttr(record, key) {
  const attributes = record?.attributes ?? {};
  return record?.[key] ?? attributes[key];
}

function profileState(record) {
  return String(recordAttr(record, "profileState") ?? recordAttr(record, "state") ?? "");
}

function profileName(record) {
  return String(recordAttr(record, "name") ?? "");
}

function profileContent(record) {
  return String(recordAttr(record, "profileContent") ?? "");
}

function certificateName(record) {
  return String(
    recordAttr(record, "name") ?? recordAttr(record, "serialNumber") ?? recordId(record),
  );
}

function certificateContent(record) {
  return String(recordAttr(record, "certificateContent") ?? "");
}

function certificateFingerprint(record) {
  const content = certificateContent(record);
  if (!content) {
    return "";
  }

  return crypto
    .createHash("sha1")
    .update(Buffer.from(content, "base64"))
    .digest("hex")
    .toUpperCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function ensureAscAvailable() {
  try {
    run("asc", ["--help"]);
  } catch (error) {
    throw new Error(`asc CLI is required for iOS release signing setup: ${error.message}`);
  }
}

function bundleIdentifier(record) {
  return String(recordAttr(record, "identifier") ?? recordAttr(record, "bundleId") ?? "");
}

function capabilityType(record) {
  return String(recordAttr(record, "capabilityType") ?? recordAttr(record, "capability") ?? "");
}

function listBundleIds() {
  return records(runAscJson(["bundle-ids", "list", "--paginate"]));
}

function listProfiles(manifest) {
  return records(
    runAscJson([
      "profiles",
      "list",
      "--profile-type",
      manifest.profileType,
      "--profile-state",
      "ACTIVE,INVALID",
      "--paginate",
    ]),
  );
}

function listCertificates(manifest) {
  return records(
    runAscJson([
      "certificates",
      "list",
      "--certificate-type",
      manifest.certificateType,
      "--paginate",
    ]),
  );
}

function listLocalProfiles(manifest) {
  if (process.platform !== "darwin") {
    return [];
  }
  return records(runAscJson(["profiles", "local", "list", "--team-id", manifest.teamId]));
}

function findBundle(bundleIds, target) {
  return bundleIds.find((bundle) => bundleIdentifier(bundle) === target.bundleId) ?? null;
}

function findProfile(profiles, target) {
  return (
    profiles.find((profile) => {
      return profileName(profile) === target.profileName && profileState(profile) !== "INVALID";
    }) ?? null
  );
}

function profileCertificateFingerprints(profile) {
  const xml = profileXml(profile);
  if (!xml) {
    return new Set();
  }

  const developerCertificates =
    /<key>DeveloperCertificates<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(xml)?.[1] ?? "";
  const fingerprints = new Set();
  for (const match of developerCertificates.matchAll(/<data>([\s\S]*?)<\/data>/gu)) {
    const der = match[1].replace(/\s+/gu, "");
    if (der) {
      fingerprints.add(
        crypto.createHash("sha1").update(Buffer.from(der, "base64")).digest("hex").toUpperCase(),
      );
    }
  }
  return fingerprints;
}

function profileXml(profile) {
  const content = profileContent(profile);
  if (!content) {
    return "";
  }
  try {
    return Buffer.from(content, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function profileIncludesCertificate(profile, certificateRecord) {
  const fingerprint = certificateFingerprint(certificateRecord);
  return fingerprint !== "" && profileCertificateFingerprints(profile).has(fingerprint);
}

function profileHasEntitlement(profile, entitlement) {
  const xml = profileXml(profile);
  const entitlements = /<key>Entitlements<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(xml)?.[1] ?? "";
  return new RegExp(`<key>${escapeRegExp(entitlement)}</key>`, "u").test(entitlements);
}

function profileSupportsCapabilities(profile, target) {
  for (const capability of target.capabilities) {
    if (capability === "PUSH_NOTIFICATIONS" && !profileHasEntitlement(profile, "aps-environment")) {
      return false;
    }
  }
  return true;
}

function findInstalledProfile(localProfiles, manifest, target) {
  return (
    localProfiles.find((profile) => {
      return (
        profileName(profile) === target.profileName &&
        bundleIdentifier(profile) === target.bundleId &&
        String(recordAttr(profile, "teamId") ?? "") === manifest.teamId &&
        recordAttr(profile, "expired") !== true
      );
    }) ?? null
  );
}

function listCapabilities(bundleRecord, target) {
  const bundle = recordId(bundleRecord) || target.bundleId;
  return records(
    runAscJson(["bundle-ids", "capabilities", "list", "--bundle", bundle, "--paginate"]),
  );
}

function createBundle(target) {
  process.stderr.write(`Creating bundle ID ${target.bundleId}\n`);
  return runAscJson([
    "bundle-ids",
    "create",
    "--identifier",
    target.bundleId,
    "--name",
    target.displayName,
    "--platform",
    target.platform,
  ]);
}

function addMissingCapabilities(bundleRecord, target) {
  const existing = new Set(listCapabilities(bundleRecord, target).map(capabilityType));
  for (const capability of target.capabilities) {
    if (existing.has(capability)) {
      continue;
    }
    process.stderr.write(`Adding ${capability} capability to ${target.bundleId}\n`);
    runAscJson([
      "bundle-ids",
      "capabilities",
      "add",
      "--bundle",
      recordId(bundleRecord) || target.bundleId,
      "--capability",
      capability,
    ]);
  }
}

function ensureDistributionCertificate(manifest) {
  const existing = listCertificates(manifest);
  const certificateWithLocalKey = findCertificateWithLocalKey(existing, manifest);
  if (certificateWithLocalKey) {
    process.stderr.write(
      `Using ${manifest.certificateType} certificate ${certificateName(certificateWithLocalKey)} with local private key\n`,
    );
    return certificateWithLocalKey;
  }

  const certificate =
    process.platform === "darwin" ? null : existing.find((candidate) => recordId(candidate));
  if (certificate) {
    process.stderr.write(
      `Using ${manifest.certificateType} certificate ${certificateName(certificate)}\n`,
    );
    return certificate;
  }

  fs.mkdirSync(generatedSigningDir, { recursive: true, mode: 0o700 });
  process.stderr.write(`Creating ${manifest.certificateType} certificate and local private key\n`);
  const existingIds = new Set(existing.map(recordId).filter(Boolean));
  const createPayload = runAscJson([
    "certificates",
    "create",
    "--certificate-type",
    manifest.certificateType,
    "--generate-csr",
    "--key-out",
    generatedKeyPath,
    "--csr-out",
    generatedCsrPath,
  ]);

  const createdFromResponse = recordFromPayload(createPayload);
  const createdId = recordId(createdFromResponse);
  const refreshed = listCertificates(manifest);
  const created =
    (createdId ? refreshed.find((candidate) => recordId(candidate) === createdId) : null) ??
    createdFromResponse ??
    refreshed.find((candidate) => {
      const candidateId = recordId(candidate);
      return candidateId && !existingIds.has(candidateId);
    });
  if (!created) {
    throw new Error(
      `Created ${manifest.certificateType} certificate, but could not resolve its certificate ID.`,
    );
  }
  process.stderr.write(
    `Created ${manifest.certificateType} certificate ${certificateName(created)}\n`,
  );
  return created;
}

function findCertificateWithLocalKey(certificates, manifest) {
  const localFingerprints = localDistributionIdentityFingerprints(manifest);
  if (localFingerprints.size === 0) {
    return null;
  }
  return (
    certificates.find((candidate) => {
      const fingerprint = certificateFingerprint(candidate);
      return fingerprint && localFingerprints.has(fingerprint);
    }) ?? null
  );
}

function localDistributionIdentityFingerprints(manifest) {
  if (process.platform !== "darwin") {
    return new Set();
  }

  let output = "";
  try {
    output = run("security", ["find-identity", "-p", "codesigning", "-v"]);
  } catch {
    return new Set();
  }

  const fingerprints = new Set();
  for (const line of output.split("\n")) {
    if (!line.includes(manifest.teamId) || !/(Apple|iPhone) Distribution:/.test(line)) {
      continue;
    }
    const match = /\b([0-9A-Fa-f]{40})\b/u.exec(line);
    if (match) {
      fingerprints.add(match[1].toUpperCase());
    }
  }
  return fingerprints;
}

function selectedDistributionIdentityPresent(certificateRecord) {
  const fingerprint = certificateFingerprint(certificateRecord);
  return (
    fingerprint !== "" && localDistributionIdentityFingerprints({ teamId: "" }).has(fingerprint)
  );
}

function writeCertificate(certificateRecord) {
  const content = certificateContent(certificateRecord);
  if (!content) {
    throw new Error(
      `Certificate ${certificateName(certificateRecord)} is missing certificateContent.`,
    );
  }

  fs.mkdirSync(generatedSigningDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(generatedCertificatePath, Buffer.from(content, "base64"));
}

function importGeneratedSigningIdentity(manifest, certificateRecord) {
  if (process.platform !== "darwin") {
    process.stderr.write("Skipping Keychain import because this is not macOS.\n");
    return;
  }

  if (selectedDistributionIdentityPresent(certificateRecord)) {
    process.stderr.write(
      "Selected Apple Distribution signing identity is already available in Keychain.\n",
    );
    return;
  }

  if (!fs.existsSync(generatedKeyPath)) {
    throw new Error(
      `No local private key found at apps/ios/build/signing/OpenClaw-IOS-Distribution.key. Pull shared signing assets or create a new distribution certificate before archiving.`,
    );
  }

  writeCertificate(certificateRecord);
  const keychainPath = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
  process.stderr.write("Importing generated Apple Distribution identity into login Keychain\n");
  run(
    "security",
    [
      "import",
      generatedKeyPath,
      "-k",
      keychainPath,
      "-T",
      "/usr/bin/codesign",
      "-T",
      "/usr/bin/security",
    ],
    { allowAlreadyExists: true },
  );
  run(
    "security",
    ["import", generatedCertificatePath, "-k", keychainPath, "-T", "/usr/bin/codesign"],
    {
      allowAlreadyExists: true,
    },
  );

  if (!selectedDistributionIdentityPresent(certificateRecord)) {
    throw new Error(
      "Imported distribution certificate/private key, but no Apple Distribution codesigning identity is visible in Keychain.",
    );
  }
}

function createProfile(manifest, target, bundleRecord, certificateRecord) {
  process.stderr.write(`Creating profile ${target.profileName}\n`);
  runAscJson([
    "profiles",
    "create",
    "--name",
    target.profileName,
    "--profile-type",
    manifest.profileType,
    "--bundle",
    recordId(bundleRecord) || target.bundleId,
    "--certificate",
    recordId(certificateRecord),
  ]);
}

function deleteProfile(profileRecord) {
  runAscJson(["profiles", "delete", "--id", recordId(profileRecord), "--confirm"]);
}

function profilePath(target) {
  return path.join(
    generatedProfileDir,
    `${target.profileName.replaceAll("/", "-")}.mobileprovision`,
  );
}

function downloadAndInstallProfile(target, profileRecord) {
  const outputPath = profilePath(target);
  fs.mkdirSync(generatedProfileDir, { recursive: true });
  fs.rmSync(outputPath, { force: true });
  runAsc(["profiles", "download", "--id", recordId(profileRecord), "--output", outputPath]);
  runAsc(["profiles", "local", "install", "--path", outputPath, "--force"]);
  process.stderr.write(`Installed profile ${target.profileName}\n`);
}

function checkSigning(manifest) {
  ensureAscAvailable();
  const bundleIds = listBundleIds();
  const profiles = listProfiles(manifest);
  const certificates = listCertificates(manifest);
  const certificateWithLocalKey = findCertificateWithLocalKey(certificates, manifest);
  const localProfiles = listLocalProfiles(manifest);
  const missing = [];

  for (const target of manifest.targets) {
    const bundle = findBundle(bundleIds, target);
    if (!bundle) {
      missing.push(`bundle ID ${target.bundleId}`);
      continue;
    }

    const existingCapabilities = new Set(listCapabilities(bundle, target).map(capabilityType));
    for (const capability of target.capabilities) {
      if (!existingCapabilities.has(capability)) {
        missing.push(`${target.bundleId} capability ${capability}`);
      }
    }

    const profile = findProfile(profiles, target);
    if (!profile) {
      missing.push(`profile ${target.profileName}`);
    } else if (
      certificateWithLocalKey &&
      !profileIncludesCertificate(profile, certificateWithLocalKey)
    ) {
      missing.push(`profile ${target.profileName} with selected distribution certificate`);
    } else if (!profileSupportsCapabilities(profile, target)) {
      missing.push(`profile ${target.profileName} with required entitlements`);
    }
    if (process.platform === "darwin" && !findInstalledProfile(localProfiles, manifest, target)) {
      missing.push(`installed profile ${target.profileName}`);
    }
  }

  if (certificates.length === 0) {
    missing.push(`${manifest.certificateType} certificate`);
  } else if (process.platform === "darwin" && !certificateWithLocalKey) {
    missing.push(`${manifest.certificateType} certificate with matching local private key`);
  }

  if (missing.length > 0) {
    throw new Error(`iOS App Store signing is incomplete:\n- ${missing.join("\n- ")}`);
  }

  process.stdout.write(
    "iOS App Store signing assets are present and match apps/ios/Config/AppStoreSigning.json.\n",
  );
}

function setupSigning(manifest) {
  ensureAscAvailable();
  let bundleIds = listBundleIds();
  const certificate = ensureDistributionCertificate(manifest);
  importGeneratedSigningIdentity(manifest, certificate);

  for (const target of manifest.targets) {
    let bundle = findBundle(bundleIds, target);
    if (!bundle) {
      createBundle(target);
      bundleIds = listBundleIds();
      bundle = findBundle(bundleIds, target);
    }
    if (!bundle) {
      throw new Error(`Could not resolve bundle ID ${target.bundleId} after creation.`);
    }
    addMissingCapabilities(bundle, target);
  }

  let profiles = listProfiles(manifest);
  for (const target of manifest.targets) {
    let profile = findProfile(profiles, target);
    if (
      profile &&
      (!profileIncludesCertificate(profile, certificate) ||
        !profileSupportsCapabilities(profile, target))
    ) {
      process.stderr.write(
        `Replacing profile ${target.profileName} because it does not match the selected certificate or required entitlements\n`,
      );
      deleteProfile(profile);
      profiles = listProfiles(manifest);
      profile = null;
    }
    if (!profile) {
      const bundle = findBundle(bundleIds, target);
      createProfile(manifest, target, bundle, certificate);
      profiles = listProfiles(manifest);
      profile = findProfile(profiles, target);
    }
    if (!profile) {
      throw new Error(`Could not resolve profile ${target.profileName} after creation.`);
    }
    if (!profileIncludesCertificate(profile, certificate)) {
      throw new Error(
        `Profile ${target.profileName} does not include the selected distribution certificate.`,
      );
    }
    if (!profileSupportsCapabilities(profile, target)) {
      throw new Error(`Profile ${target.profileName} does not include the required entitlements.`);
    }
    downloadAndInstallProfile(target, profile);
  }

  process.stdout.write("iOS App Store signing setup is complete.\n");
  process.stdout.write(
    "Run `pnpm ios:release:signing:sync:push` to encrypt the assets into the shared signing repo.\n",
  );
}

function requireSyncPassword() {
  if (!process.env.ASC_MATCH_PASSWORD?.trim()) {
    throw new Error("ASC_MATCH_PASSWORD is required for encrypted signing sync.");
  }
}

function syncPush(manifest) {
  ensureAscAvailable();
  requireSyncPassword();
  for (const target of manifest.targets) {
    process.stderr.write(`Syncing ${target.bundleId} to ${manifest.signingRepo}\n`);
    runAscJson([
      "signing",
      "sync",
      "push",
      "--bundle-id",
      target.bundleId,
      "--profile-type",
      manifest.profileType,
      "--certificate-type",
      manifest.certificateType,
      "--create-missing",
      "--repo",
      manifest.signingRepo,
    ]);
  }
  process.stdout.write("Encrypted iOS signing assets pushed to the shared signing repo.\n");
}

function installProfilesFromDirectory(dir) {
  if (!fs.existsSync(dir)) {
    return 0;
  }

  let installed = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      installed += installProfilesFromDirectory(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".mobileprovision")) {
      runAsc(["profiles", "local", "install", "--path", entryPath, "--force"]);
      installed += 1;
    }
  }
  return installed;
}

function syncPull(manifest) {
  ensureAscAvailable();
  requireSyncPassword();
  const outputDir = path.join(generatedSigningDir, "sync");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  runAscJson([
    "signing",
    "sync",
    "pull",
    "--repo",
    manifest.signingRepo,
    "--output-dir",
    outputDir,
  ]);
  const installedProfiles = installProfilesFromDirectory(outputDir);
  process.stdout.write(`Pulled encrypted iOS signing assets into apps/ios/build/signing/sync.\n`);
  process.stdout.write(`Installed ${installedProfiles} provisioning profile(s).\n`);
  process.stdout.write(
    "Import the pulled distribution certificate/private key into Keychain before archiving.\n",
  );
}

function writeXcconfig(manifest) {
  const lines = [
    "OPENCLAW_CODE_SIGN_STYLE = Manual",
    "OPENCLAW_CODE_SIGN_IDENTITY = Apple Distribution",
  ];

  for (const target of manifest.targets) {
    lines.push(`${target.profileKey} = ${target.profileName}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function writePlan(manifest) {
  process.stdout.write(`iOS App Store signing plan
Team ID: ${manifest.teamId}
Certificate type: ${manifest.certificateType}
Profile type: ${manifest.profileType}
Signing repo: ${manifest.signingRepo}

Targets:
`);
  for (const target of manifest.targets) {
    const capabilities = target.capabilities.length > 0 ? target.capabilities.join(", ") : "none";
    process.stdout.write(
      `- ${target.target}: ${target.bundleId}, profile "${target.profileName}", capabilities: ${capabilities}\n`,
    );
  }
}

try {
  const { mode, manifestPath } = parseArgs(process.argv.slice(2));
  const manifest = readManifest(manifestPath);

  if (mode === "plan") {
    writePlan(manifest);
  } else if (mode === "xcconfig") {
    writeXcconfig(manifest);
  } else if (mode === "check") {
    checkSigning(manifest);
  } else if (mode === "setup") {
    setupSigning(manifest);
  } else if (mode === "sync-push") {
    syncPush(manifest);
  } else if (mode === "sync-pull") {
    syncPull(manifest);
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
