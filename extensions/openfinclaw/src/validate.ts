/**
 * Strategy package validation for Findoo Backtest Agent (fep v1.2).
 * Checks required structure (fep.yaml, scripts/strategy.py), fep fields, and script safety rules.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Forbidden Python patterns (server will reject). */
const FORBIDDEN_PYTHON_PATTERNS = [
  /\bimport\s+os\b/,
  /\bimport\s+subprocess\b/,
  /\bimport\s+socket\b/,
  /\beval\s*\(/,
  /\bexec\s*\(/,
  /\bopen\s*\(/,
  /\brequests\b/,
  /\burllib\b/,
  /\b__import__\s*\(/,
  /\bimportlib\b/,
];

/** Result of validating a strategy package directory. */
export type ValidateResult = {
  valid: boolean;
  errors: string[];
  warnings?: string[];
};

/**
 * Validate a strategy package directory per fep v1.2:
 * - Required: fep.yaml, scripts/strategy.py
 * - fep.yaml: fep, identity (id, name, type, version, style, visibility, summary, license, author.name, changelog), technical, backtest, classification
 * - strategy.py: must define compute(data); must not use forbidden imports/calls
 */
export async function validateStrategyPackage(dirPath: string): Promise<ValidateResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const normalizedDir = path.resolve(dirPath);
  const fepPath = path.join(normalizedDir, "fep.yaml");
  const scriptDir = path.join(normalizedDir, "scripts");
  const strategyPath = path.join(scriptDir, "strategy.py");

  // ── Required files ──
  let fepContent: string;
  try {
    const raw = await readFile(fepPath, "utf-8");
    fepContent = typeof raw === "string" ? raw : String(raw ?? "");
  } catch (e) {
    errors.push(`Missing or unreadable fep.yaml: ${fepPath}`);
    return { valid: false, errors };
  }

  let strategyContent: string;
  try {
    const raw = await readFile(strategyPath, "utf-8");
    strategyContent = typeof raw === "string" ? raw : String(raw ?? "");
  } catch (e) {
    errors.push(`Missing or unreadable scripts/strategy.py: ${strategyPath}`);
    return { valid: false, errors };
  }

  // ── fep.yaml structure ──
  const fepStr = typeof fepContent === "string" ? fepContent : "";
  const strategyStr = typeof strategyContent === "string" ? strategyContent : "";
  if (!/^\s*fep\s*:/m.test(fepStr)) {
    errors.push("fep.yaml must contain 'fep:' (e.g. fep: \"1.2\")");
  }
  if (!/^\s*identity\s*:/m.test(fepStr)) {
    errors.push("fep.yaml must contain 'identity:' section");
  }
  const identityBlockMatch = /identity:\s*([\s\S]*?)(?=\n\w|\n$|$)/.exec(fepStr);
  const identityBlock = identityBlockMatch ? identityBlockMatch[1] : "";
  if (!/\bid\s*:/m.test(identityBlock)) {
    errors.push("fep.yaml identity must include 'id' (unique strategy id)");
  }
  if (!/\bname\s*:/m.test(identityBlock)) {
    errors.push("fep.yaml identity must include 'name' (strategy display name)");
  }
  if (!/\btype\s*:\s*strategy\b/m.test(identityBlock)) {
    errors.push("fep.yaml identity.type must be 'strategy' for strategy packs");
  }
  if (!/\bversion\s*:/m.test(identityBlock)) {
    errors.push("fep.yaml identity must include 'version' (e.g. \"1.0.0\")");
  }
  if (!/\bstyle\s*:/m.test(identityBlock)) {
    errors.push(
      "fep.yaml identity must include 'style' (trend|mean_reversion|dca|momentum|swing|hybrid)",
    );
  }
  if (!/\bvisibility\s*:/m.test(identityBlock)) {
    errors.push("fep.yaml identity must include 'visibility' (public|private|unlisted)");
  }
  if (!/\bsummary\s*:/m.test(identityBlock)) {
    errors.push("fep.yaml identity must include 'summary' (one-line strategy description)");
  }
  if (!/\blicense\s*:/m.test(identityBlock)) {
    errors.push("fep.yaml identity must include 'license' (MIT|CC-BY-4.0|proprietary)");
  }
  if (!/\bauthor\s*:/m.test(identityBlock) || !/\bname\s*:/m.test(identityBlock)) {
    errors.push("fep.yaml identity.author must include 'name' (author name)");
  }
  if (!/\bchangelog\s*:/m.test(identityBlock)) {
    errors.push("fep.yaml identity must include 'changelog' (at least one version record)");
  }
  if (!/^\s*technical\s*:/m.test(fepStr)) {
    errors.push("fep.yaml must contain 'technical:' section");
  } else {
    const technicalBlockMatch = /technical:\s*([\s\S]*?)(?=\n\w|\n$|$)/.exec(fepStr);
    const technicalBlock = technicalBlockMatch ? technicalBlockMatch[1] : "";
    if (!/\blanguage\s*:\s*python\b/m.test(technicalBlock)) {
      errors.push('fep.yaml technical.language must be "python"');
    }
    if (!/entryPoint\s*:\s*strategy\.py/.test(technicalBlock)) {
      errors.push("fep.yaml technical.entryPoint must be strategy.py (scripts/strategy.py)");
    }
  }
  if (!/^\s*backtest\s*:/m.test(fepStr)) {
    errors.push(
      "fep.yaml must contain 'backtest:' section with defaultPeriod, initialCapital, benchmark",
    );
  } else {
    const backtestBlockMatch = /backtest:\s*([\s\S]*?)(?=\n\w|\n$|$)/.exec(fepStr);
    const backtestBlock = backtestBlockMatch ? backtestBlockMatch[1] : "";
    if (!/defaultPeriod\s*:/m.test(backtestBlock)) {
      errors.push("fep.yaml backtest.defaultPeriod is required (startDate/endDate)");
    } else {
      const periodBlockMatch = /defaultPeriod:\s*([\s\S]*?)(?=\n\s*[A-Za-z]|\n\w|\n$|$)/.exec(
        backtestBlock,
      );
      const periodBlock = periodBlockMatch ? periodBlockMatch[1] : "";
      if (!/\bstartDate\s*:/m.test(periodBlock) || !/\bendDate\s*:/m.test(periodBlock)) {
        errors.push("fep.yaml backtest.defaultPeriod must include startDate and endDate");
      }
    }
    if (!/\binitialCapital\s*:/m.test(backtestBlock)) {
      errors.push("fep.yaml backtest.initialCapital is required");
    }
    if (!/\bbenchmark\s*:/m.test(backtestBlock)) {
      errors.push("fep.yaml backtest.benchmark is required (e.g. BTC-USD)");
    }
  }
  if (!/^\s*classification\s*:/m.test(fepStr)) {
    errors.push("fep.yaml must contain 'classification:' section");
  } else {
    const classificationBlockMatch = /classification:\s*([\s\S]*?)(?=\n\w|\n$|$)/.exec(fepStr);
    const classificationBlock = classificationBlockMatch ? classificationBlockMatch[1] : "";
    if (!/\barchetype\s*:/m.test(classificationBlock)) {
      errors.push(
        "fep.yaml classification.archetype is required (systematic|discretionary|hybrid)",
      );
    }
    if (!/\bmarket\s*:/m.test(classificationBlock)) {
      errors.push("fep.yaml classification.market is required (Crypto|US|CN|HK|Forex|Commodity)");
    }
    if (!/\bassetClasses\s*:/m.test(classificationBlock)) {
      errors.push("fep.yaml classification.assetClasses is required (e.g. [crypto])");
    }
    if (!/\bfrequency\s*:/m.test(classificationBlock)) {
      errors.push("fep.yaml classification.frequency is required (daily|weekly|monthly)");
    }
    if (!/\briskProfile\s*:/m.test(classificationBlock)) {
      errors.push("fep.yaml classification.riskProfile is required (low|medium|high)");
    }
  }

  // Optional: identity.tags should be an array when present (per v1.2 spec)
  const tagsLineMatch = /^\s*tags\s*:\s*(.+)$/m.exec(identityBlock || fepStr);
  if (tagsLineMatch) {
    const value = tagsLineMatch[1]?.trim() ?? "";
    if (!value.startsWith("[") && /["']/.test(value)) {
      warnings.push(
        "identity.tags should be a string array (e.g. tags: [dca, btc, adaptive, crypto]), not a single quoted string",
      );
    }
  }

  // ── strategy.py: compute(data) ──
  if (!/\bdef\s+compute\s*\s*\(\s*data\s*\)/.test(strategyStr)) {
    errors.push("scripts/strategy.py must define compute(data) function (per fep v1.2)");
  }
  if (!/\baction\s*/.test(strategyStr) || !/\bamount\b/.test(strategyStr)) {
    warnings.push(
      "compute(data) should return dict with action, amount, price, reason (buy|sell|hold)",
    );
  }

  // ── strategy.py: forbidden patterns ──
  for (const re of FORBIDDEN_PYTHON_PATTERNS) {
    if (re.test(strategyStr)) {
      errors.push(
        `scripts/strategy.py contains forbidden pattern (server will reject): ${re.source}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
