/**
 * Cedar Policy Validator
 *
 * Validates that all Cedar policy files are syntactically correct.
 */

import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const extensionDir = path.dirname(fileURLToPath(import.meta.url));

interface ValidationResult {
  file: string;
  valid: boolean;
  policyCount: number;
  errors: string[];
  warnings: string[];
}

/**
 * Extract the @id annotation from a policy using Cedar's policyToJson.
 */
function extractPolicyId(policyText: string): string | null {
  try {
    const result = cedar.policyToJson(policyText);
    if (result.type === "success" && result.json.annotations?.id) {
      return result.json.annotations.id;
    }
  } catch {
    // Fall through to return null
  }
  return null;
}

function validatePolicyFile(filePath: string): ValidationResult {
  const fileName = path.basename(filePath);
  const result: ValidationResult = {
    file: fileName,
    valid: true,
    policyCount: 0,
    errors: [],
    warnings: [],
  };

  try {
    const policyText = fs.readFileSync(filePath, "utf-8");

    // Use Cedar's native parser to split and validate policies
    // This properly handles nested braces, complex expressions, and multiline conditions
    const parseResult = cedar.policySetTextToParts(policyText);

    if (parseResult.type === "failure") {
      result.valid = false;
      const errorMsgs = parseResult.errors?.map((e) => e.message) || ["Unknown parse error"];
      result.errors.push(`Failed to parse policy file: ${errorMsgs.join("; ")}`);
      return result;
    }

    result.policyCount = parseResult.policies.length;

    // Validate each policy individually for better error reporting
    parseResult.policies.forEach((policyStr, index) => {
      const policyId = extractPolicyId(policyStr) || `policy${index}`;

      // Use checkParsePolicySet to validate the individual policy
      const checkResult = cedar.checkParsePolicySet({
        staticPolicies: { [policyId]: policyStr },
      });

      if (checkResult.type === "failure") {
        result.valid = false;
        const errorMsgs = checkResult.errors?.map((e) => e.message) || ["Unknown error"];
        result.errors.push(`Policy "${policyId}": ${errorMsgs.join("; ")}`);
      }
    });

    if (result.policyCount === 0) {
      result.warnings.push("No policies found in file");
    }
  } catch (err) {
    result.valid = false;
    result.errors.push(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// Main validation
console.log("═══════════════════════════════════════════════════════════════");
console.log("                    Cedar Policy Validator");
console.log("═══════════════════════════════════════════════════════════════\n");

const policyFiles = [
  path.resolve(extensionDir, "policy-sondera-base.cedar"),
  path.resolve(extensionDir, "policy-openclaw-system.cedar"),
  path.resolve(extensionDir, "policy-owasp-agentic.cedar"),
];

let allValid = true;
const results: ValidationResult[] = [];

for (const file of policyFiles) {
  if (fs.existsSync(file)) {
    const result = validatePolicyFile(file);
    results.push(result);
    if (!result.valid) {
      allValid = false;
    }
  } else {
    console.log(`⚠️  File not found: ${path.basename(file)}`);
  }
}

// Print results
for (const result of results) {
  const status = result.valid ? "✅" : "❌";
  console.log(`${status} ${result.file}`);
  console.log(`   Policies: ${result.policyCount}`);

  if (result.errors.length > 0) {
    console.log("   Errors:");
    for (const error of result.errors) {
      console.log(`     ❌ ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log("   Warnings:");
    for (const warning of result.warnings) {
      console.log(`     ⚠️  ${warning}`);
    }
  }

  console.log("");
}

// Summary
console.log("═══════════════════════════════════════════════════════════════");
if (allValid) {
  const totalPolicies = results.reduce((sum, r) => sum + r.policyCount, 0);
  console.log(`✅ All policies valid! (${totalPolicies} total policies)`);
} else {
  console.log("❌ Some policies have errors. Please fix them before use.");
  process.exit(1);
}
console.log("═══════════════════════════════════════════════════════════════");
