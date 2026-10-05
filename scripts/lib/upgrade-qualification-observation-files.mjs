import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const sha = (data) => createHash("sha256").update(data).digest("hex");
export const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
export function parseObservedProcess(stat) {
  const end = stat.lastIndexOf(")");
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/u);
  if (end < 0 || !/^\d+$/u.test(fields[19] ?? "")) {
    throw new Error("Invalid process identity.");
  }
  return {
    state: fields[0],
    parent: Number(fields[1]),
    group: Number(fields[2]),
    startTime: fields[19],
  };
}
export function assertExactObservedLocation(expected, actual) {
  if (
    !actual ||
    expected.lineNumber !== actual.lineNumber ||
    expected.columnNumber !== actual.columnNumber
  ) {
    throw new Error("V8 relocated the audited boundary.");
  }
}
export function assertObservationAudit(audit, mapping, binding) {
  if (
    audit.purpose !== "reviewed-unchanged-artifact-boundary" ||
    audit.boundary !== binding.boundary ||
    audit.side !== binding.side ||
    audit.runId !== binding.runId ||
    audit.mappingId !== mapping.id ||
    audit.phase !== mapping.phase ||
    audit.scriptSha256 !== mapping.script.sha256 ||
    audit.entrySha256 !== mapping.entry.sha256 ||
    !isDeepStrictEqual(audit.liveTarget, mapping.liveTarget) ||
    audit.targetInstallationManifestSha256 !== binding.targetInstallation?.manifest.sha256 ||
    audit.actionId !== mapping.actionId ||
    audit.operation !== mapping.operation ||
    audit.captureRunExpression !== mapping.captureRunExpression ||
    audit.captureStage !== mapping.captureStage ||
    audit.database !== mapping.database ||
    audit.jobId !== mapping.jobId ||
    !isDeepStrictEqual(audit.facts, mapping.facts) ||
    !isDeepStrictEqual(audit.factFrames, mapping.factFrames) ||
    !isDeepStrictEqual(audit.heldRuntime, mapping.heldRuntime) ||
    audit.snapshotContract !== mapping.snapshotContract ||
    audit.sourceSha256 !== mapping.source.sha256 ||
    audit.sourceMapSha256 !== mapping.sourceMap.sha256 ||
    !isDeepStrictEqual(audit.sourceLocation, mapping.sourceLocation) ||
    audit.guardExpression !== mapping.guardExpression ||
    !isDeepStrictEqual(audit.location, mapping.location) ||
    audit.guardReadOnly !== true ||
    audit.effectOrdering !== true ||
    typeof audit.basis !== "string" ||
    !audit.basis.trim()
  ) {
    throw new Error("Reviewed semantic mapping does not bind these exact inputs.");
  }
}
/** Verify the compiler correspondence, not a caller-authored `exactLocation` flag. */
export function assertCompilerMapping(sourceMap, mapping, sourceBytes) {
  if (
    sourceMap.version !== 3 ||
    !Array.isArray(sourceMap.sources) ||
    !Array.isArray(sourceMap.sourcesContent) ||
    typeof sourceMap.mappings !== "string"
  ) {
    throw new Error("Require the exact unindexed compiler source map.");
  }
  const sourceIndex = sourceMap.sources.indexOf(mapping.sourceName);
  if (
    sourceIndex < 0 ||
    sourceMap.sources.lastIndexOf(mapping.sourceName) !== sourceIndex ||
    sha(Buffer.from(sourceMap.sourcesContent[sourceIndex] ?? "")) !== mapping.source.sha256 ||
    sha(sourceBytes) !== mapping.source.sha256
  ) {
    throw new Error("Compiler source bytes do not match reviewed source.");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let originalSource = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let matched = 0;
  for (const [lineNumber, line] of sourceMap.mappings.split(";").entries()) {
    let generatedColumn = 0;
    for (const segment of line.split(",").filter(Boolean)) {
      const values = [];
      let value = 0;
      let shift = 0;
      for (const character of segment) {
        const digit = alphabet.indexOf(character);
        if (digit < 0 || shift > 30) {
          throw new Error("Invalid compiler VLQ mapping.");
        }
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >> 1) : value >> 1);
          value = 0;
          shift = 0;
        }
      }
      if (shift || ![1, 4, 5].includes(values.length)) {
        throw new Error("Invalid compiler map segment.");
      }
      generatedColumn += values[0];
      if (values.length > 1) {
        originalSource += values[1];
        originalLine += values[2];
        originalColumn += values[3];
      }
      if (
        lineNumber === mapping.location?.lineNumber &&
        generatedColumn === mapping.location.columnNumber &&
        values.length > 1
      ) {
        if (
          originalSource !== sourceIndex ||
          originalLine !== mapping.sourceLocation.lineNumber ||
          originalColumn !== mapping.sourceLocation.columnNumber
        ) {
          throw new Error("Generated point maps to a different original source location.");
        }
        matched++;
      }
    }
  }
  if (mapping.location && matched !== 1) {
    throw new Error("Exact generated point has no unique compiler correspondence.");
  }
}
export async function bytes(file) {
  if (
    !file.path.startsWith("/qualification/") ||
    path.resolve(file.path) !== file.path ||
    (await fs.realpath(file.path)) !== file.path
  ) {
    throw new Error("Noncanonical qualification artifact.");
  }
  const handle = await fs.open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const value = await handle.readFile();
    if (
      !stat.isFile() ||
      stat.size !== file.length ||
      value.length !== file.length ||
      sha(value) !== file.sha256
    ) {
      throw new Error(`Immutable artifact changed: ${file.path}`);
    }
    return value;
  } finally {
    await handle.close();
  }
}
/** Installed aliases are never preflight artifacts: only the sealed external references are. */
export const observedEntryPath = (mapping) => mapping.liveTarget?.entry ?? mapping.entry.path;
export const observedScriptPath = (mapping) => mapping.liveTarget?.script ?? mapping.script.path;

/** Bind loaded target bytes to the complete catalog installation manifest, never local self-attestation. */
export async function verifyLiveTargetFile(binding, filename, reference) {
  const target = binding.targetInstallation;
  if (
    !target ||
    path.resolve(filename) !== filename ||
    !filename.startsWith(`${binding.installation}/`)
  ) {
    throw new Error("Live target escaped its authenticated native installation owner.");
  }
  const manifest = JSON.parse(await bytes(target.manifest));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.releaseId !== target.releaseId ||
    manifest.buildId !== target.buildId ||
    manifest.packageArtifactId !== target.packageArtifactId ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.directories) ||
    new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length
  ) {
    throw new Error("Live target has no exact full installation-manifest binding.");
  }
  const relative = path.relative(binding.installation, filename);
  const declared = manifest.files.find((file) => file.path === relative);
  if (
    declared?.kind !== "file" ||
    !Number.isSafeInteger(declared.length) ||
    declared.length < 0 ||
    !/^[a-f0-9]{64}$/u.test(declared.sha256 ?? "") ||
    (reference && (declared.sha256 !== reference.sha256 || declared.length !== reference.length))
  ) {
    throw new Error("Live target alias differs from its immutable reviewed reference.");
  }
  const file = { path: filename, sha256: declared.sha256, length: declared.length };
  await bytes(file);
  return file;
}

export async function verifyObservedEntry(mapping, binding) {
  if (mapping.liveTarget) {
    return verifyLiveTargetFile(binding, mapping.liveTarget.entry, mapping.entry);
  }
  await bytes(mapping.entry);
  return undefined;
}

export async function retain(directory, name, value) {
  const handle = await fs.open(path.join(directory, name), "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const parent = await fs.open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function processIdentity(pid) {
  const result = parseObservedProcess(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
  return {
    ...result,
    pid,
    executable: await fs.readlink(`/proc/${pid}/exe`),
    argv: (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean),
    cgroups: (await fs.readFile(`/proc/${pid}/cgroup`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.slice(line.lastIndexOf(":") + 1)),
  };
}
export async function inspectorEndpoint(pid) {
  const inodes = new Set();
  for (const descriptor of await fs.readdir(`/proc/${pid}/fd`)) {
    try {
      const link = await fs.readlink(`/proc/${pid}/fd/${descriptor}`);
      const match = /^socket:\[(\d+)\]$/u.exec(link);
      if (match) {
        inodes.add(match[1]);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const ports = [];
  for (const line of (await fs.readFile(`/proc/${pid}/net/tcp`, "utf8")).split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/u);
    if (parts[3] === "0A" && parts[1]?.startsWith("0100007F:") && inodes.has(parts[9])) {
      ports.push(Number.parseInt(parts[1].split(":")[1], 16));
    }
  }
  const targets = [];
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        for (const target of await response.json()) {
          targets.push(target);
        }
      }
    } catch {
      /* A different bound service is not an inspector. */
    }
  }
  if (targets.length !== 1) {
    throw new Error("Startup gate lacks one process-owned loopback inspector.");
  }
  const url = new URL(targets[0].webSocketDebuggerUrl);
  if (url.hostname !== "127.0.0.1") {
    throw new Error("Inspector escaped loopback.");
  }
  return url.href;
}
export async function verifyArtifacts(binding) {
  for (const artifact of binding.artifacts) {
    await bytes(artifact);
  }
}
/**
 * Parse the bootstrap prefix, never values or runner arguments as native flags.
 * @returns {{ apply: Record<string, (string | boolean)[]>, resume: Record<string, (string | boolean)[]> }}
 */
export function assertNativeObservationSelectors(binding) {
  const switches = new Set(["--release-qualification", "--qualification-inspector"]);
  const parse = (argv) => {
    const selected = new Map();
    for (let index = 1; index < argv.length && argv[index] !== "--"; index++) {
      const flag = argv[index];
      if (!flag.startsWith("--") || flag.includes("=")) {
        throw new Error("Require canonical native flag/value pairs.");
      }
      const value = switches.has(flag) ? true : argv[++index];
      if (value !== true && (!value || value.startsWith("--"))) {
        throw new Error("Missing native flag value.");
      }
      if (selected.has(flag) && flag !== "--workspace") {
        throw new Error("Duplicate native selector.");
      }
      const values = selected.get(flag) ?? [];
      values.push(value);
      selected.set(flag, values);
    }
    return selected;
  };
  const expected = parse([binding.nativeBootstrap.path, ...binding.nativeArguments]);
  const receipt = {};
  for (const operation of ["apply", "resume"]) {
    const argv = binding[operation];
    const selected = parse(argv);
    const one = (flag, value) => isDeepStrictEqual(selected.get(flag), [value]);
    if (argv[0] !== binding.nativeBootstrap.path || !one("--qualification-inspector", true)) {
      throw new Error("Both operations require the exact authenticated native startup gate.");
    }
    if (
      !one("--installation", binding.installation) ||
      [...expected].some(([flag, values]) => !isDeepStrictEqual(selected.get(flag), values)) ||
      (operation === "apply"
        ? !one("--release-qualification", true) ||
          selected.has("--retained-run") ||
          selected.has("--retained-ledger")
        : !one("--retained-run", "{{original-run-id}}") ||
          !one("--retained-ledger", binding.ledger) ||
          selected.has("--release-qualification"))
    ) {
      throw new Error("Require exact initial and original native retained selectors.");
    }
    receipt[operation] = Object.fromEntries(selected);
  }
  return receipt;
}

/** Status may change; original creation time, pointer and authenticated bytes may not. */
export function assertOriginalRetainedCustody(row, binding) {
  const pointer = row?.pointer;
  const authority = pointer?.ledgerAuthority;
  if (
    row?.runId !== binding.originalRunId ||
    !Number.isSafeInteger(row?.createdAtMs) ||
    row.createdAtMs < 0 ||
    !["running", "succeeded"].includes(row?.status) ||
    pointer?.schemaVersion !== 1 ||
    pointer.runId !== row.runId ||
    pointer.originalCreatedAtMs !== row.createdAtMs ||
    authority?.databasePath !== binding.ledger ||
    !/^\d+:\d+$/u.test(authority?.databaseIdentity ?? "") ||
    !/^\d+:\d+$/u.test(authority?.parentIdentity ?? "") ||
    pointer.nativeAuthority?.installKey !== binding.installation ||
    !pointer.envelope
  ) {
    throw new Error("Require actual original ledger/pointer retained custody before kill.");
  }
  return { runId: row.runId, createdAtMs: row.createdAtMs, pointer };
}

async function verifiedRetainedCustody(row, binding) {
  const custody = assertOriginalRetainedCustody(row, binding);
  const authority = custody.pointer.ledgerAuthority;
  for (const [filename, expected] of [authority, custody.pointer.nativeAuthority].flatMap(
    (owner) => [
      [owner.databasePath, owner.databaseIdentity],
      [path.dirname(owner.databasePath), owner.parentIdentity],
    ],
  )) {
    const stat = await fs.lstat(filename, { bigint: true });
    if (stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== expected) {
      throw new Error("Original retained ledger authority changed.");
    }
  }
  const envelope = JSON.parse(await bytes(custody.pointer.envelope));
  const plan = JSON.parse(await bytes(envelope.planArtifact));
  await bytes(envelope.configArtifact);
  const authorization = JSON.parse(await bytes(envelope.authorizationArtifact));
  if (
    envelope.schemaVersion !== 1 ||
    envelope.binding?.runId !== custody.runId ||
    envelope.binding?.installationKey !== binding.installation ||
    !isDeepStrictEqual(envelope.ledgerAuthority, authority) ||
    !isDeepStrictEqual(envelope.nativeAuthority, custody.pointer.nativeAuthority) ||
    !isDeepStrictEqual(plan.maintenance?.binding, envelope.binding) ||
    authorization.digest !== plan.catalogDigest ||
    plan.runner?.manifestDigest !== envelope.runner?.manifestDigest ||
    plan.runner?.closureDigest !== envelope.runner?.closureDigest
  ) {
    throw new Error("Original retained envelope/plan/authorization correspondence changed.");
  }
  return custody;
}

/** Recheck the same captured owner/durable join before kill and during collection.
 * Artifact text is retained verbatim: collection authenticates it by the original pointer,
 * rather than trusting derived action IDs or an observer-authored success flag.
 */
export function assertOwnerObservationProvenance(
  mapping,
  boundary,
  originalRunId,
  observed,
  evidence,
  custody,
) {
  const kind = mapping.facts.kind;
  if (!kind || observed?.kind !== kind || !evidence || !observed.payload) {
    throw new Error("Missing captured owner provenance.");
  }
  const decode = (text, artifact) => {
    if (
      typeof text !== "string" ||
      !artifact ||
      Buffer.byteLength(text) !== artifact.length ||
      sha(Buffer.from(text)) !== artifact.sha256
    ) {
      throw new Error("Owner provenance artifact differs from original retained bytes.");
    }
    return JSON.parse(text);
  };
  const envelope = decode(evidence.envelopeText, custody.pointer.envelope);
  const plan = decode(evidence.planText, envelope.planArtifact);
  const authorization = decode(evidence.authorizationText, envelope.authorizationArtifact);
  if (
    envelope.binding?.runId !== originalRunId ||
    custody.runId !== originalRunId ||
    custody.pointer.runId !== originalRunId ||
    !isDeepStrictEqual(envelope.nativeAuthority, custody.pointer.nativeAuthority) ||
    !isDeepStrictEqual(envelope.ledgerAuthority, custody.pointer.ledgerAuthority) ||
    !isDeepStrictEqual(plan.maintenance?.binding, envelope.binding) ||
    plan.approvedPlanDigest !== envelope.binding.planDigest ||
    plan.approvedPlan?.digest !== envelope.binding.planDigest ||
    authorization.digest !== plan.catalogDigest ||
    plan.runner?.manifestDigest !== envelope.runner?.manifestDigest ||
    plan.runner?.closureDigest !== envelope.runner?.closureDigest
  ) {
    throw new Error("Owner provenance lost original approved plan correspondence.");
  }
  const steps = envelope.stepBindings?.filter((step) => step.stepId === mapping.actionId);
  if (
    steps?.length !== 1 ||
    steps[0].runId !== originalRunId ||
    steps[0].planDigest !== envelope.binding.planDigest ||
    steps[0].adapterId !== mapping.operation ||
    steps[0].recipeId !== plan.route?.recipe?.id ||
    steps[0].recipeRevision !== plan.route?.recipe?.revision ||
    !isDeepStrictEqual(evidence.durable?.stepReceipt?.binding, steps[0]) ||
    !["intent", "verified"].includes(evidence.durable.stepReceipt.phase)
  ) {
    throw new Error("Owner provenance lacks the exact retained action receipt.");
  }
  if (kind === "maintenance-binding") {
    const receipt = evidence.durable.maintenanceReceipt;
    if (
      boundary !== "gate-release" ||
      mapping.operation !== "core.gateway-maintenance" ||
      !isDeepStrictEqual(observed.payload, envelope.binding) ||
      !isDeepStrictEqual(receipt?.binding, envelope.binding) ||
      receipt?.phase !== "commit-intent" ||
      !Number.isSafeInteger(receipt?.revision) ||
      receipt.revision < 1
    ) {
      throw new Error("Maintenance owner differs from the durable original commit intent.");
    }
  } else if (kind === "publication-owner") {
    const record = evidence.durable.publicationRecord;
    const descriptor = observed.payload;
    if (
      boundary !== "package-publication" ||
      mapping.operation !== "core.package-publish" ||
      !isDeepStrictEqual(record?.descriptor, descriptor) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
        descriptor.operationId ?? "",
      ) ||
      !envelope.originalNativeOwner ||
      !isDeepStrictEqual(descriptor.authority, {
        ...envelope.nativeAuthority,
        owner: envelope.originalNativeOwner,
      }) ||
      descriptor.authority.installKey !== envelope.binding.installationKey ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1 ||
      record.phase !== "publishing" ||
      record.intent?.kind !== "publish"
    ) {
      throw new Error("Publication owner differs from the original native journal operation.");
    }
  } else {
    throw new Error("Unknown owner provenance contract.");
  }
  return evidence;
}

export async function probe(binding, verifyEffect = true) {
  await bytes(binding.durableProbe.executable);
  const audit = JSON.parse(await bytes(binding.durableProbe.audit));
  if (
    audit.purpose !== "reviewed-read-only-boundary-probe" ||
    audit.observationId !== binding.runId ||
    audit.originalRunSelector !== "captured-production-uuid" ||
    audit.retainedCustody !== "unique-original-ledger-pointer-row" ||
    audit.ledger !== binding.ledger ||
    audit.boundary !== binding.boundary ||
    audit.side !== binding.side ||
    audit.executableSha256 !== binding.durableProbe.executable.sha256 ||
    !isDeepStrictEqual(
      audit.heldRuntime,
      binding.mappings.find((item) => item.id === binding.selectedMappingId)?.heldRuntime,
    ) ||
    !isDeepStrictEqual(audit.argv, binding.durableProbe.argv) ||
    !isDeepStrictEqual(
      audit.ownerFacts,
      binding.mappings.find((item) => item.id === binding.selectedMappingId)?.facts.kind
        ? binding.mappings.find((item) => item.id === binding.selectedMappingId)?.facts
        : undefined,
    ) ||
    audit.readOnly !== true ||
    !audit.basis
  ) {
    throw new Error("Durable probe lacks exact reviewed read-only semantics.");
  }
  const child = spawn(
    binding.durableProbe.executable.path,
    binding.durableProbe.argv.map((argument) =>
      argument.replaceAll("{{original-run-id}}", binding.originalRunId),
    ),
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = [];
  let size = 0;
  child.stdout.on("data", (chunk) => {
    size += chunk.length;
    if (size <= 1048576) {
      output.push(chunk);
    } else {
      child.kill("SIGKILL");
    }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), binding.timeoutMs);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timer);
  if (code !== 0 || size > 1048576) {
    throw new Error("Read-only durable observation failed.");
  }
  const result = JSON.parse(Buffer.concat(output).toString("utf8"));
  const selected = binding.mappings.find((mapping) => mapping.id === binding.selectedMappingId);
  if (
    result.originalRunId !== binding.originalRunId ||
    result.actionId !== selected.actionId ||
    result.operation !== selected.operation ||
    result.database !== selected.database
  ) {
    throw new Error("Durable probe does not discriminate the original action/operation/database.");
  }
  const resolveExpected = (value) => {
    if (typeof value === "string") {
      return value.replaceAll("{{original-run-id}}", binding.originalRunId);
    }
    if (Array.isArray(value)) {
      return value.map(resolveExpected);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, resolveExpected(item)]),
      );
    }
    return value;
  };
  const { retainedCustody, ownerEvidence, ...effect } = result;
  const custody = await verifiedRetainedCustody(retainedCustody, binding);
  let ownerProvenance;
  if (selected.facts.kind && verifyEffect) {
    const envelopeText = (await bytes(custody.pointer.envelope)).toString("utf8");
    const envelope = JSON.parse(envelopeText);
    ownerProvenance = {
      envelopeText,
      planText: (await bytes(envelope.planArtifact)).toString("utf8"),
      authorizationText: (await bytes(envelope.authorizationArtifact)).toString("utf8"),
      durable: ownerEvidence,
    };
    assertOwnerObservationProvenance(
      selected,
      binding.boundary,
      binding.originalRunId,
      binding.observedFacts,
      ownerProvenance,
      custody,
    );
  }
  if (verifyEffect && !isDeepStrictEqual(effect, resolveExpected(binding.durableProbe.expected))) {
    throw new Error("Durable boundary effect disagrees with reviewed before/after expectation.");
  }
  return { effect, custody, ownerProvenance };
}
export async function protectedInventory(roots) {
  const rows = [];
  const visit = async (filename) => {
    const stat = await fs.lstat(filename);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      rows.push({ path: filename, mode, link: await fs.readlink(filename) });
      return;
    }
    if (stat.isDirectory()) {
      rows.push({ path: filename, mode, directory: true });
      for (const name of (await fs.readdir(filename)).toSorted()) {
        await visit(path.join(filename, name));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error("Protected inventory includes unsupported special file.");
    }
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
      }
      rows.push({ path: filename, mode, size: stat.size, sha256: hash.digest("hex") });
    } finally {
      await handle.close();
    }
  };
  for (const root of roots) {
    if (!root.startsWith("/qualification/") || (await fs.realpath(root)) !== root) {
      throw new Error("Protected roots must be canonical fixture paths.");
    }
    await visit(root);
  }
  return rows;
}
export async function scan() {
  const result = [];
  for (const name of await fs.readdir("/proc")) {
    if (/^\d+$/u.test(name)) {
      try {
        result.push(await processIdentity(Number(name)));
      } catch (error) {
        if (!["ENOENT", "ESRCH", "EINVAL"].includes(error.code)) {
          throw error;
        }
      }
    }
  }
  return result;
}
export async function alive(identity) {
  try {
    const current = await processIdentity(identity.pid);
    return current.startTime === identity.startTime && !["Z", "X"].includes(current.state);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) {
      return false;
    }
    throw error;
  }
}
