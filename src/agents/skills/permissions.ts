import type {
  SkillPermissionManifest,
  PermissionValidationResult,
  PermissionRiskLevel,
} from "./types.js";

/**
 * High-risk patterns that warrant warnings.
 */
const HIGH_RISK_FILESYSTEM_PATTERNS = [
  /^(read|write|readwrite):(?:.*\/)?\.[a-zA-Z]/, // Dotfiles (e.g., .env, ~/.ssh, but not ./data)
  /^(read|write|readwrite):~?\/?(\.ssh|\.gnupg|\.aws)/, // Credential dirs
  /^(read|write|readwrite):~?\/?\.env/, // Env files
  /^(read|write|readwrite):\*\*/, // Recursive wildcards
  /^(read|write|readwrite):\//, // Absolute paths
];

const HIGH_RISK_NETWORK_PATTERNS = [
  /^any$/i,
  /^\*$/, // Wildcard
  /webhook\.site/i, // Known exfil endpoint
  /ngrok/i,
  /requestbin/i,
];

const HIGH_RISK_ENV_PATTERNS = [
  /^AWS_/i,
  /KEY$/i,
  /TOKEN$/i,
  /SECRET$/i,
  /PASSWORD$/i,
  /CREDENTIAL/i,
];

const DANGEROUS_EXEC = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "eval",
  "exec",
  "sudo",
  "su",
  "rm",
  "dd",
  "mkfs",
]);

/**
 * Assess overall risk level based on manifest and risk factors.
 */
function assessRiskLevel(
  manifest: SkillPermissionManifest,
  risk_factors: string[],
): PermissionRiskLevel {
  // Critical: elevated access or shell exec
  if (manifest.elevated || manifest.exec?.some((e) => DANGEROUS_EXEC.has(e.toLowerCase()))) {
    return "critical";
  }

  // High: many risk factors or sensitive data
  if (risk_factors.length >= 3 || manifest.sensitive_data?.credentials) {
    return "high";
  }

  // Moderate: some risk factors
  if (risk_factors.length >= 1) {
    return "moderate";
  }

  // Low: has network or broad filesystem
  if ((manifest.network?.length ?? 0) > 0 || (manifest.filesystem?.length ?? 0) > 2) {
    return "low";
  }

  // Minimal: very limited scope
  return "minimal";
}

/**
 * Validate a permission manifest and assess risk level.
 */
export function validatePermissionManifest(
  manifest: SkillPermissionManifest | undefined,
  skillName: string,
): PermissionValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const risk_factors: string[] = [];

  // No manifest = unknown risk
  if (!manifest) {
    return {
      valid: false,
      warnings: [`Skill "${skillName}" has no permission manifest`],
      errors: [],
      risk_level: "high",
      risk_factors: ["No declared permissions - skill trust cannot be assessed"],
    };
  }

  // Check filesystem permissions
  for (const perm of manifest.filesystem ?? []) {
    for (const pattern of HIGH_RISK_FILESYSTEM_PATTERNS) {
      if (pattern.test(perm)) {
        risk_factors.push(`Filesystem: ${perm} matches high-risk pattern`);
        break;
      }
    }
  }

  // Check network permissions
  for (const perm of manifest.network ?? []) {
    for (const pattern of HIGH_RISK_NETWORK_PATTERNS) {
      if (pattern.test(perm)) {
        risk_factors.push(`Network: ${perm} matches high-risk pattern`);
        break;
      }
    }
  }

  // Check env permissions
  for (const perm of manifest.env ?? []) {
    for (const pattern of HIGH_RISK_ENV_PATTERNS) {
      if (pattern.test(perm)) {
        risk_factors.push(`Env: ${perm} accesses sensitive variable`);
        break;
      }
    }
  }

  // Check exec permissions
  for (const perm of manifest.exec ?? []) {
    if (DANGEROUS_EXEC.has(perm.toLowerCase())) {
      risk_factors.push(`Exec: ${perm} is a dangerous executable`);
    }
  }

  // Check explicit flags
  if (manifest.elevated) {
    risk_factors.push("Skill requests elevated/sudo access");
  }
  if (manifest.system_config) {
    risk_factors.push("Skill may modify system configuration");
  }
  if (manifest.sensitive_data?.credentials) {
    risk_factors.push("Skill accesses credentials");
  }
  if (manifest.sensitive_data?.financial) {
    risk_factors.push("Skill accesses financial data");
  }

  // Assess overall risk level
  const risk_level = assessRiskLevel(manifest, risk_factors);

  // Generate warnings for high-risk without justification
  if (risk_factors.length > 0 && !manifest.security_notes) {
    warnings.push(
      `Skill has ${risk_factors.length} risk factor(s) but no security_notes explaining why`,
    );
  }

  if (!manifest.declared_purpose) {
    warnings.push("Skill has no declared_purpose");
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    risk_level,
    risk_factors,
  };
}

/**
 * Format permission manifest for human-readable display.
 */
export function formatPermissionManifest(
  manifest: SkillPermissionManifest | undefined,
  skillName: string,
): string {
  if (!manifest) {
    return (
      `⚠️  Skill "${skillName}" has NO permission manifest.\n` +
      `   This skill's access requirements are unknown.\n`
    );
  }

  const lines: string[] = [`📋 Permission Manifest for "${skillName}":`];

  if (manifest.declared_purpose) {
    lines.push(`   Purpose: ${manifest.declared_purpose}`);
  }

  lines.push("");

  if (manifest.filesystem?.length) {
    lines.push(`   📁 Filesystem: ${manifest.filesystem.join(", ")}`);
  } else {
    lines.push(`   📁 Filesystem: none declared`);
  }

  if (manifest.network?.length) {
    lines.push(`   🌐 Network: ${manifest.network.join(", ")}`);
  } else {
    lines.push(`   🌐 Network: none declared`);
  }

  if (manifest.env?.length) {
    lines.push(`   🔑 Env vars: ${manifest.env.join(", ")}`);
  } else {
    lines.push(`   🔑 Env vars: none declared`);
  }

  if (manifest.exec?.length) {
    lines.push(`   ⚙️  Executables: ${manifest.exec.join(", ")}`);
  } else {
    lines.push(`   ⚙️  Executables: none declared`);
  }

  if (manifest.elevated) {
    lines.push(`   ⚠️  ELEVATED ACCESS REQUESTED`);
  }

  if (manifest.security_notes) {
    lines.push("");
    lines.push(`   Security notes: ${manifest.security_notes}`);
  }

  return lines.join("\n");
}

/**
 * Format validation result for display.
 */
export function formatValidationResult(result: PermissionValidationResult): string {
  const riskEmoji: Record<PermissionRiskLevel, string> = {
    minimal: "🟢",
    low: "🟡",
    moderate: "🟠",
    high: "🔴",
    critical: "⛔",
  };

  const lines: string[] = [
    `Risk Level: ${riskEmoji[result.risk_level]} ${result.risk_level.toUpperCase()}`,
  ];

  if (result.risk_factors.length > 0) {
    lines.push("");
    lines.push("Risk factors:");
    for (const factor of result.risk_factors) {
      lines.push(`  • ${factor}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  ⚠️  ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`  ❌ ${error}`);
    }
  }

  return lines.join("\n");
}
