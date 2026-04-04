#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REASON_CODES = {
  DANGEROUS_EXEC: "suspicious.dangerous_exec",
  DYNAMIC_CODE: "suspicious.dynamic_code_execution",
  CREDENTIAL_HARVEST: "suspicious.env_credential_access",
  EXFILTRATION: "suspicious.potential_exfiltration",
  OBFUSCATED_CODE: "suspicious.obfuscated_code",
  SUSPICIOUS_NETWORK: "suspicious.nonstandard_network",
  CRYPTO_MINING: "malicious.crypto_mining",
  INJECTION_INSTRUCTIONS: "suspicious.prompt_injection_instructions",
  SUSPICIOUS_INSTALL_SOURCE: "suspicious.install_untrusted_source",
  MALICIOUS_INSTALL_PROMPT: "malicious.install_terminal_payload",
};

const MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i;
const CODE_EXTENSION = /\.(js|ts|mjs|cjs|mts|cts|jsx|tsx|py|sh|bash|zsh|rb|go)$/i;
const MANIFEST_EXTENSION = /\.(json|yaml|yml|toml)$/i;
const STANDARD_PORTS = new Set([80, 443, 8080, 8443, 3000]);
const RAW_IP_URL_PATTERN = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|["'])/i;
const INSTALL_PACKAGE_PATTERN = /installer-package\s*:\s*https?:\/\/[^\s"'`]+/i;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function parseArgs(argv) {
  const options = { json: false, plugin: "" };
  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    }
    if (!options.plugin) {
      options.plugin = arg;
      continue;
    }
    fail(`Unexpected extra argument: ${arg}`);
  }
  if (!options.plugin) {
    fail("Usage: node scripts/clawhub-skillvetter-preview.mjs <plugin-id|path> [--json]");
  }
  return options;
}

function resolvePluginDir(repoRoot, input) {
  const maybePath = path.resolve(process.cwd(), input);
  if (fs.existsSync(maybePath)) {
    return maybePath;
  }
  return path.join(repoRoot, "extensions", input);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern) {
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  let source = pattern.startsWith("/") ? "^" : "(^|/)";

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    const next = trimmed[index + 1];
    const nextNext = trimmed[index + 2];

    if (char === "*" && next === "*" && nextNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }

  source += "$";
  return new RegExp(source);
}

function loadIgnoreMatchers(pluginDir) {
  const matchers = [];
  for (const fileName of [".clawhubignore", ".clawdhubignore"]) {
    const filePath = path.join(pluginDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
        continue;
      }
      matchers.push(globToRegExp(trimmed));
    }
  }
  return matchers;
}

function shouldIgnore(relPath, ignoreMatchers) {
  if (
    relPath.startsWith(".git/") ||
    relPath.startsWith("node_modules/") ||
    relPath.startsWith(".clawhub/") ||
    relPath.startsWith(".clawdhub/")
  ) {
    return true;
  }
  return ignoreMatchers.some((matcher) => matcher.test(relPath));
}

function listFiles(pluginDir, ignoreMatchers) {
  const files = [];

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absPath = path.join(currentDir, entry.name);
      const relPath = path.relative(pluginDir, absPath).split(path.sep).join("/");
      if (!relPath || shouldIgnore(relPath, ignoreMatchers)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push({
        path: relPath,
        size: fs.statSync(absPath).size,
        content: fs.readFileSync(absPath, "utf8"),
      });
    }
  }

  walk(pluginDir);
  return files;
}

function truncateEvidence(evidence, maxLength = 160) {
  return evidence.length <= maxLength ? evidence : `${evidence.slice(0, maxLength)}...`;
}

function addFinding(findings, code, severity, file, line, message, evidence) {
  findings.push({
    code,
    severity,
    file,
    line,
    message,
    evidence: truncateEvidence(evidence.trim()),
  });
}

function findFirstLine(content, pattern) {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      return { line: index + 1, text: lines[index] };
    }
  }
  return { line: 1, text: lines[0] ?? "" };
}

function hasMaliciousInstallPrompt(content) {
  const hasTerminalInstruction =
    /(?:copy|paste).{0,80}(?:command|snippet).{0,120}(?:terminal|shell)/is.test(content) ||
    /run\s+it\s+in\s+terminal/i.test(content) ||
    /open\s+terminal/i.test(content) ||
    /for\s+macos\s*:/i.test(content);
  if (!hasTerminalInstruction) {
    return false;
  }

  const hasCurlPipe = /(?:curl|wget)\b[^\n|]{0,240}\|\s*(?:\/bin\/)?(?:ba)?sh\b/i.test(content);
  const hasBase64Exec =
    /(?:echo|printf)\s+["'][A-Za-z0-9+/=\s]{40,}["']\s*\|\s*base64\s+-?[dD]\b[^\n|]{0,120}\|\s*(?:\/bin\/)?(?:ba)?sh\b/i.test(
      content,
    );
  const hasRawIpUrl = RAW_IP_URL_PATTERN.test(content);
  const hasInstallerPackage = INSTALL_PACKAGE_PATTERN.test(content);

  return hasBase64Exec || (hasCurlPipe && (hasRawIpUrl || hasInstallerPackage));
}

function scanCodeFile(filePath, content, findings) {
  if (!CODE_EXTENSION.test(filePath)) {
    return;
  }

  const hasChildProcess = /child_process/.test(content);
  const execPattern = /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/;
  if (hasChildProcess && execPattern.test(content)) {
    const match = findFirstLine(content, execPattern);
    addFinding(
      findings,
      REASON_CODES.DANGEROUS_EXEC,
      "critical",
      filePath,
      match.line,
      "Shell command execution detected (child_process).",
      match.text,
    );
  }

  if (/\beval\s*\(|new\s+Function\s*\(/.test(content)) {
    const match = findFirstLine(content, /\beval\s*\(|new\s+Function\s*\(/);
    addFinding(
      findings,
      REASON_CODES.DYNAMIC_CODE,
      "critical",
      filePath,
      match.line,
      "Dynamic code execution detected.",
      match.text,
    );
  }

  if (/stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i.test(content)) {
    const match = findFirstLine(content, /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i);
    addFinding(
      findings,
      REASON_CODES.CRYPTO_MINING,
      "critical",
      filePath,
      match.line,
      "Possible crypto mining behavior detected.",
      match.text,
    );
  }

  const wsMatch = content.match(/new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/);
  if (wsMatch) {
    const port = Number.parseInt(wsMatch[1] ?? "", 10);
    if (Number.isFinite(port) && !STANDARD_PORTS.has(port)) {
      const match = findFirstLine(content, /new\s+WebSocket\s*\(/);
      addFinding(
        findings,
        REASON_CODES.SUSPICIOUS_NETWORK,
        "warn",
        filePath,
        match.line,
        "WebSocket connection to non-standard port detected.",
        match.text,
      );
    }
  }

  const hasFileRead = /readFileSync|readFile/.test(content);
  const hasNetworkSend = /\bfetch\b|http\.request|\baxios\b/.test(content);
  if (hasFileRead && hasNetworkSend) {
    const match = findFirstLine(content, /readFileSync|readFile/);
    addFinding(
      findings,
      REASON_CODES.EXFILTRATION,
      "warn",
      filePath,
      match.line,
      "File read combined with network send (possible exfiltration).",
      match.text,
    );
  }

  const hasProcessEnv = /process\.env/.test(content);
  if (hasProcessEnv && hasNetworkSend) {
    const match = findFirstLine(content, /process\.env/);
    addFinding(
      findings,
      REASON_CODES.CREDENTIAL_HARVEST,
      "critical",
      filePath,
      match.line,
      "Environment variable access combined with network send.",
      match.text,
    );
  }

  if (
    /(\\x[0-9a-fA-F]{2}){6,}/.test(content) ||
    /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/.test(content)
  ) {
    const match = findFirstLine(content, /(\\x[0-9a-fA-F]{2}){6,}|(?:atob|Buffer\.from)\s*\(/);
    addFinding(
      findings,
      REASON_CODES.OBFUSCATED_CODE,
      "warn",
      filePath,
      match.line,
      "Potential obfuscated payload detected.",
      match.text,
    );
  }
}

function scanMarkdownFile(filePath, content, findings) {
  if (!MARKDOWN_EXTENSION.test(filePath)) {
    return;
  }

  if (hasMaliciousInstallPrompt(content)) {
    const match = findFirstLine(
      content,
      /installer-package\s*:|base64\s+-?[dD]|(?:curl|wget)\b|run\s+it\s+in\s+terminal/i,
    );
    addFinding(
      findings,
      REASON_CODES.MALICIOUS_INSTALL_PROMPT,
      "critical",
      filePath,
      match.line,
      "Install prompt contains an obfuscated terminal payload.",
      match.text,
    );
  }

  if (
    /ignore\s+(all\s+)?previous\s+instructions/i.test(content) ||
    /system\s*prompt\s*[:=]/i.test(content)
  ) {
    const match = findFirstLine(
      content,
      /ignore\s+(all\s+)?previous\s+instructions|system\s*prompt\s*[:=]/i,
    );
    addFinding(
      findings,
      REASON_CODES.INJECTION_INSTRUCTIONS,
      "warn",
      filePath,
      match.line,
      "Prompt-injection style instruction pattern detected.",
      match.text,
    );
  }
}

function scanManifestFile(filePath, content, findings) {
  if (!MANIFEST_EXTENSION.test(filePath)) {
    return;
  }

  if (
    /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\//i.test(content) ||
    RAW_IP_URL_PATTERN.test(content)
  ) {
    const match = findFirstLine(
      content,
      /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)\/|https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i,
    );
    addFinding(
      findings,
      REASON_CODES.SUSPICIOUS_INSTALL_SOURCE,
      "warn",
      filePath,
      match.line,
      "Install source points to URL shortener or raw IP.",
      match.text,
    );
  }
}

function summarizeReasonCodes(reasonCodes) {
  if (reasonCodes.length === 0) {
    return "No suspicious patterns detected.";
  }
  const top = reasonCodes.slice(0, 3).join(", ");
  const extra = reasonCodes.length > 3 ? ` (+${reasonCodes.length - 3} more)` : "";
  return `Detected: ${top}${extra}`;
}

function verdictFromCodes(reasonCodes) {
  if (reasonCodes.some((code) => code.startsWith("malicious."))) {
    return "malicious";
  }
  if (reasonCodes.length > 0) {
    return "suspicious";
  }
  return "clean";
}

const options = parseArgs(process.argv.slice(2));
const repoRoot = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
const pluginDir = resolvePluginDir(repoRoot, options.plugin);
if (!fs.existsSync(pluginDir)) {
  fail(`Plugin directory not found: ${pluginDir}`);
}

const ignoreMatchers = loadIgnoreMatchers(pluginDir);
const files = listFiles(pluginDir, ignoreMatchers);
const findings = [];

for (const file of files) {
  scanCodeFile(file.path, file.content, findings);
  scanMarkdownFile(file.path, file.content, findings);
  scanManifestFile(file.path, file.content, findings);
}

const reasonCodes = Array.from(new Set(findings.map((finding) => finding.code))).toSorted(
  (left, right) => left.localeCompare(right),
);
const output = {
  plugin: path.relative(repoRoot, pluginDir).split(path.sep).join("/"),
  filesScanned: files.length,
  status: verdictFromCodes(reasonCodes),
  reasonCodes,
  summary: summarizeReasonCodes(reasonCodes),
  findings,
  note: "Preview only. ClawHub still performs server-side VT/LLM review after publish.",
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(0);
}

console.log(`Plugin: ${output.plugin}`);
console.log(`Files scanned: ${output.filesScanned}`);
console.log(`Status: ${output.status}`);
console.log(`Summary: ${output.summary}`);
if (output.findings.length === 0) {
  console.log("Findings: none");
} else {
  console.log("Findings:");
  for (const finding of output.findings) {
    console.log(`- ${finding.code} [${finding.severity}] ${finding.file}:${finding.line}`);
    console.log(`  ${finding.message}`);
  }
}
console.log(output.note);
