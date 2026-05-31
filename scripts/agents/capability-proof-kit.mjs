#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { normalizeAgentOsArtifactContract } = require("../lib/agent-os-contracts.cjs");

export const CAPABILITY_PROOF_SCHEMA_VERSION = "2.0";
export const DEFAULT_CAPABILITY_PROOF_ROOT = path.join(".artifacts", "capability-proofs");
const REQUIRED_PROOF_EVENT_TYPES = [
  "TICKET_TRANSITION",
  "MODEL_CALL",
  "TOOL_CALL",
  "BROWSER_ACTION",
  "MEMORY_WRITE",
  "SIDECAR_HEALTH",
];

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function slug(value, fallback = "proof") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || fallback;
}

function parseJsonMaybe(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizePlainObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return [value];
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resolveProofDir(ticketId, outDir) {
  const root = outDir || DEFAULT_CAPABILITY_PROOF_ROOT;
  const dir = path.join(root, slug(ticketId, "unticketed"));
  ensureDir(dir);
  return dir;
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  return filePath;
}

function attachArtifactContract(record, artifactPath, options = {}) {
  const output = {
    ...record,
    artifactContract: normalizeAgentOsArtifactContract({
      createdBy: options.createdBy || "capability-proof-kit",
      kind: options.kind || record.kind || "artifact",
      mediaType: options.mediaType || "application/json",
      path: artifactPath,
      runId: record.runId,
      ticketId: record.ticketId,
    }),
    artifactPath,
  };
  writeJson(artifactPath, output);
  return output;
}

function writeHtml(filePath, title, body) {
  ensureDir(path.dirname(filePath));
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f0e8;
      --ink: #1f2421;
      --line: #d7c8b8;
      --accent: #0f766e;
      --warn: #b45309;
      --fail: #b91c1c;
      --card: #fffaf2;
    }
    body {
      background: radial-gradient(circle at top left, #ffffff 0, var(--bg) 32rem);
      color: var(--ink);
      font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
      margin: 0;
      padding: 2rem;
    }
    main {
      display: grid;
      gap: 1rem;
      max-width: 1100px;
    }
    h1, h2 {
      margin: 0;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: 0 18px 50px rgb(52 42 31 / 10%);
      padding: 1rem;
    }
    .grid {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }
    .metric {
      border-left: 5px solid var(--accent);
      padding-left: 0.75rem;
    }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }
    pre {
      overflow: auto;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>
`;
  fs.writeFileSync(filePath, html);
  return filePath;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[,\n]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeSource(source) {
  if (typeof source === "string") {
    return { title: source, url: source };
  }
  return {
    archivedAt: source.archivedAt || null,
    archiveUrl: source.archiveUrl || null,
    citation: source.citation || null,
    fetchedAt: source.fetchedAt || null,
    title: source.title || source.url || "untitled source",
    url: source.url || null,
  };
}

function normalizeProofEvent(event) {
  const payload = event.payload === undefined ? null : event.payload;
  return {
    artifactPath: event.artifact_path || event.artifactPath || null,
    category: event.category || inferProofEventCategory(event.event_type || event.eventType),
    component: event.component || event.componentName || "unknown",
    createdAt: event.created_at || event.createdAt || null,
    eventType: event.event_type || event.eventType || "PROOF_EVENT",
    id: event.id || null,
    payload,
    runId: event.run_id || event.runId || null,
    status: event.status || "INFO",
    summary: event.summary || null,
    ticketId: event.ticket_id || event.ticketId || null,
  };
}

function inferProofEventCategory(eventType) {
  const normalized = String(eventType || "").toUpperCase();
  if (normalized.includes("MODEL")) {
    return "model";
  }
  if (normalized.includes("TOOL")) {
    return "tool";
  }
  if (normalized.includes("BROWSER")) {
    return "browser";
  }
  if (
    normalized.includes("MEMORY") ||
    normalized.includes("WIKI") ||
    normalized.includes("OBSIDIAN")
  ) {
    return "memory";
  }
  if (
    normalized.includes("SIDECAR") ||
    normalized.includes("SIGNAL") ||
    normalized.includes("HEALTH")
  ) {
    return "sidecar";
  }
  if (normalized.includes("TICKET")) {
    return "ticket";
  }
  if (normalized.includes("SECURITY") || normalized.includes("BOUNCE")) {
    return "security";
  }
  if (normalized.includes("RESEARCH") || normalized.includes("CITATION")) {
    return "research";
  }
  return "general";
}

function percentile(values, percent) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[index];
}

function defaultPolicyGate(action, fallback = "approval-required") {
  return {
    action,
    defaultMode: fallback,
    operatorOverride: true,
    reversible: true,
  };
}

function normalizeConnector(connector) {
  if (typeof connector === "string") {
    return { id: connector, mode: "configured" };
  }
  const value = normalizePlainObject(connector);
  return {
    authBoundary: value.authBoundary || "operator-scoped",
    id: value.id || value.name || "connector",
    mode: value.mode || "configured",
    sourceType: value.sourceType || value.type || "unknown",
  };
}

function normalizeDataset(dataset) {
  if (typeof dataset === "string") {
    return { id: dataset, mode: "read-only" };
  }
  const value = normalizePlainObject(dataset);
  return {
    id: value.id || value.name || "dataset",
    mode: value.mode || "read-only",
    provenance: value.provenance || value.source || null,
  };
}

function normalizeAction(action, index) {
  if (typeof action === "string") {
    return { id: `action-${index + 1}`, kind: "note", summary: action };
  }
  const value = normalizePlainObject(action);
  return {
    id: value.id || `action-${index + 1}`,
    kind: value.kind || value.type || "browser-action",
    selector: value.selector || null,
    status: value.status || "INFO",
    summary: value.summary || value.description || null,
    timestamp: value.timestamp || value.createdAt || null,
  };
}

function normalizeSandboxMount(mount) {
  if (typeof mount === "string") {
    return {
      containerPath: mount,
      hostPathPolicy: "operator-configured",
      mode: "read-write",
    };
  }
  const value = normalizePlainObject(mount);
  return {
    containerPath: value.containerPath || value.target || value.path || null,
    hostPathPolicy: value.hostPathPolicy || value.sourcePolicy || "operator-configured",
    mode: value.mode || "read-write",
    purpose: value.purpose || null,
  };
}

function normalizeEvalResult(result) {
  const value = normalizePlainObject(result);
  return {
    id: value.id || value.name || "eval",
    metric: value.metric || "quality",
    score: normalizeNumber(value.score, 0),
    status: value.status || (normalizeNumber(value.score, 0) >= 0.8 ? "PASS" : "WARN"),
  };
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

export function createProofEventBundle(options) {
  const ticketId = options.ticketId || "unticketed";
  const generatedAt = options.generatedAt || nowIso();
  const runId = options.runId || `run-${stableHash({ generatedAt, ticketId }).slice(0, 12)}`;
  const requiredEventTypes =
    normalizeStringList(options.requiredEventTypes).length > 0
      ? normalizeStringList(options.requiredEventTypes)
      : REQUIRED_PROOF_EVENT_TYPES;
  const events = normalizeArray(options.events).map((event, index) => {
    const normalized = normalizeProofEvent(event);
    return Object.assign({}, normalized, {
      category: normalized.category || inferProofEventCategory(normalized.eventType),
      createdAt: normalized.createdAt || generatedAt,
      id: normalized.id || `${runId}-${index + 1}`,
      runId: normalized.runId || runId,
      ticketId: normalized.ticketId || ticketId,
    });
  });
  const presentEventTypes = new Set(events.map((event) => event.eventType));
  const missingRequiredEventTypes = requiredEventTypes.filter(
    (eventType) => !presentEventTypes.has(eventType),
  );
  const bundle = {
    coverage: {
      byCategory: countBy(events, (event) => event.category),
      byComponent: countBy(events, (event) => event.component),
      byEventType: countBy(events, (event) => event.eventType),
      byStatus: countBy(events, (event) => event.status),
    },
    events,
    generatedAt,
    kind: "proof-events-bundle",
    missingRequiredEventTypes,
    requiredEventTypes,
    runId,
    schemaVersion: CAPABILITY_PROOF_SCHEMA_VERSION,
    ticketId,
  };
  const dir = resolveProofDir(ticketId, options.outDir);
  const artifactPath = writeJson(path.join(dir, "proof-events-bundle.json"), bundle);
  return attachArtifactContract(bundle, artifactPath, { kind: "proof-bundle" });
}

export function createBrowserProofBundle(options) {
  const ticketId = options.ticketId || "unticketed";
  const generatedAt = options.generatedAt || nowIso();
  const dir = resolveProofDir(ticketId, options.outDir);
  const actions = normalizeArray(options.actions).map(normalizeAction);
  const session = {
    isolation: "browser-context",
    owner: "operator",
    retention: "artifact-only",
    ...normalizePlainObject(options.session),
  };
  const handoff = options.handoff
    ? {
        mode: "operator-visible",
        required: true,
        ...normalizePlainObject(options.handoff),
      }
    : {
        mode: "not-required",
        required: false,
      };
  const privacy = {
    noSecretPrinting: true,
    redactCookies: true,
    redactHeaders: ["authorization", "cookie", "set-cookie"],
    ...normalizePlainObject(options.privacy),
  };
  const bundle = {
    accountBoundary: options.accountBoundary || {
      credentialMode: "operator-owned",
      sessionPolicy: "no-secret-printing",
    },
    actionLogPath: options.actionLogPath || null,
    actions,
    assertions: normalizeStringList(options.assertions || options.assertion),
    downloads: normalizeArray(options.downloads),
    generatedAt,
    handoff,
    kind: "browser-proof-bundle",
    networkLogPath: options.networkLogPath || null,
    pageSummary: options.pageSummary || null,
    privacy,
    requests: normalizeArray(options.requests),
    risk: {
      authorizedAutomation: options.authorizedAutomation !== false,
      stealthMode: false,
      ...normalizePlainObject(options.risk),
    },
    schemaVersion: CAPABILITY_PROOF_SCHEMA_VERSION,
    screenshotPath: options.screenshotPath || null,
    session,
    snapshotPath: options.snapshotPath || null,
    ticketId,
    trace: {
      path: options.tracePath || null,
      viewer: options.traceViewer || "playwright-trace-viewer-compatible",
    },
    tracePath: options.tracePath || null,
    videoPath: options.videoPath || null,
  };
  bundle.bundleId = stableHash(bundle).slice(0, 16);
  const artifactPath = writeJson(path.join(dir, "browser-proof-bundle.json"), bundle);
  return attachArtifactContract(bundle, artifactPath, { kind: "browser-proof-bundle" });
}

export function createResearchCacheEntry(options) {
  const ticketId = options.ticketId || "unticketed";
  const generatedAt = options.generatedAt || nowIso();
  const query = options.query || "";
  const sources = (options.sources || []).map(normalizeSource);
  const citations = options.citations || sources.map((source) => source.citation).filter(Boolean);
  const archiveHits = options.archiveHits || sources.filter((source) => source.archiveUrl);
  const connectors = normalizeArray(options.connectors).map(normalizeConnector);
  const datasets = normalizeArray(options.datasets).map(normalizeDataset);
  const retrieval = {
    cacheHits: archiveHits.length,
    connectorCount: connectors.length,
    datasetCount: datasets.length,
    sourceCount: sources.length,
    ...normalizePlainObject(options.retrieval),
  };
  const cacheKey = stableHash({
    citations,
    connectors,
    datasets,
    query,
    sources: sources.map((source) => source.url || source.title),
  }).slice(0, 24);
  const entry = {
    archive: {
      hitCount: archiveHits.length,
      hits: archiveHits,
    },
    cacheKey,
    citations,
    confidence: {
      level: options.confidence?.level || (citations.length > 0 ? "medium" : "low"),
      rationale: options.confidence?.rationale || null,
      score: normalizeNumber(options.confidence?.score, citations.length > 0 ? 0.65 : 0.25),
    },
    connectors,
    datasets,
    freshness: {
      checkedAt: generatedAt,
      maxSourceAgeDays: normalizeNumber(options.freshness?.maxSourceAgeDays, 30),
      mode: options.freshness?.mode || "timestamped-cache",
    },
    generatedAt,
    kind: "research-citation-cache",
    privateSourceBoundary: {
      localFirst: true,
      noPrivateSourceUpload: true,
      ...normalizePlainObject(options.privateSourceBoundary),
    },
    query,
    quoteBudget: {
      maxQuotedWordsPerSource: normalizeNumber(options.quoteBudget?.maxQuotedWordsPerSource, 25),
      policy: options.quoteBudget?.policy || "copyright-safe-excerpts",
    },
    retrieval,
    schemaVersion: CAPABILITY_PROOF_SCHEMA_VERSION,
    searxng: {
      baseUrl: options.searxngBaseUrl || process.env.OPENCLAW_SEARXNG_URL || null,
      mode:
        options.searxngBaseUrl || process.env.OPENCLAW_SEARXNG_URL ? "configured" : "offline-cache",
    },
    sources,
    ticketId,
  };
  const dir = resolveProofDir(ticketId, options.outDir);
  const artifactPath = writeJson(path.join(dir, `research-cache-${cacheKey}.json`), entry);
  return attachArtifactContract(entry, artifactPath, { kind: "research-citation-cache" });
}

export function createSecurityBouncerDecision(options) {
  const ticketId = options.ticketId || "unticketed";
  const decision = options.decision || {};
  const detection = options.detection || {};
  const bounce = options.bounce || {};
  const repair = options.repair || {};
  const status = decision.status || (repair.applied ? "PASS" : bounce.action ? "ACTION" : "INFO");
  const policyGates = {
    bounce: defaultPolicyGate("bounce"),
    repair: defaultPolicyGate("repair"),
    rollback: defaultPolicyGate("rollback", "automatic-when-repair-applied"),
    ...normalizePlainObject(options.policyGates || options.policyGate),
  };
  const proof = {
    approvals: options.approvals || [],
    bounce,
    decision,
    detection,
    generatedAt: options.generatedAt || nowIso(),
    kind: "security-bouncer-decision",
    phases: {
      bounce: {
        action: bounce.action || null,
        gate: policyGates.bounce,
        status: bounce.action ? "READY" : "SKIPPED",
        target: bounce.target || null,
      },
      decide: {
        reason: decision.reason || null,
        status: decision.status || status,
      },
      detect: {
        rule: detection.rule || null,
        severity: detection.severity || "unknown",
        status: detection.rule ? "PASS" : "INFO",
      },
      repair: {
        applied: repair.applied === true,
        command: repair.command || null,
        gate: policyGates.repair,
        status: repair.applied ? "PASS" : repair.command ? "READY" : "SKIPPED",
      },
      rollback: {
        command: options.rollback?.command || null,
        gate: policyGates.rollback,
        status: options.rollback ? "READY" : "SKIPPED",
      },
    },
    policyGates,
    repair,
    rollback: options.rollback || null,
    schemaVersion: CAPABILITY_PROOF_SCHEMA_VERSION,
    status,
    ticketId,
  };
  const dir = resolveProofDir(ticketId, options.outDir);
  const artifactPath = writeJson(path.join(dir, "security-bouncer-decision.json"), proof);
  return attachArtifactContract(proof, artifactPath, { kind: "security-bouncer-decision" });
}

export function createWorkflowCanvas(options) {
  const ticketId = options.ticketId || "workflow";
  const proofEvents = (options.proofEvents || []).map(normalizeProofEvent);
  const tickets = options.tickets || [];
  const agents = options.agents || [];
  const sidecars = options.sidecars || [];
  const approvals = normalizeArray(options.approvals);
  const proofRequirements = normalizeStringList(options.proofRequirements);
  const replayPaths = normalizeArray(options.replayPaths);
  const nodes = [];
  const edges = [];

  for (const ticket of tickets) {
    nodes.push({
      id: `ticket:${ticket.id || ticket.ticketId}`,
      kind: "ticket",
      label: ticket.title || ticket.type || ticket.id || ticket.ticketId,
      status: ticket.status || "unknown",
    });
  }
  for (const agent of agents) {
    nodes.push({
      id: `agent:${agent.id || agent}`,
      kind: "agent",
      label: agent.label || agent.id || agent,
    });
  }
  for (const sidecar of sidecars) {
    nodes.push({
      id: `sidecar:${sidecar.id || sidecar}`,
      kind: "sidecar",
      label: sidecar.label || sidecar.id || sidecar,
    });
  }
  for (const event of proofEvents) {
    const eventId = `event:${event.id || stableHash(event).slice(0, 12)}`;
    nodes.push({
      id: eventId,
      kind: "proof-event",
      label: event.eventType,
      status: event.status,
    });
    if (event.ticketId) {
      edges.push({ from: `ticket:${event.ticketId}`, kind: "proved-by", to: eventId });
    }
    if (event.component) {
      edges.push({ from: `sidecar:${event.component}`, kind: "emitted", to: eventId });
    }
  }
  for (const approval of approvals) {
    const value = normalizePlainObject(approval);
    const approvalId = `approval:${value.id || stableHash(value).slice(0, 12)}`;
    nodes.push({
      id: approvalId,
      kind: "approval",
      label: value.label || value.reason || "approval",
      status: value.status || "pending",
    });
    if (value.ticketId) {
      edges.push({ from: `ticket:${value.ticketId}`, kind: "requires-approval", to: approvalId });
    }
  }
  for (const replayPath of replayPaths) {
    const value = normalizePlainObject(replayPath);
    const replayId = `replay:${value.id || stableHash(value).slice(0, 12)}`;
    nodes.push({
      id: replayId,
      kind: "replay-path",
      label: value.label || value.command || "replay path",
      status: value.status || "ready",
    });
    if (value.ticketId) {
      edges.push({ from: replayId, kind: "replays", to: `ticket:${value.ticketId}` });
    }
  }

  const canvas = {
    approvals,
    edges,
    generatedAt: options.generatedAt || nowIso(),
    kind: "workflow-canvas",
    nodes,
    proofRequirements,
    replayPaths,
    schemaVersion: CAPABILITY_PROOF_SCHEMA_VERSION,
    ticketId,
  };
  const dir = resolveProofDir(ticketId, options.outDir);
  const artifactPath = writeJson(path.join(dir, "workflow-canvas.json"), canvas);
  const htmlPath = writeHtml(
    path.join(dir, "workflow-canvas.html"),
    "OpenClaw Workflow Canvas",
    `<h1>OpenClaw Workflow Canvas</h1>
<section class="grid">
  <div class="card metric"><h2>${nodes.length}</h2><p>nodes</p></div>
  <div class="card metric"><h2>${edges.length}</h2><p>edges</p></div>
  <div class="card metric"><h2>${proofEvents.length}</h2><p>proof events</p></div>
</section>
<section class="card"><h2>Canvas JSON</h2><pre>${escapeHtml(JSON.stringify(canvas, null, 2))}</pre></section>`,
  );
  return { ...attachArtifactContract(canvas, artifactPath, { kind: "workflow-canvas" }), htmlPath };
}

export function createSandboxProviderContract(options) {
  const provider = normalizePlainObject(options.provider || options);
  const ticketId = options.ticketId || provider.id || provider.name || "sandbox-provider";
  const runtime = {
    containerImage: provider.containerImage || options.containerImage || null,
    node: provider.node || options.node || "22.19+",
    packageManager: provider.packageManager || options.packageManager || "pnpm",
    python: provider.python || options.python || "3.11+",
    shell: provider.shell || options.shell || "posix-or-powershell",
    ...normalizePlainObject(provider.runtime || options.runtime),
  };
  const workspaceMounts = normalizeArray(provider.workspaceMounts || options.workspaceMounts).map(
    normalizeSandboxMount,
  );
  const networkPolicy = {
    default: "deny-except-declared",
    secretsPolicy: "never-print",
    ...normalizePlainObject(provider.networkPolicy || options.networkPolicy),
  };
  const artifactExport = {
    paths: normalizeStringList(provider.artifactExport?.paths || options.artifactExport?.paths),
    redaction: "secret-safe",
    ...normalizePlainObject(provider.artifactExport || options.artifactExport),
  };
  const cleanup = {
    mode: "ephemeral-or-reversible",
    removeTempDirs: true,
    ...normalizePlainObject(provider.cleanup || options.cleanup),
  };
  const proofCommand = provider.proofCommand || options.proofCommand || null;
  const missing = [];
  if (!runtime.node && !runtime.python && !runtime.containerImage) {
    missing.push("runtime");
  }
  if (workspaceMounts.length === 0) {
    missing.push("workspaceMounts");
  }
  if (!proofCommand) {
    missing.push("proofCommand");
  }
  if (!artifactExport.paths || artifactExport.paths.length === 0) {
    missing.push("artifactExport.paths");
  }
  if (!networkPolicy.default) {
    missing.push("networkPolicy");
  }
  if (!cleanup.mode) {
    missing.push("cleanup");
  }
  const contract = {
    artifactExport,
    cleanup,
    generatedAt: options.generatedAt || nowIso(),
    id: provider.id || options.id || "sandbox-provider",
    kind: "sandbox-provider-contract",
    missing,
    networkPolicy,
    os: normalizeStringList(provider.os || options.os || ["linux", "macos", "windows"]),
    proofCommand,
    runtime,
    schemaVersion: CAPABILITY_PROOF_SCHEMA_VERSION,
    status: missing.length === 0 ? "ready" : "review",
    ticketId,
    workspaceMounts,
  };
  const dir = resolveProofDir(ticketId, options.outDir);
  const artifactPath = writeJson(path.join(dir, "sandbox-provider-contract.json"), contract);
  return attachArtifactContract(contract, artifactPath, { kind: "sandbox-provider-contract" });
}

function licenseScore(license) {
  const normalized = String(license || "")
    .trim()
    .toLowerCase();
  if (["mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc"].includes(normalized)) {
    return { points: 15, risk: "low" };
  }
  if (normalized.includes("agpl") || normalized.includes("gpl")) {
    return { points: 5, risk: "sidecar-required" };
  }
  if (normalized) {
    return { points: 8, risk: "review" };
  }
  return { points: 0, risk: "unknown-license" };
}

export function scoreMarketplaceCapability(options) {
  const manifest = options.manifest || options;
  const missing = [];
  const warnings = [];
  const license = licenseScore(manifest.license);
  let score = license.points;
  if (manifest.proofCommand) {
    score += 20;
  } else {
    missing.push("proofCommand");
  }
  if (manifest.rollback || manifest.reversible === true) {
    score += 15;
  } else {
    missing.push("rollback");
  }
  if (manifest.auth?.mode === "scoped" || manifest.auth === "scoped") {
    score += 15;
  } else {
    missing.push("scopedAuth");
  }
  const osTargets = normalizeStringList(manifest.os || manifest.platforms);
  if (osTargets.length >= 3) {
    score += 10;
  } else if (osTargets.length > 0) {
    score += 5;
  } else {
    missing.push("os");
  }
  if (manifest.sideEffects || manifest.permissions) {
    score += 10;
  } else {
    missing.push("sideEffects");
  }
  if (manifest.sandbox === "container" || manifest.sandbox?.mode === "container") {
    score += 15;
  } else if (manifest.sandbox) {
    score += 8;
  } else {
    missing.push("sandbox");
  }

  const sandboxProvider = normalizePlainObject(manifest.sandboxProvider, null);
  const proofEvents = normalizePlainObject(manifest.proofEvents, null);
  const evals = normalizePlainObject(manifest.evals, null);
  const compatibilitySignals = {
    evalCommand: Boolean(evals?.command || manifest.evalCommand),
    proofEvents: Boolean(proofEvents?.required || manifest.proofEventsRequired),
    sandboxProvider: sandboxProvider?.status === "ready" || manifest.sandboxProvider === "ready",
  };
  if (!compatibilitySignals.proofEvents) {
    warnings.push("proofEvents");
  }
  if (!compatibilitySignals.sandboxProvider) {
    warnings.push("sandboxProvider");
  }
  if (!compatibilitySignals.evalCommand) {
    warnings.push("evalCommand");
  }

  const compatibilityScore = Math.max(0, Math.min(100, score));
  const riskClass =
    missing.length === 0 && license.risk === "low"
      ? "ready"
      : compatibilityScore >= 70
        ? "review"
        : "blocked";
  return {
    compatibilityScore,
    id: manifest.id || manifest.name || "unknown",
    licenseRisk: license.risk,
    missing,
    compatibilitySignals,
    riskClass,
    schemaVersion: CAPABILITY_PROOF_SCHEMA_VERSION,
    warnings,
  };
}

export function createObservabilityReport(options) {
  const ticketId = options.ticketId || "observability";
  const proofEvents = (options.proofEvents || []).map(normalizeProofEvent);
  const evals = normalizeArray(options.evals).map(normalizeEvalResult);
  const latencyMs = normalizeArray(options.latencyMs || options.latency).map((value) =>
    normalizeNumber(value, 0),
  );
  const costs = normalizeArray(options.costs || options.costUsd).map((value) =>
    normalizeNumber(value, 0),
  );
  const retries = normalizeArray(options.retries);
  const recovery = normalizeArray(options.recovery || options.recoveries);
  const byStatus = countBy(proofEvents, (event) => event.status);
  const byComponent = countBy(proofEvents, (event) => event.component);
  const byEventType = countBy(proofEvents, (event) => event.eventType);
  const failedEvents = proofEvents.filter((event) => event.status === "FAIL");
  const passEvents = proofEvents.filter((event) => event.status === "PASS");
  const evalPasses = evals.filter((entry) => entry.status === "PASS");
  const report = {
    byComponent,
    byEventType,
    byStatus,
    evals,
    failedEvents,
    generatedAt: options.generatedAt || nowIso(),
    kind: "observability-eval-dashboard",
    metrics: {
      averageCostUsd:
        costs.length === 0 ? 0 : costs.reduce((sum, value) => sum + value, 0) / costs.length,
      evalPassRate: evals.length === 0 ? null : evalPasses.length / evals.length,
      eventPassRate: proofEvents.length === 0 ? null : passEvents.length / proofEvents.length,
      p50LatencyMs: percentile(latencyMs, 50),
      p95LatencyMs: percentile(latencyMs, 95),
      recoveryCount: recovery.length,
      retryCount: retries.length,
      totalCostUsd: costs.reduce((sum, value) => sum + value, 0),
    },
    recovery,
    retries,
    schemaVersion: CAPABILITY_PROOF_SCHEMA_VERSION,
    ticketCount: new Set(proofEvents.map((event) => event.ticketId).filter(Boolean)).size,
    ticketId,
    totalEvents: proofEvents.length,
  };
  const dir = resolveProofDir(ticketId, options.outDir);
  const artifactPath = writeJson(path.join(dir, "observability-report.json"), report);
  const htmlPath = writeHtml(
    path.join(dir, "observability-dashboard.html"),
    "OpenClaw Observability Dashboard",
    `<h1>OpenClaw Observability Dashboard</h1>
<section class="grid">
  <div class="card metric"><h2>${report.totalEvents}</h2><p>proof events</p></div>
  <div class="card metric"><h2>${report.ticketCount}</h2><p>tickets</p></div>
  <div class="card metric"><h2>${failedEvents.length}</h2><p>failures</p></div>
  <div class="card metric"><h2>${report.metrics.retryCount}</h2><p>retries</p></div>
  <div class="card metric"><h2>${report.metrics.recoveryCount}</h2><p>recoveries</p></div>
  <div class="card metric"><h2>${report.metrics.p95LatencyMs}</h2><p>p95 latency ms</p></div>
</section>
<section class="card"><h2>Status</h2><pre>${escapeHtml(JSON.stringify(byStatus, null, 2))}</pre></section>
<section class="card"><h2>Components</h2><pre>${escapeHtml(JSON.stringify(byComponent, null, 2))}</pre></section>
<section class="card"><h2>Event Types</h2><pre>${escapeHtml(JSON.stringify(byEventType, null, 2))}</pre></section>
<section class="card"><h2>Metrics</h2><pre>${escapeHtml(JSON.stringify(report.metrics, null, 2))}</pre></section>`,
  );
  return {
    ...attachArtifactContract(report, artifactPath, { kind: "observability-report" }),
    htmlPath,
  };
}

function getArg(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
}

function loadEventsArg(args) {
  const eventsFile = getArg(args, "--proof-events");
  if (!eventsFile) {
    return [];
  }
  const loaded = readJsonFile(eventsFile);
  return Array.isArray(loaded) ? loaded : loaded.events || [];
}

function loadJsonArg(args, flag, fallback) {
  const value = getArg(args, flag);
  if (!value) {
    return fallback;
  }
  if (fs.existsSync(value)) {
    return readJsonFile(value);
  }
  return parseJsonMaybe(value, fallback);
}

export async function runCapabilityProofKitCli(args = process.argv.slice(2)) {
  const command = args[0];
  if (!command || command === "help" || command === "--help") {
    console.log(
      [
        "OpenClaw capability proof kit",
        "Commands:",
        "  proof-events-bundle --ticket <id> --proof-events events.json",
        "  browser-bundle --ticket <id> [--snapshot path] [--screenshot path] [--trace path]",
        "  research-cache --ticket <id> --query <text> [--source url] [--citation text]",
        "  security-decision --ticket <id> [--detection json] [--decision json]",
        "  sandbox-contract --manifest sandbox-provider.json",
        "  workflow-canvas --proof-events events.json",
        "  marketplace-score --manifest manifest.json",
        "  observability-report --proof-events events.json",
      ].join(os.EOL),
    );
    return;
  }

  const outDir = getArg(args, "--out") || undefined;
  if (command === "proof-events-bundle") {
    console.log(
      JSON.stringify(
        createProofEventBundle({
          events: loadEventsArg(args),
          outDir,
          requiredEventTypes: normalizeStringList(getArg(args, "--required")),
          runId: getArg(args, "--run"),
          ticketId: getArg(args, "--ticket"),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "browser-bundle") {
    console.log(
      JSON.stringify(
        createBrowserProofBundle({
          actionLogPath: getArg(args, "--actions"),
          actions: loadJsonArg(args, "--actions-json", []),
          accountBoundary: loadJsonArg(args, "--account-boundary", null),
          assertions: normalizeStringList(getArg(args, "--assert")),
          downloads: loadJsonArg(args, "--downloads", []),
          handoff: loadJsonArg(args, "--handoff", null),
          networkLogPath: getArg(args, "--network"),
          outDir,
          pageSummary: getArg(args, "--page-summary"),
          requests: loadJsonArg(args, "--requests", []),
          session: loadJsonArg(args, "--session", null),
          screenshotPath: getArg(args, "--screenshot"),
          snapshotPath: getArg(args, "--snapshot"),
          ticketId: getArg(args, "--ticket"),
          tracePath: getArg(args, "--trace"),
          videoPath: getArg(args, "--video"),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "research-cache") {
    const source = getArg(args, "--source");
    const citation = getArg(args, "--citation");
    console.log(
      JSON.stringify(
        createResearchCacheEntry({
          citations: citation ? [citation] : [],
          connectors: loadJsonArg(args, "--connectors", []),
          datasets: loadJsonArg(args, "--datasets", []),
          outDir,
          privateSourceBoundary: loadJsonArg(args, "--private-source-boundary", null),
          query: getArg(args, "--query"),
          searxngBaseUrl: getArg(args, "--searxng"),
          sources: source ? [{ citation, url: source }] : [],
          ticketId: getArg(args, "--ticket"),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "security-decision") {
    console.log(
      JSON.stringify(
        createSecurityBouncerDecision({
          bounce: parseJsonMaybe(getArg(args, "--bounce"), {}),
          decision: parseJsonMaybe(getArg(args, "--decision"), {}),
          detection: parseJsonMaybe(getArg(args, "--detection"), {}),
          outDir,
          policyGates: parseJsonMaybe(getArg(args, "--policy-gates"), {}),
          repair: parseJsonMaybe(getArg(args, "--repair"), {}),
          rollback: parseJsonMaybe(getArg(args, "--rollback"), null),
          ticketId: getArg(args, "--ticket"),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "sandbox-contract") {
    const manifestPath = getArg(args, "--manifest");
    const manifest = manifestPath
      ? readJsonFile(manifestPath)
      : loadJsonArg(args, "--contract", {});
    console.log(
      JSON.stringify(
        createSandboxProviderContract({
          outDir,
          provider: manifest,
          ticketId: getArg(args, "--ticket") || manifest.id,
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "workflow-canvas") {
    console.log(
      JSON.stringify(
        createWorkflowCanvas({
          agents: parseJsonMaybe(getArg(args, "--agents"), []),
          approvals: loadJsonArg(args, "--approvals", []),
          outDir,
          proofEvents: loadEventsArg(args),
          proofRequirements: normalizeStringList(getArg(args, "--proof-requirements")),
          replayPaths: loadJsonArg(args, "--replay-paths", []),
          sidecars: parseJsonMaybe(getArg(args, "--sidecars"), []),
          ticketId: getArg(args, "--ticket") || "workflow",
          tickets: parseJsonMaybe(getArg(args, "--tickets"), []),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "marketplace-score") {
    const manifestPath = getArg(args, "--manifest");
    if (!manifestPath) {
      throw new Error("--manifest is required");
    }
    console.log(
      JSON.stringify(scoreMarketplaceCapability({ manifest: readJsonFile(manifestPath) }), null, 2),
    );
    return;
  }
  if (command === "observability-report") {
    console.log(
      JSON.stringify(
        createObservabilityReport({
          costs: loadJsonArg(args, "--costs", []),
          evals: loadJsonArg(args, "--evals", []),
          latencyMs: loadJsonArg(args, "--latency-ms", []),
          outDir,
          proofEvents: loadEventsArg(args),
          recovery: loadJsonArg(args, "--recovery", []),
          retries: loadJsonArg(args, "--retries", []),
          ticketId: getArg(args, "--ticket") || "observability",
        }),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(`Unsupported command: ${command}`);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  runCapabilityProofKitCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
