#!/usr/bin/env node
/**
 * HTTP Security Audit Script
 *
 * Scans OpenClaw extensions for HTTP endpoints and checks if they have
 * proper security middleware applied.
 *
 * Usage:
 *   node --import tsx scripts/check-http-security.ts
 *   node --import tsx scripts/check-http-security.ts --fix
 */

import fs from "node:fs";
import path from "node:path";

interface SecurityCheck {
  extension: string;
  file: string;
  hasHttpServer: boolean;
  hasExpressApp: boolean;
  hasSecurityHeaders: boolean;
  hasRateLimit: boolean;
  hasCsrfProtection: boolean;
  hasInputValidation: boolean;
  hasAuthentication: boolean;
  securityScore: number;
  issues: string[];
}

const EXTENSIONS_DIR = path.join(process.cwd(), "extensions");

const HTTP_SERVER_PATTERNS = [/http\.createServer/, /createServer\(/, /new\s+Server\(/];

const EXPRESS_PATTERNS = [/express\(\)/, /express\.default\(\)/, /from\s+['"]express['"]/];

const SECURITY_PATTERNS = {
  headers: [/helmet\(/, /securityHeaders\(/, /x-frame-options/i, /content-security-policy/i],
  rateLimit: [/rateLimit\(/, /rateLimiter\(/, /express-rate-limit/],
  csrf: [/csrf\(/, /CsrfProtection/, /x-csrf-token/i],
  validation: [/validateInput\(/, /express-validator/, /body\(['"].*['"]\)\.is/],
  auth: [/requireAuth\(/, /authorization:/i, /bearer\s+token/i, /authenticate\(/],
};

function scanFile(filePath: string): Partial<SecurityCheck> {
  const content = fs.readFileSync(filePath, "utf-8");

  const hasHttpServer = HTTP_SERVER_PATTERNS.some((pattern) => pattern.test(content));
  const hasExpressApp = EXPRESS_PATTERNS.some((pattern) => pattern.test(content));

  if (!hasHttpServer && !hasExpressApp) {
    return {
      hasHttpServer: false,
      hasExpressApp: false,
    };
  }

  const hasSecurityHeaders = SECURITY_PATTERNS.headers.some((pattern) => pattern.test(content));
  const hasRateLimit = SECURITY_PATTERNS.rateLimit.some((pattern) => pattern.test(content));
  const hasCsrfProtection = SECURITY_PATTERNS.csrf.some((pattern) => pattern.test(content));
  const hasInputValidation = SECURITY_PATTERNS.validation.some((pattern) => pattern.test(content));
  const hasAuthentication = SECURITY_PATTERNS.auth.some((pattern) => pattern.test(content));

  const issues: string[] = [];
  if (!hasSecurityHeaders) {
    issues.push("Missing security headers (helmet)");
  }
  if (!hasRateLimit) {
    issues.push("Missing rate limiting");
  }
  if (!hasAuthentication) {
    issues.push("Missing authentication");
  }

  const securityFeatures = [
    hasSecurityHeaders,
    hasRateLimit,
    hasCsrfProtection,
    hasInputValidation,
    hasAuthentication,
  ];
  const securityScore = (securityFeatures.filter(Boolean).length / securityFeatures.length) * 100;

  return {
    hasHttpServer,
    hasExpressApp,
    hasSecurityHeaders,
    hasRateLimit,
    hasCsrfProtection,
    hasInputValidation,
    hasAuthentication,
    securityScore,
    issues,
  };
}

function scanExtension(extensionDir: string): SecurityCheck[] {
  const checks: SecurityCheck[] = [];

  function walkDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          walkDir(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const result = scanFile(fullPath);

        if (result.hasHttpServer || result.hasExpressApp) {
          const relativePath = path.relative(EXTENSIONS_DIR, fullPath);
          const extension = relativePath.split(path.sep)[0];

          checks.push({
            extension,
            file: relativePath,
            hasHttpServer: result.hasHttpServer || false,
            hasExpressApp: result.hasExpressApp || false,
            hasSecurityHeaders: result.hasSecurityHeaders || false,
            hasRateLimit: result.hasRateLimit || false,
            hasCsrfProtection: result.hasCsrfProtection || false,
            hasInputValidation: result.hasInputValidation || false,
            hasAuthentication: result.hasAuthentication || false,
            securityScore: result.securityScore || 0,
            issues: result.issues || [],
          });
        }
      }
    }
  }

  walkDir(extensionDir);
  return checks;
}

function formatSecurityScore(score: number): string {
  if (score >= 80) {
    return `\x1b[32m${score.toFixed(0)}%\x1b[0m`; // Green
  } else if (score >= 60) {
    return `\x1b[33m${score.toFixed(0)}%\x1b[0m`; // Yellow
  } else {
    return `\x1b[31m${score.toFixed(0)}%\x1b[0m`; // Red
  }
}

function formatCheckmark(value: boolean): string {
  return value ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
}

function main() {
  console.log("\n🔒 OpenClaw HTTP Security Audit\n");
  console.log("Scanning extensions for HTTP endpoints and security controls...\n");

  const extensions = fs
    .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  const allChecks: SecurityCheck[] = [];

  for (const extension of extensions) {
    const extensionPath = path.join(EXTENSIONS_DIR, extension.name);
    const checks = scanExtension(extensionPath);
    allChecks.push(...checks);
  }

  if (allChecks.length === 0) {
    console.log("✅ No HTTP endpoints found in extensions.\n");
    return;
  }

  // Group by extension
  const byExtension = new Map<string, SecurityCheck[]>();
  for (const check of allChecks) {
    if (!byExtension.has(check.extension)) {
      byExtension.set(check.extension, []);
    }
    byExtension.get(check.extension)!.push(check);
  }

  // Print results
  console.log("┌─────────────────────────────────────────────────────────────────────────┐");
  console.log("│ Extension       │ Score │ Headers │ Rate │ CSRF │ Valid │ Auth │ Issues │");
  console.log("├─────────────────────────────────────────────────────────────────────────┤");

  const sortedExtensions = Array.from(byExtension.entries()).toSorted((a, b) => {
    const avgScoreA = a[1].reduce((sum, c) => sum + c.securityScore, 0) / a[1].length;
    const avgScoreB = b[1].reduce((sum, c) => sum + c.securityScore, 0) / b[1].length;
    return avgScoreA - avgScoreB; // Sort by score ascending (worst first)
  });

  for (const [extension, checks] of sortedExtensions) {
    const avgScore = checks.reduce((sum, c) => sum + c.securityScore, 0) / checks.length;
    const hasHeaders = checks.some((c) => c.hasSecurityHeaders);
    const hasRateLimit = checks.some((c) => c.hasRateLimit);
    const hasCsrf = checks.some((c) => c.hasCsrfProtection);
    const hasValidation = checks.some((c) => c.hasInputValidation);
    const hasAuth = checks.some((c) => c.hasAuthentication);
    const issueCount = checks.reduce((sum, c) => sum + c.issues.length, 0);

    console.log(
      `│ ${extension.padEnd(15)} │ ${formatSecurityScore(avgScore).padEnd(13)} │ ` +
        `${formatCheckmark(hasHeaders).padEnd(15)} │ ${formatCheckmark(hasRateLimit).padEnd(12)} │ ` +
        `${formatCheckmark(hasCsrf).padEnd(12)} │ ${formatCheckmark(hasValidation).padEnd(13)} │ ` +
        `${formatCheckmark(hasAuth).padEnd(12)} │ ${issueCount.toString().padEnd(6)} │`,
    );

    for (const check of checks) {
      if (check.issues.length > 0) {
        console.log(`│   ↳ ${check.file}`);
        for (const issue of check.issues) {
          console.log(`│      - ${issue}`);
        }
      }
    }
  }

  console.log("└─────────────────────────────────────────────────────────────────────────┘\n");

  // Summary
  const totalChecks = allChecks.length;
  const secureChecks = allChecks.filter((c) => c.securityScore >= 80).length;
  const avgScore = allChecks.reduce((sum, c) => sum + c.securityScore, 0) / totalChecks;

  console.log("📊 Summary:");
  console.log(`   Total HTTP endpoints: ${totalChecks}`);
  console.log(
    `   Secure endpoints (≥80%): ${secureChecks} (${((secureChecks / totalChecks) * 100).toFixed(1)}%)`,
  );
  console.log(`   Average security score: ${formatSecurityScore(avgScore)}\n`);

  // Recommendations
  const vulnerableChecks = allChecks.filter((c) => c.securityScore < 80);
  if (vulnerableChecks.length > 0) {
    console.log("⚠️  Recommendations:");
    console.log("   1. Import security middleware:");
    console.log(
      '      import { webhookSecurity } from "../../src/plugins/http-security-middleware.js";',
    );
    console.log("   2. Apply to HTTP server:");
    console.log("      const middleware = webhookSecurity();");
    console.log("      middleware(req, res, () => { /* handler */ });");
    console.log("   3. See: /docs/security/http-security-guide.md\n");

    process.exit(1); // Exit with error if vulnerabilities found
  } else {
    console.log("✅ All HTTP endpoints have adequate security controls.\n");
    process.exit(0);
  }
}

main();
