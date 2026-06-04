#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

const REQUIRED_SCHEMA_PATHS = [
  "schemas/workflow_run.schema.json",
  "schemas/queue_item.schema.json",
  "schemas/artifact_manifest.schema.json",
  "schemas/validation_result.schema.json",
  "schemas/policy_decision.schema.json",
];

const ALLOWED_REGISTRY_STATUSES = new Set(["active", "deprecated", "experimental", "blocked"]);
const ALLOWED_POLICY_DECISIONS = new Set(["allow", "deny", "review_required"]);
const REQUIRED_COMPONENT_KEYS = [
  "contract",
  "schema",
  "validator",
  "queue",
  "runner",
  "scheduler",
  "orchestrator",
  "artifact_store",
  "registry",
  "policy_engine",
  "secret_manager",
  "connector",
  "sandbox",
  "test_suite",
  "observability_layer",
  "dashboard",
  "review_workbench",
  "diff_tool",
  "cache",
  "cost_monitor",
  "knowledge_index",
  "ontology_or_taxonomy",
  "promotion_gate",
  "fallback_mode",
  "ledger",
];
const ALLOWED_COMPONENT_STATES = new Set([
  "used",
  "not_required",
  "manual_only",
  "future_tranche",
  "blocked",
]);

const findings = [];

function pathInRepo(relativePath) {
  return path.join(repoRoot, relativePath);
}

function exists(relativePath) {
  return fs.existsSync(pathInRepo(relativePath));
}

function listFilesRecursively(relativeDir) {
  const root = pathInRepo(relativeDir);
  if (!fs.existsSync(root)) {
    return [];
  }

  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out;
}

function toRepoRelative(absolutePath) {
  return path.relative(repoRoot, absolutePath).replaceAll(path.sep, "/");
}

function addFinding(severity, message, relativePath = null) {
  findings.push({
    severity,
    message,
    path: relativePath,
  });
}

function readJsonSafe(relativePath) {
  try {
    const raw = fs.readFileSync(pathInRepo(relativePath), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    addFinding(
      "error",
      `Invalid or unreadable JSON: ${String(error.message ?? error)}`,
      relativePath,
    );
    return null;
  }
}

function isPathLike(value) {
  return (
    typeof value === "string" &&
    (value.includes("/") ||
      value.endsWith(".json") ||
      value.endsWith(".cjs") ||
      value.endsWith(".md") ||
      value.endsWith(".sh"))
  );
}

function checkRequiredPaths() {
  const requiredFiles = [
    "docs/contracts/OPENCLAW_ECOSYSTEM_CONTROL_PLANE_CONTRACT.md",
    "docs/contracts/OPENCLAW_OPERATIONAL_GATE_CONTRACT.md",
    "registries/contracts.registry.json",
    "registries/workflows.registry.json",
    "registries/schemas.registry.json",
    "registries/validators.registry.json",
    "registries/policies.registry.json",
    "schemas/workflow_run.schema.json",
    "schemas/queue_item.schema.json",
    "schemas/artifact_manifest.schema.json",
    "schemas/validation_result.schema.json",
    "schemas/policy_decision.schema.json",
    "scripts/openclaw-doctor-lint.sh",
    "scripts/openclaw-post-upgrade-gate.sh",
    "scripts/openclaw-deep-scan.sh",
    "scripts/openclaw-safe-repair.sh",
    "scripts/append_operational_ledger.cjs",
    "scripts/validate_openclaw_control_plane.cjs",
    ".github/workflows/control-plane-validate.yml",
  ];

  const requiredDirs = ["reports/openclaw-doctor", "reports/validation", "ledgers", "artifacts"];

  for (const filePath of requiredFiles) {
    if (!exists(filePath)) {
      addFinding("error", "Required file is missing.", filePath);
    }
  }

  for (const dirPath of requiredDirs) {
    const absolute = pathInRepo(dirPath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      addFinding("error", "Required directory is missing.", dirPath);
    }
  }
}

function enforceStatusValues(entries, registryPath) {
  for (const entry of entries) {
    if (!entry.status) {
      addFinding("error", "Registry item is missing status.", registryPath);
      continue;
    }
    if (!ALLOWED_REGISTRY_STATUSES.has(entry.status)) {
      addFinding(
        "error",
        `Registry item uses invalid status: ${String(entry.status)}.`,
        registryPath,
      );
    }
  }
}

function enforcePathResolution(entries, registryPath, key = "path") {
  for (const entry of entries) {
    const value = entry[key];
    if (!value) {
      addFinding("error", `Registry item is missing ${key}.`, registryPath);
      continue;
    }
    if (typeof value !== "string") {
      addFinding("error", `Registry item ${key} must be a string.`, registryPath);
      continue;
    }
    if (!exists(value)) {
      addFinding("error", `Registry item points to missing file: ${value}.`, registryPath);
    }
  }
}

function ensureArrayField(payload, fieldName, registryPath) {
  if (!payload || !Array.isArray(payload[fieldName])) {
    addFinding("error", `Registry is missing array field: ${fieldName}.`, registryPath);
    return [];
  }
  return payload[fieldName];
}

function checkRegistries() {
  const contractsPayload = readJsonSafe("registries/contracts.registry.json");
  const workflowsPayload = readJsonSafe("registries/workflows.registry.json");
  const schemasPayload = readJsonSafe("registries/schemas.registry.json");
  const validatorsPayload = readJsonSafe("registries/validators.registry.json");
  const policiesPayload = readJsonSafe("registries/policies.registry.json");

  const contracts = ensureArrayField(
    contractsPayload,
    "contracts",
    "registries/contracts.registry.json",
  );
  const workflows = ensureArrayField(
    workflowsPayload,
    "workflows",
    "registries/workflows.registry.json",
  );
  const schemas = ensureArrayField(schemasPayload, "schemas", "registries/schemas.registry.json");
  const validators = ensureArrayField(
    validatorsPayload,
    "validators",
    "registries/validators.registry.json",
  );
  const policies = ensureArrayField(
    policiesPayload,
    "policies",
    "registries/policies.registry.json",
  );

  enforceStatusValues(contracts, "registries/contracts.registry.json");
  enforceStatusValues(workflows, "registries/workflows.registry.json");
  enforceStatusValues(schemas, "registries/schemas.registry.json");
  enforceStatusValues(validators, "registries/validators.registry.json");
  enforceStatusValues(policies, "registries/policies.registry.json");

  enforcePathResolution(contracts, "registries/contracts.registry.json", "path");
  enforcePathResolution(schemas, "registries/schemas.registry.json", "path");
  enforcePathResolution(validators, "registries/validators.registry.json", "path");

  for (const contract of contracts) {
    if (!contract.validator) {
      addFinding(
        "error",
        "Contract entry is missing validator.",
        "registries/contracts.registry.json",
      );
      continue;
    }
    if (isPathLike(contract.validator) && !exists(contract.validator)) {
      addFinding(
        "error",
        `Contract entry points to missing validator file: ${contract.validator}.`,
        "registries/contracts.registry.json",
      );
    }
  }

  const contractIds = new Set(contracts.map((entry) => entry.id).filter(Boolean));
  const schemaPaths = new Set(schemas.map((entry) => entry.path).filter(Boolean));
  const validatorIds = new Set(validators.map((entry) => entry.id).filter(Boolean));
  const validatorPaths = new Set(validators.map((entry) => entry.path).filter(Boolean));

  for (const requiredSchemaPath of REQUIRED_SCHEMA_PATHS) {
    if (!schemaPaths.has(requiredSchemaPath)) {
      addFinding(
        "error",
        `Required schema is not registered: ${requiredSchemaPath}.`,
        "registries/schemas.registry.json",
      );
    }
  }

  for (const policy of policies) {
    const requiredPolicyFields = ["id", "version", "status", "decision", "applies_to", "reason"];
    for (const field of requiredPolicyFields) {
      if (policy[field] === undefined || policy[field] === null) {
        addFinding(
          "error",
          `Policy is missing required field: ${field}.`,
          "registries/policies.registry.json",
        );
      }
    }
    if (policy.decision && !ALLOWED_POLICY_DECISIONS.has(policy.decision)) {
      addFinding(
        "error",
        `Policy uses invalid decision: ${String(policy.decision)}.`,
        "registries/policies.registry.json",
      );
    }
    if (policy.applies_to !== undefined && !Array.isArray(policy.applies_to)) {
      addFinding(
        "error",
        "Policy applies_to must be an array.",
        "registries/policies.registry.json",
      );
    }
  }

  for (const workflow of workflows) {
    const requiredFields = ["id", "contract", "runner", "validator", "artifact", "fallback"];
    for (const field of requiredFields) {
      if (!workflow[field]) {
        addFinding(
          "error",
          `Workflow is missing required field: ${field}.`,
          "registries/workflows.registry.json",
        );
      }
    }

    if (workflow.contract && !contractIds.has(workflow.contract)) {
      addFinding(
        "error",
        `Workflow references unregistered contract: ${workflow.contract}.`,
        "registries/workflows.registry.json",
      );
    }

    if (workflow.validator) {
      const validatorRef = workflow.validator;
      const validatorRegistered =
        validatorIds.has(validatorRef) || validatorPaths.has(validatorRef);
      if (!validatorRegistered) {
        addFinding(
          "error",
          `Workflow references unregistered validator: ${validatorRef}.`,
          "registries/workflows.registry.json",
        );
      }
      if (isPathLike(validatorRef) && !exists(validatorRef)) {
        addFinding(
          "error",
          `Workflow points to missing validator path: ${validatorRef}.`,
          "registries/workflows.registry.json",
        );
      }
    }

    if (
      workflow.queue &&
      typeof workflow.queue === "string" &&
      !workflow.queue.includes("*") &&
      !exists(workflow.queue)
    ) {
      addFinding(
        "error",
        `Workflow points to missing queue file: ${workflow.queue}.`,
        "registries/workflows.registry.json",
      );
    }

    if (!workflow.components || typeof workflow.components !== "object") {
      addFinding(
        "error",
        "Workflow is missing components declaration.",
        "registries/workflows.registry.json",
      );
      continue;
    }

    for (const componentKey of REQUIRED_COMPONENT_KEYS) {
      if (!Object.hasOwn(workflow.components, componentKey)) {
        addFinding(
          "error",
          `Workflow is missing component declaration: ${componentKey}.`,
          "registries/workflows.registry.json",
        );
        continue;
      }
      const state = workflow.components[componentKey];
      if (!ALLOWED_COMPONENT_STATES.has(state)) {
        addFinding(
          "error",
          `Workflow component ${componentKey} has invalid state: ${String(state)}.`,
          "registries/workflows.registry.json",
        );
      }
    }
  }
}

function checkSecretLikePatterns() {
  const configFiles = [...listFilesRecursively("registries"), ...listFilesRecursively("schemas")];
  const disallowedSecretValue =
    /"(token|apiKey|password|secret)"\s*:\s*"(?!REDACTED|<redacted>|placeholder|example|changeme)[^"]{6,}"/i;

  for (const absoluteFile of configFiles) {
    const relativeFile = toRepoRelative(absoluteFile);
    const content = fs.readFileSync(absoluteFile, "utf8");
    if (disallowedSecretValue.test(content)) {
      addFinding(
        "error",
        "Potential secret-like value detected in committed config.",
        relativeFile,
      );
    }
  }
}

function checkPhiPatternsInArtifacts() {
  const artifactFiles = listFilesRecursively("artifacts");
  if (artifactFiles.length === 0) {
    return;
  }

  const phiPatterns = [/\bMRN\b/i, /\bmedical record\b/i, /\bpatient name\b/i, /\bDOB\b/i];
  for (const absoluteFile of artifactFiles) {
    const relativeFile = toRepoRelative(absoluteFile);
    const text = fs.readFileSync(absoluteFile, "utf8");
    for (const pattern of phiPatterns) {
      if (pattern.test(text)) {
        addFinding("blocked", "Potential PHI marker detected in artifact.", relativeFile);
        break;
      }
    }
  }
}

function summarizeStatus() {
  const severities = new Set(findings.map((finding) => finding.severity));
  if (severities.has("blocked")) {
    return "BLOCKED";
  }
  if (severities.has("error")) {
    return "FAIL";
  }
  if (severities.has("warning")) {
    return "WARN";
  }
  return "PASS";
}

function main() {
  checkRequiredPaths();
  checkRegistries();
  checkSecretLikePatterns();
  checkPhiPatternsInArtifacts();

  const status = summarizeStatus();
  const payload = {
    validator_id: "validate_openclaw_control_plane",
    status,
    checked_at: new Date().toISOString(),
    findings,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (status === "FAIL" || status === "BLOCKED") {
    process.exit(1);
  }
}

main();
