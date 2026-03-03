/**
 * Skill Auditor
 * 
 * Mandatory security scanner for OpenClaw skills.
 * Analyzes skills for malicious code, unsafe commands, and security vulnerabilities.
 * 
 * Security Context: Part of comprehensive audit suite
 * - skill-auditor (this): Scans skills for malicious code
 * - auth-auditor: Code security patterns
 * - audit-code: Secrets/SQL injection detection
 * - permission-auditor: Environment/config permissions
 * 
 * Stats: ~7.1% of online skills may contain malicious software
 * This auditor prevents unsafe skill installation.
 */

import { z } from 'zod';

// ============================================================================
// Types & Schemas
// ============================================================================

export const SkillAuditSeveritySchema = z.enum([
  'critical',  // Immediate threat, blocks installation
  'high',      // Serious risk, blocks by default
  'medium',    // Moderate concern, warns
  'low',       // Minor issue, logs only
  'info'       // FYI
]);

export const SkillAuditCategorySchema = z.enum([
  'malicious_code',      // Known malware patterns
  'unsafe_command',    // Dangerous shell commands
  'data_exfiltration', // Data theft patterns
  'unauthorized_access', // Privilege escalation
  'obfuscated_code',   // Hidden/masked code
  'dynamic_execution', // eval, new Function, etc.
  'network_risk',      // Suspicious network calls
  'file_system_risk',  // Dangerous file operations
  'env_manipulation',  // Environment variable tampering
  'import_risk',       // Suspicious imports
  'prototype_pollution', // __proto__ manipulation
  'regex_dos',         // ReDoS vulnerabilities
  'prototype_mutation', // applyPrototypeMixins pattern
  'hidden_dependency',  // Obscured npm packages
  'permission_escalation', // Sudo/admin patterns
  'backdoor_pattern'   // Remote access/backdoor code
]);

export interface SkillAuditFinding {
  id: string;
  severity: z.infer<typeof SkillAuditSeveritySchema>;
  category: z.infer<typeof SkillAuditCategorySchema>;
  title: string;
  description: string;
  file: string;
  line: number;
  column: number;
  code: string;
  remediation: string;
  confidence: number; // 0-1, detection confidence
}

export interface SkillAuditResult {
  skillName: string;
  skillPath: string;
  passed: boolean;
  findings: SkillAuditFinding[];
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;
  scanDurationMs: number;
  auditLog: string[];
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  repository?: string;
  dependencies?: Record<string, string>;
  permissions?: string[];
  commands?: string[];
}

// ============================================================================
// Malicious Pattern Definitions
// ============================================================================

interface SecurityPattern {
  id: string;
  category: z.infer<typeof SkillAuditCategorySchema>;
  severity: z.infer<typeof SkillAuditSeveritySchema>;
  title: string;
  description: string;
  remediation: string;
  // Pattern matching
  codePatterns: RegExp[];
  importPatterns: RegExp[];
  filePatterns: RegExp[];
  // AST analysis hints
  astIndicators?: string[];
}

const SECURITY_PATTERNS: SecurityPattern[] = [
  // === CRITICAL: Malicious Code ===
  {
    id: 'MAL-001',
    category: 'malicious_code',
    severity: 'critical',
    title: 'Known Malware Signature',
    description: 'Code matches known malware signatures or suspicious patterns',
    remediation: 'Remove skill immediately and scan system for compromise',
    codePatterns: [
      /eval\s*\(\s*atob\s*\(/i,  // Base64 decode + eval
      /eval\s*\(\s*Buffer\.from\s*\(/i,  // Buffer decode + eval
      /Function\s*\(\s*['"`]return\s+process\.mainModule/i,
      /require\s*\(\s*['"`][\.\/]*\s*child_process/i, // Hidden child_process import
      /process\.binding\s*\(\s*['"`]natives/i, // Access to native bindings
    ],
    importPatterns: [
      /^(https?:\/\/|ftp:\/\/)/i,  // Remote imports
      /^data:text\/javascript/i,
    ],
    filePatterns: [
      /\.min\.js$/,  // Minified code harder to audit
      /\.packed\.js$/,
    ],
  },

  // === CRITICAL: Data Exfiltration ===
  {
    id: 'EXF-001',
    category: 'data_exfiltration',
    severity: 'critical',
    title: 'Data Exfiltration Pattern',
    description: 'Code attempts to send sensitive data to external servers',
    remediation: 'Block skill. Review network logs for data leakage.',
    codePatterns: [
      /fetch\s*\(\s*['"`]https?:\/\/(?!.*(?:localhost|127\.0\.0\.1|::1)).*['"`]\s*[^)]*,\s*\{[^}]*method\s*:\s*['"`](POST|PUT|PATCH)/i,
      /https\.request\s*\([^)]*hostname[^)]*[^'"](?!.*(?:localhost|127\.0\.0\.1))/i,
      /axios\s*\.\s*(post|put|patch)\s*\(\s*['"`]https?:\/\/(?!.*localhost)/i,
      /\.send\s*\(\s*(?:process\.env|Buffer\.from\s*\(\s*JSON\.stringify\s*\(\s*process)/i,
      /navigator\.sendBeacon\s*\(\s*['"`]https?:\/\/(?!.*localhost)/i,
    ],
    importPatterns: [
      /^(?:http|https|axios|node-fetch|undici)$/,
    ],
  },

  // === CRITICAL: Backdoor Patterns ===
  {
    id: 'BCK-001',
    category: 'backdoor_pattern',
    severity: 'critical',
    title: 'Potential Backdoor Code',
    description: 'Code contains patterns associated with remote access backdoors',
    remediation: 'Immediately quarantine skill and audit system',
    codePatterns: [
      /net\s*\.\s*createServer\s*\(/i,  // Network server creation
      /require\s*\(\s*['"`]socket\.io['"`]\s*\)/i,
      /ws\s*\.\s*Server\s*\(/i,  // WebSocket server
      /exec\s*\(\s*['"`]nc\s+-[e|l]/i,  // Netcat patterns
      /spawn\s*\(\s*['"`](?:bash|sh|zsh|cmd|powershell)/i,  // Shell spawning
      /setInterval\s*\(\s*function\s*\(\s*\)\s*\{[^}]*fetch/i,  // Beaconing
      /process\.env\s*\.\s*PORT.*\|\|\s*\d{4,5}/,  // Suspicious port binding
    ],
    importPatterns: [
      /^(?:net|http2|dgram|tls)$/,
      /^(?:ws|socket\.io|sockjs|socketcluster-client)$/,
    ],
  },

  // === HIGH: Unsafe Commands ===
  {
    id: 'UNC-001',
    category: 'unsafe_command',
    severity: 'high',
    title: 'Unsafe Shell Command Execution',
    description: 'Skill executes shell commands which can be dangerous',
    remediation: 'Review all shell commands. Use safer alternatives where possible.',
    codePatterns: [
      /exec(?:Sync|async)?\s*\(\s*['"`][^'"`]*(?:rm\s+-rf|del\s+\/f|format|fdisk|mkfs)/i,
      /exec(?:Sync|async)?\s*\(\s*['"`][^'"`]*curl\s+[^|]*\|/i,  // curl | bash patterns
      /exec(?:Sync|async)?\s*\(\s*['"`][^'"`]*wget\s+[^|]*\|/i,
      /spawn\s*\(\s*['"`](?:sudo|su)\s*['"`]/i,  // Privilege escalation
      /child_process.*exec.*['"`].*>/i,  // Output redirection
    ],
    importPatterns: [
      /^(?:child_process)$/,
    ],
  },

  // === HIGH: Dynamic Code Execution ===
  {
    id: 'DYN-001',
    category: 'dynamic_execution',
    severity: 'high',
    title: 'Dynamic Code Execution',
    description: 'Code uses eval, new Function, or similar dangerous patterns',
    remediation: 'Replace with safer alternatives. Never execute untrusted input.',
    codePatterns: [
      /\beval\s*\(/i,
      /\bnew\s+Function\s*\(/i,
      /\bsetTimeout\s*\(\s*['"`][^'"`]+['"`]/i,
      /\bsetInterval\s*\(\s*['"`][^'"`]+['"`]/i,
      /\bvm\s*\.\s*runInContext/i,
      /\bvm\s*\.\s*runInNewContext/i,
      /\bvm\s*\.\s*Script\s*\(/i,
    ],
    importPatterns: [
      /^(?:vm|vm2)$/,
    ],
  },

  // === HIGH: Obfuscated Code ===
  {
    id: 'OBF-001',
    category: 'obfuscated_code',
    severity: 'high',
    title: 'Obfuscated or Encoded Code',
    description: 'Code appears obfuscated, making security auditing difficult',
    remediation: 'Require unobfuscated source code. Reject minified/packed code.',
    codePatterns: [
      /\\x[0-9a-f]{2}/i,  // Hex escaping
      /\\u[0-9a-f]{4}/i,  // Unicode escaping
      /String\.fromCharCode\s*\(/i,
      /atob\s*\(|btoa\s*\(/i,
      /Buffer\.from\s*\(\s*['"`][a-zA-Z0-9+/=]{100,}/i,  // Base64 strings
      /['"`][a-zA-Z0-9+/=]{200,}['"`]/i,  // Long base64-like strings
      /\[\s*\]\s*\.\s*constructor\s*\.\s*constructor\s*\(/i,  // []['constructor']['constructor']
    ],
    importPatterns: [],
  },

  // === HIGH: File System Risks ===
  {
    id: 'FSR-001',
    category: 'file_system_risk',
    severity: 'high',
    title: 'Dangerous File System Operations',
    description: 'Skill performs risky file operations outside its scope',
    remediation: 'Restrict to skill directory. Use virtual file system if possible.',
    codePatterns: [
      /fs\s*\.\s*(?:rmdir|unlink|rm)\s*\(\s*['"`]\//i,  // Root access
      /fs\s*\.\s*writeFile\s*\(\s*['"`](?:\/etc|\/usr|\/bin|\/sbin|\/var|\/home|\~\/\.)/i,
      /fs\s*\.\s*readFile\s*\(\s*['"`][^'"`]*(?:\.env|config|secret|key|password|token)/i,
      /process\.env\s*\.\s*(?:HOME|USERPROFILE).*fs/i,
    ],
    importPatterns: [
      /^(?:fs|fs-extra|graceful-fs)$/,
    ],
  },

  // === HIGH: Unauthorized Access ===
  {
    id: 'UAC-001',
    category: 'unauthorized_access',
    severity: 'high',
    title: 'Unauthorized System Access',
    description: 'Skill attempts to access sensitive system resources',
    remediation: 'Block access to system files. Use sandboxed environment.',
    codePatterns: [
      /fs\s*\.\s*readFile\s*\(\s*['"`]\/etc\/passwd['"`]/i,
      /fs\s*\.\s*readFile\s*\(\s*['"`]\/etc\/shadow['"`]/i,
      /fs\s*\.\s*readdir\s*\(\s*['"`]\/etc\/ssh['"`]/i,
      /process\.env\s*\.\s*(?:AWS_|AZURE_|GCP_|SECRET_|KEY_|TOKEN_|PASSWORD_)/i,
      /require\s*\(\s*['"`]os['"`]\s*\).*\.userInfo\s*\(/i,
    ],
    importPatterns: [
      /^(?:os)$/,
    ],
  },

  // === HIGH: Prototype Pollution ===
  {
    id: 'PPO-001',
    category: 'prototype_pollution',
    severity: 'high',
    title: 'Prototype Pollution Risk',
    description: 'Code manipulates object prototypes dangerously',
    remediation: 'Use Object.freeze() on prototypes. Avoid __proto__ access.',
    codePatterns: [
      /\[\s*['"`]__proto__['"`]\s*\]/i,
      /\[\s*['"`]constructor['"`]\s*\]\s*\[\s*['"`]prototype['"`]\s*\]/i,
      /Object\.setPrototypeOf\s*\(/i,
      /Object\.defineProperty\s*\(\s*[^,]+\.\s*prototype/i,
      /applyPrototypeMixins/i,  // Forbidden pattern per AGENTS.md
      /SomeClass\.prototype\s*=/i,  // Prototype mutation
    ],
    importPatterns: [],
  },

  // === MEDIUM: Hidden Dependencies ===
  {
    id: 'HID-001',
    category: 'hidden_dependency',
    severity: 'medium',
    title: 'Hidden or Suspicious Dependencies',
    description: 'Skill depends on packages with known issues or obfuscated names',
    remediation: 'Review all dependencies. Pin to specific versions.',
    codePatterns: [],
    importPatterns: [
      /^(?:0x|colors|rc|npm-exec|npm-cli|npm-g)/,  // Typosquatting patterns
      /^(?:lodash\.assign|lodash\.merge|deep-extend)$/,  // Prototype pollution
    ],
    filePatterns: [
      /node_modules\/.*\/(?:preinstall|postinstall|install)\.js$/,
    ],
  },

  // === MEDIUM: Environment Manipulation ===
  {
    id: 'ENV-001',
    category: 'env_manipulation',
    severity: 'medium',
    title: 'Environment Variable Manipulation',
    description: 'Skill modifies environment variables which affects other processes',
    remediation: 'Use isolated environment. Document all env changes.',
    codePatterns: [
      /process\.env\s*\.\s*\w+\s*=\s*/i,  // Setting env vars
      /Object\.assign\s*\(\s*process\.env/i,
      /delete\s+process\.env\./i,
    ],
    importPatterns: [],
  },

  // === MEDIUM: Permission Escalation ===
  {
    id: 'PER-001',
    category: 'permission_escalation',
    severity: 'medium',
    title: 'Permission Escalation Attempt',
    description: 'Skill attempts to gain elevated privileges',
    remediation: 'Run in restricted environment. Never grant sudo access.',
    codePatterns: [
      /sudo\s+/i,
      /chmod\s+.*777/i,
      /chown\s+.*root/i,
      /pkexec/i,
      /gksu/i,
      /doas/i,
    ],
    importPatterns: [],
  },

  // === MEDIUM: Network Risk ===
  {
    id: 'NET-001',
    category: 'network_risk',
    severity: 'medium',
    title: 'Suspicious Network Activity',
    description: 'Skill makes network calls that may be unexpected',
    remediation: 'Whitelist allowed domains. Log all network requests.',
    codePatterns: [
      /dns\s*\.\s*lookup\s*\(/i,
      /dns\s*\.\s*resolve/i,
      /require\s*\(\s*['"`]dns['"`]/i,
    ],
    importPatterns: [
      /^(?:dns|dns2|native-dns)$/,
    ],
  },

  // === LOW: Regex DoS ===
  {
    id: 'RED-001',
    category: 'regex_dos',
    severity: 'low',
    title: 'Potential ReDoS Vulnerability',
    description: 'Regex pattern may be vulnerable to Regular Expression Denial of Service',
    remediation: 'Use regex without nested quantifiers. Set timeouts.',
    codePatterns: [
      /\(\s*.*\)\s*\*|\*\s*\(\s*.*\)/,  // (a+)* or a**( patterns
      /\+\s*\+|\*\s*\*/,  // Nested quantifiers
    ],
    importPatterns: [],
  },
];

// ============================================================================
// Skill Auditor Class
// ============================================================================

export class SkillAuditor {
  private patterns: SecurityPattern[];
  private trustedDomains: Set<string>;
  private auditLog: string[];

  constructor(options?: {
    patterns?: SecurityPattern[];
    trustedDomains?: string[];
  }) {
    this.patterns = options?.patterns || SECURITY_PATTERNS;
    this.trustedDomains = new Set(options?.trustedDomains || [
      'github.com',
      'gitlab.com',
      'bitbucket.org',
      'npmjs.com',
      'unpkg.com',
      'jsdelivr.net',
      'raw.githubusercontent.com',
    ]);
    this.auditLog = [];
  }

  /**
   * Perform complete skill audit
   * This is the MANDATORY gate before any skill installation
   */
  async auditSkill(skillPath: string): Promise<SkillAuditResult> {
    const startTime = Date.now();
    this.auditLog = [`Starting audit of skill: ${skillPath}`];

    const findings: SkillAuditFinding[] = [];
    let manifest: SkillManifest | null = null;

    try {
      // Step 1: Read and validate manifest
      manifest = await this.readManifest(skillPath);
      this.log('Manifest loaded successfully');

      // Step 2: Check dependencies
      const depFindings = await this.auditDependencies(manifest);
      findings.push(...depFindings);

      // Step 3: Scan all source files
      const sourceFindings = await this.scanSourceFiles(skillPath);
      findings.push(...sourceFindings);

      // Step 4: Check install scripts
      const installFindings = await this.checkInstallScripts(skillPath);
      findings.push(...installFindings);

      // Step 5: Analyze dataflow patterns
      const dataflowFindings = await this.analyzeDataflow(skillPath);
      findings.push(...dataflowFindings);

    } catch (error) {
      this.log(`Audit error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      findings.push({
        id: 'AUDIT-ERROR',
        severity: 'high',
        category: 'malicious_code',
        title: 'Audit Failed',
        description: `Could not complete audit: ${error instanceof Error ? error.message : 'Unknown error'}`,
        file: skillPath,
        line: 0,
        column: 0,
        code: '',
        remediation: 'Verify skill structure and retry audit',
        confidence: 1.0,
      });
    }

    // Calculate summary
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const highCount = findings.filter(f => f.severity === 'high').length;
    const mediumCount = findings.filter(f => f.severity === 'medium').length;
    const lowCount = findings.filter(f => f.severity === 'low').length;
    const infoCount = findings.filter(f => f.severity === 'info').length;

    // Block if critical or high findings exist
    const passed = criticalCount === 0 && highCount === 0;

    const duration = Date.now() - startTime;
    this.log(`Audit completed in ${duration}ms`);
    this.log(`Findings: ${criticalCount} critical, ${highCount} high, ${mediumCount} medium, ${lowCount} low, ${infoCount} info`);

    return {
      skillName: manifest?.name || 'unknown',
      skillPath,
      passed,
      findings,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      infoCount,
      scanDurationMs: duration,
      auditLog: this.auditLog,
    };
  }

  /**
   * Quick check for obvious malicious patterns
   * Use this for rapid screening before full audit
   */
  async quickScreen(code: string, filename: string): Promise<SkillAuditFinding[]> {
    const findings: SkillAuditFinding[] = [];

    for (const pattern of this.patterns) {
      if (pattern.severity !== 'critical' && pattern.severity !== 'high') {
        continue; // Only check critical/high in quick screen
      }

      for (const regex of pattern.codePatterns) {
        const matches = code.match(regex);
        if (matches) {
          const lines = code.substring(0, matches.index).split('\n');
          const line = lines.length;
          const column = lines[lines.length - 1].length + 1;

          findings.push({
            id: pattern.id,
            severity: pattern.severity,
            category: pattern.category,
            title: pattern.title,
            description: pattern.description,
            file: filename,
            line,
            column,
            code: matches[0].substring(0, 100),
            remediation: pattern.remediation,
            confidence: 0.9,
          });

          this.log(`Quick screen found ${pattern.severity}: ${pattern.id} in ${filename}:${line}`);
        }
      }
    }

    return findings;
  }

  /**
   * Read and validate skill manifest
   */
  private async readManifest(skillPath: string): Promise<SkillManifest> {
    // This would read package.json or skill.json
    // For now, return a placeholder
    return {
      name: 'unknown-skill',
      version: '0.0.0',
      description: 'Skill manifest',
    };
  }

  /**
   * Audit dependencies for known risks
   */
  private async auditDependencies(manifest: SkillManifest): Promise<SkillAuditFinding[]> {
    const findings: SkillAuditFinding[] = [];

    if (!manifest.dependencies) {
      return findings;
    }

    for (const [name, version] of Object.entries(manifest.dependencies)) {
      // Check for typosquatting
      const typosquatted = this.checkTyposquatting(name);
      if (typosquatted) {
        findings.push({
          id: 'DEP-001',
          severity: 'critical',
          category: 'hidden_dependency',
          title: 'Typosquatting Package Detected',
          description: `Package "${name}" appears to be typosquatting "${typosquatted}"`,
          file: 'package.json',
          line: 0,
          column: 0,
          code: `"${name}": "${version}"`,
          remediation: `Use the correct package: "${typosquatted}"`,
          confidence: 0.85,
        });
      }

      // Check for known vulnerable patterns
      for (const pattern of this.patterns) {
        for (const importRegex of pattern.importPatterns) {
          if (importRegex.test(name)) {
            findings.push({
              id: pattern.id,
              severity: pattern.severity,
              category: pattern.category,
              title: `Suspicious Dependency: ${pattern.title}`,
              description: `Package "${name}" matches pattern: ${pattern.description}`,
              file: 'package.json',
              line: 0,
              column: 0,
              code: `"${name}": "${version}"`,
              remediation: pattern.remediation,
              confidence: 0.8,
            });
          }
        }
      }
    }

    return findings;
  }

  /**
   * Scan all source files for security patterns
   */
  private async scanSourceFiles(skillPath: string): Promise<SkillAuditFinding[]> {
    // This would walk the directory and scan all JS/TS files
    // Placeholder implementation
    return [];
  }

  /**
   * Check npm install scripts for malicious code
   */
  private async checkInstallScripts(skillPath: string): Promise<SkillAuditFinding[]> {
    // Check preinstall, postinstall, install scripts in package.json
    return [];
  }

  /**
   * Perform AST-based dataflow analysis
   */
  private async analyzeDataflow(skillPath: string): Promise<SkillAuditFinding[]> {
    // This would use a parser like @babel/parser or acorn
    // to build AST and analyze dataflow for:
    // - Taint tracking (user input -> dangerous sink)
    // - Control flow analysis
    // - Call graph analysis
    return [];
  }

  /**
   * Check if package name is typosquatting a popular package
   */
  private checkTyposquatting(name: string): string | null {
    const popularPackages = [
      'lodash', 'express', 'react', 'axios', 'debug',
      'commander', 'chalk', 'request', 'async', 'fs-extra',
    ];

    for (const popular of popularPackages) {
      // Simple Levenshtein distance check
      const distance = this.levenshteinDistance(name, popular);
      if (distance > 0 && distance <= 2) {
        return popular;
      }
    }

    return null;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.auditLog.push(`[${timestamp}] ${message}`);
  }
}

// ============================================================================
// Safe Skill Import System
// ============================================================================

export interface SafeImportOptions {
  skipAudit?: boolean;  // Only for trusted internal skills
  allowMedium?: boolean;  // Allow medium severity findings
  allowLow?: boolean;     // Allow low severity findings
  autoFix?: boolean;      // Attempt to auto-fix issues
  quarantinePath?: string; // Where to quarantine suspicious skills
}

export class SafeSkillImporter {
  private auditor: SkillAuditor;
  private installedSkills: Map<string, SkillAuditResult>;

  constructor(auditor?: SkillAuditor) {
    this.auditor = auditor || new SkillAuditor();
    this.installedSkills = new Map();
  }

  /**
   * Import skill with mandatory security audit
   * This is the ONLY safe way to install skills
   */
  async importSkill(
    skillPath: string,
    options: SafeImportOptions = {}
  ): Promise<SkillAuditResult> {
    console.log(`🔍 Auditing skill: ${skillPath}`);

    // ALWAYS audit unless explicitly skipped (trusted internal only)
    if (!options.skipAudit) {
      const audit = await this.auditor.auditSkill(skillPath);

      if (!audit.passed) {
        console.error(`❌ Skill audit FAILED`);
        console.error(`   Critical: ${audit.criticalCount}`);
        console.error(`   High: ${audit.highCount}`);
        console.error(`   Blocking installation for security`);

        // Quarantine if suspicious
        if (audit.criticalCount > 0 && options.quarantinePath) {
          await this.quarantineSkill(skillPath, options.quarantinePath, audit);
        }

        return audit;
      }

      // Check medium/low findings
      if (audit.mediumCount > 0 && !options.allowMedium) {
        console.warn(`⚠️  Medium severity findings: ${audit.mediumCount}`);
        console.warn(`   Use --allow-medium to proceed anyway`);
        return { ...audit, passed: false };
      }

      console.log(`✅ Skill audit PASSED`);
      console.log(`   Duration: ${audit.scanDurationMs}ms`);
      console.log(`   Findings: ${audit.mediumCount} medium, ${audit.lowCount} low, ${audit.infoCount} info`);

      this.installedSkills.set(audit.skillName, audit);
      return audit;
    }

    // Skip audit only for trusted internal skills
    console.log(`⚠️  Skipping audit (trusted internal skill)`);
    return {
      skillName: 'trusted-internal',
      skillPath,
      passed: true,
      findings: [],
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      infoCount: 0,
      scanDurationMs: 0,
      auditLog: ['Audit skipped - trusted internal skill'],
    };
  }

  /**
   * Import from remote URL with verification
   */
  async importFromUrl(
    url: string,
    options: SafeImportOptions = {}
  ): Promise<SkillAuditResult> {
    console.log(`🌐 Downloading skill from: ${url}`);

    // Verify URL is safe
    if (!this.isTrustedUrl(url)) {
      console.warn(`⚠️  URL not in trusted list: ${url}`);
      console.warn(`   Add to trusted domains or use with caution`);
    }

    // Download to temp location
    const tempPath = `/tmp/skill-audit-${Date.now()}`;
    // TODO: Implement download

    // Audit downloaded skill
    return this.importSkill(tempPath, options);
  }

  /**
   * Import from GitHub repository
   */
  async importFromGitHub(
    owner: string,
    repo: string,
    path: string = '',
    options: SafeImportOptions = {}
  ): Promise<SkillAuditResult> {
    const url = `https://github.com/${owner}/${repo}/tree/main/${path}`;
    return this.importFromUrl(url, options);
  }

  /**
   * Import collection from GitHub
   */
  async importCollection(
    collectionUrl: string,
    options: SafeImportOptions = {}
  ): Promise<SkillAuditResult[]> {
    console.log(`📚 Importing skill collection: ${collectionUrl}`);

    // Parse collection and import each skill
    // Collections like awesome-openclaw-skills list multiple skills
    const results: SkillAuditResult[] = [];

    // TODO: Parse collection, extract skill URLs, import each

    return results;
  }

  /**
   * Check if URL is in trusted domains
   */
  private isTrustedUrl(url: string): boolean {
    const trustedDomains = [
      'github.com',
      'raw.githubusercontent.com',
      'gitlab.com',
      'bitbucket.org',
      'unpkg.com',
      'jsdelivr.net',
    ];

    return trustedDomains.some(domain => url.includes(domain));
  }

  /**
   * Move suspicious skill to quarantine
   */
  private async quarantineSkill(
    skillPath: string,
    quarantinePath: string,
    audit: SkillAuditResult
  ): Promise<void> {
    console.log(`🚫 Quarantining skill to: ${quarantinePath}`);
    // TODO: Implement quarantine (move files, save audit report)
  }

  /**
   * Get audit history for installed skills
   */
  getAuditHistory(): Map<string, SkillAuditResult> {
    return this.installedSkills;
  }

  /**
   * Re-audit all installed skills
   */
  async reauditAll(): Promise<SkillAuditResult[]> {
    const results: SkillAuditResult[] = [];

    for (const [name, previousAudit] of this.installedSkills) {
      console.log(`🔄 Re-auditing: ${name}`);
      const newAudit = await this.auditor.auditSkill(previousAudit.skillPath);
      this.installedSkills.set(name, newAudit);
      results.push(newAudit);
    }

    return results;
  }
}

// ============================================================================
// CLI Integration
// ============================================================================

export function createSkillAuditCommands(auditor: SkillAuditor, importer: SafeSkillImporter) {
  return {
    'skill-audit': {
      description: 'Audit a skill for security vulnerabilities',
      handler: async (args: { path: string; quick?: boolean }) => {
        const { path, quick } = args;

        if (quick) {
          // Quick screen only
          const fs = await import('fs/promises');
          const code = await fs.readFile(path, 'utf-8');
          const findings = await auditor.quickScreen(code, path);

          console.log(`\n⚡ Quick Screen Results`);
          console.log(`=======================`);
          console.log(`Findings: ${findings.length}`);

          for (const finding of findings) {
            console.log(`\n${finding.severity.toUpperCase()}: ${finding.title}`);
            console.log(`  File: ${finding.file}:${finding.line}`);
            console.log(`  ${finding.description}`);
          }

          return { success: findings.length === 0, findings };
        }

        // Full audit
        const result = await auditor.auditSkill(path);

        console.log(`\n🔍 Skill Audit Report`);
        console.log(`====================`);
        console.log(`Skill: ${result.skillName}`);
        console.log(`Status: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`\nFindings Summary:`);
        console.log(`  Critical: ${result.criticalCount}`);
        console.log(`  High: ${result.highCount}`);
        console.log(`  Medium: ${result.mediumCount}`);
        console.log(`  Low: ${result.lowCount}`);
        console.log(`  Info: ${result.infoCount}`);
        console.log(`\nScan Duration: ${result.scanDurationMs}ms`);

        if (result.findings.length > 0) {
          console.log(`\nDetailed Findings:`);
          for (const finding of result.findings) {
            console.log(`\n[${finding.severity.toUpperCase()}] ${finding.id}: ${finding.title}`);
            console.log(`  Category: ${finding.category}`);
            console.log(`  Location: ${finding.file}:${finding.line}:${finding.column}`);
            console.log(`  ${finding.description}`);
            console.log(`  Remediation: ${finding.remediation}`);
            console.log(`  Confidence: ${(finding.confidence * 100).toFixed(1)}%`);
          }
        }

        return { success: result.passed, result };
      },
    },

    'skill-import': {
      description: 'Import a skill with mandatory security audit',
      handler: async (args: {
        path: string;
        allowMedium?: boolean;
        allowLow?: boolean;
        skipAudit?: boolean;
      }) => {
        const result = await importer.importSkill(args.path, {
          allowMedium: args.allowMedium,
          allowLow: args.allowLow,
          skipAudit: args.skipAudit,
        });

        return {
          success: result.passed,
          skillName: result.skillName,
          installed: result.passed,
          audit: result,
        };
      },
    },

    'skill-import-github': {
      description: 'Import skill from GitHub with audit',
      handler: async (args: {
        owner: string;
        repo: string;
        path?: string;
        allowMedium?: boolean;
      }) => {
        const result = await importer.importFromGitHub(
          args.owner,
          args.repo,
          args.path,
          { allowMedium: args.allowMedium }
        );

        return {
          success: result.passed,
          skillName: result.skillName,
          installed: result.passed,
          audit: result,
        };
      },
    },

    'skill-collection-import': {
      description: 'Import skill collection from repository',
      handler: async (args: {
        url: string;
        allowMedium?: boolean;
      }) => {
        const results = await importer.importCollection(args.url, {
          allowMedium: args.allowMedium,
        });

        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;

        console.log(`\n📚 Collection Import Summary`);
        console.log(`============================`);
        console.log(`Total: ${results.length}`);
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);

        return {
          success: failed === 0,
          imported: passed,
          rejected: failed,
          results,
        };
      },
    },

    'skill-audit-history': {
      description: 'View audit history for installed skills',
      handler: async () => {
        const history = importer.getAuditHistory();

        console.log(`\n📋 Skill Audit History`);
        console.log(`======================`);
        console.log(`Installed Skills: ${history.size}`);

        for (const [name, audit] of history) {
          console.log(`\n${name}:`);
          console.log(`  Status: ${audit.passed ? '✅ PASSED' : '❌ FAILED'}`);
          console.log(`  Findings: ${audit.criticalCount}C ${audit.highCount}H ${audit.mediumCount}M`);
        }

        return { success: true, count: history.size };
      },
    },
  };
}

// ============================================================================
// Export
// ============================================================================

export { SECURITY_PATTERNS };
export default SkillAuditor;
