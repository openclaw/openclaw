/**
 * FEP 1.0 strategy compliance validator.
 *
 * Runs 11 checks across 5 dimensions (structure, interface, safety, yaml, data).
 * Pure filesystem + regex — no external dependencies.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ValidationIssue, ValidationResult } from "./types.js";

// ---------------------------------------------------------------------------
// Dangerous patterns (safety checks)
// ---------------------------------------------------------------------------

/** Imports that allow arbitrary code execution — hard block. */
const DANGEROUS_IMPORTS = [
  /\bimport\s+os\b/,
  /\bfrom\s+os\b/,
  /\bimport\s+subprocess\b/,
  /\bfrom\s+subprocess\b/,
  /\bimport\s+socket\b/,
  /\bfrom\s+socket\b/,
  /\beval\s*\(/,
  /\bexec\s*\(/,
  /\bos\.system\s*\(/,
  /\bos\.popen\s*\(/,
];

/** Network-related imports — warning only. */
const NETWORK_IMPORTS = [
  /\bimport\s+requests\b/,
  /\bfrom\s+requests\b/,
  /\bimport\s+urllib\b/,
  /\bfrom\s+urllib\b/,
  /\bimport\s+httpx\b/,
  /\bfrom\s+httpx\b/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issue(
  level: "error" | "warning",
  category: ValidationIssue["category"],
  message: string,
  file?: string,
  fix?: string,
): ValidationIssue {
  return { level, category, message, ...(file ? { file } : {}), ...(fix ? { fix } : {}) };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkStructure(dir: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // #1: fep.yaml exists
  const fepPath = join(dir, "fep.yaml");
  const fepExists = await fileExists(fepPath);
  if (!fepExists) {
    issues.push(
      issue(
        "error",
        "structure",
        "fep.yaml not found",
        "fep.yaml",
        "Create fep.yaml with Section A (identity) and Section B (classification)",
      ),
    );
  }

  // #2: scripts/strategy.py exists
  const strategyPath = join(dir, "scripts", "strategy.py");
  if (!(await fileExists(strategyPath))) {
    issues.push(
      issue(
        "error",
        "structure",
        "scripts/strategy.py not found",
        "scripts/strategy.py",
        "Create scripts/strategy.py with a Strategy class implementing execute()",
      ),
    );
  }

  // #3: scripts/requirements.txt exists
  const reqPath = join(dir, "scripts", "requirements.txt");
  if (!(await fileExists(reqPath))) {
    issues.push(
      issue(
        "warning",
        "structure",
        "scripts/requirements.txt not found",
        "scripts/requirements.txt",
        "Create scripts/requirements.txt listing Python dependencies",
      ),
    );
  }

  // #4: scripts/risk_manager.py exists
  const riskPath = join(dir, "scripts", "risk_manager.py");
  if (!(await fileExists(riskPath))) {
    issues.push(
      issue(
        "warning",
        "structure",
        "scripts/risk_manager.py not found",
        "scripts/risk_manager.py",
        "Create scripts/risk_manager.py for custom risk management",
      ),
    );
  }

  return issues;
}

async function checkInterface(dir: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const strategyPath = join(dir, "scripts", "strategy.py");
  const content = await readText(strategyPath);
  if (!content) return issues; // structure check already flagged missing file

  // #5: class ...Strategy
  if (!/class\s+\w+Strategy/.test(content)) {
    issues.push(
      issue(
        "error",
        "interface",
        "strategy.py must contain a class ending in 'Strategy' (e.g. class MomentumStrategy)",
        "scripts/strategy.py",
        "Define a class like: class MyStrategy(StrategyBase):",
      ),
    );
  }

  // #6: def execute(self
  if (!/def\s+execute\s*\(\s*self/.test(content)) {
    issues.push(
      issue(
        "error",
        "interface",
        "Strategy class must implement execute(self, ...) method",
        "scripts/strategy.py",
        "Add: def execute(self, data, portfolio):",
      ),
    );
  }

  // #7: def record_trade(self
  if (!/def\s+record_trade\s*\(\s*self/.test(content)) {
    issues.push(
      issue(
        "warning",
        "interface",
        "Strategy class should implement record_trade(self, ...) for trade logging",
        "scripts/strategy.py",
        "Add: def record_trade(self, trade_info):",
      ),
    );
  }

  return issues;
}

async function checkSafety(dir: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const scriptsDir = join(dir, "scripts");

  let pyFiles: string[];
  try {
    const entries = await readdir(scriptsDir);
    pyFiles = entries.filter((f) => f.endsWith(".py"));
  } catch {
    return issues; // scripts dir missing, structure check covers this
  }

  for (const pyFile of pyFiles) {
    const content = await readText(join(scriptsDir, pyFile));
    if (!content) continue;

    // #8: dangerous imports (error)
    for (const pattern of DANGEROUS_IMPORTS) {
      if (pattern.test(content)) {
        issues.push(
          issue(
            "error",
            "safety",
            `Dangerous pattern detected: ${pattern.source}`,
            `scripts/${pyFile}`,
            "Remove dangerous imports/calls; use strategy-safe alternatives",
          ),
        );
      }
    }

    // #9: network imports (warning)
    for (const pattern of NETWORK_IMPORTS) {
      if (pattern.test(content)) {
        issues.push(
          issue(
            "warning",
            "safety",
            `Network access detected: ${pattern.source}`,
            `scripts/${pyFile}`,
            "Network access may be blocked in sandbox; use provided data feeds",
          ),
        );
      }
    }
  }

  return issues;
}

async function checkYaml(dir: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const fepPath = join(dir, "fep.yaml");
  const content = await readText(fepPath);
  if (!content) return issues; // structure check already flagged

  // #10: Section A (identity) and Section B (classification) present
  // Support both heading style ("# Section A") and key style ("section_a:")
  const hasIdentity = /(?:^#\s*Section\s*A\b|^section_a\s*:|^identity\s*:)/im.test(content);
  const hasClassification = /(?:^#\s*Section\s*B\b|^section_b\s*:|^classification\s*:)/im.test(
    content,
  );

  if (!hasIdentity) {
    issues.push(
      issue(
        "error",
        "yaml",
        "fep.yaml missing Section A (identity): strategy name, version, author",
        "fep.yaml",
        "Add section_a: or # Section A with name, version, author fields",
      ),
    );
  }

  if (!hasClassification) {
    issues.push(
      issue(
        "error",
        "yaml",
        "fep.yaml missing Section B (classification): asset class, timeframe, strategy type",
        "fep.yaml",
        "Add section_b: or # Section B with asset_class, timeframe, strategy_type fields",
      ),
    );
  }

  return issues;
}

async function checkData(dir: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const fepPath = join(dir, "fep.yaml");
  const strategyPath = join(dir, "scripts", "strategy.py");

  const fepContent = await readText(fepPath);
  const strategyContent = await readText(strategyPath);
  if (!fepContent || !strategyContent) return issues;

  // #11: Extract symbols from fep.yaml and check consistency
  const symbolsMatch =
    fepContent.match(/symbols?\s*:\s*\[([^\]]+)\]/i) || fepContent.match(/symbols?\s*:\s*(.+)/i);

  if (symbolsMatch) {
    const yamlSymbols = symbolsMatch[1]
      .split(/[,\s]+/)
      .map((s) => s.replace(/["']/g, "").trim())
      .filter(Boolean);

    for (const sym of yamlSymbols) {
      // Check if symbol appears anywhere in strategy.py (quoted or as variable)
      if (!strategyContent.includes(sym)) {
        issues.push(
          issue(
            "warning",
            "data",
            `Symbol "${sym}" declared in fep.yaml but not referenced in strategy.py`,
            "fep.yaml",
            `Verify that strategy.py uses symbol "${sym}" or update fep.yaml`,
          ),
        );
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a local strategy directory against the FEP 1.0 specification.
 * Returns a result with errors (must fix) and warnings (should fix).
 */
export async function validateStrategy(dirPath: string): Promise<ValidationResult> {
  // Verify directory exists
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) {
      return {
        valid: false,
        errors: [issue("error", "structure", `Path is not a directory: ${dirPath}`)],
        warnings: [],
      };
    }
  } catch {
    return {
      valid: false,
      errors: [issue("error", "structure", `Directory not found: ${dirPath}`)],
      warnings: [],
    };
  }

  // Run all checks in parallel
  const [structure, iface, safety, yaml, data] = await Promise.all([
    checkStructure(dirPath),
    checkInterface(dirPath),
    checkSafety(dirPath),
    checkYaml(dirPath),
    checkData(dirPath),
  ]);

  const all = [...structure, ...iface, ...safety, ...yaml, ...data];
  const errors = all.filter((i) => i.level === "error");
  const warnings = all.filter((i) => i.level === "warning");

  return { valid: errors.length === 0, errors, warnings };
}
