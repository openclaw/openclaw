#!/usr/bin/env node
/**
 * Parse Claude Code / Codex output into structured results
 * Usage: node parse-output.cjs < log.txt
 *        cat log.txt | node parse-output.cjs
 */

const PATTERNS = {
  // File operations
  fileCreated: /(?:Created?|Writing|Wrote|Creating)\s+(?:file\s+)?[`'"]?([^\s`'"]+\.\w+)[`'"]?/gi,
  fileModified: /(?:Modified|Updated|Editing|Changed)\s+[`'"]?([^\s`'"]+\.\w+)[`'"]?/gi,
  fileDeleted: /(?:Deleted?|Removed?|Removing)\s+[`'"]?([^\s`'"]+\.\w+)[`'"]?/gi,

  // Git operations
  gitCommit: /(?:commit|committed)\s+([a-f0-9]{7,40})(?:\s*[-:]\s*(.+))?/gi,
  gitCommitAlt: /\[(?:main|master|[\w-]+)\s+([a-f0-9]{7,40})\]\s+(.+)/g,

  // Test results
  testsPassed: /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?/gi,
  testsFailed: /(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?)?/gi,
  testsTotal: /(?:Tests?|Ran)\s*:?\s*(\d+)/gi,
  jestSummary: /Tests:\s*(\d+)\s+passed.*?(\d+)\s+total/i,
  vitestSummary: /✓\s+(\d+)\s+passed/i,

  // Errors
  error: /(?:Error|ERROR|error\[|✗|❌|FAIL)[\s:]+(.+)/g,
  compileError: /(?:error\[E\d+\]|SyntaxError|TypeError|ReferenceError)[\s:]+(.+)/g,

  // Warnings
  warning: /(?:Warning|WARN|⚠)[\s:]+(.+)/gi,

  // Commands executed
  shellCommand: /(?:Running|Executing|>\s*|⚡|→)\s*[`$]\s*(.+?)(?:[`\n]|$)/g,
  bashBlock: /```(?:bash|sh|shell)\n([\s\S]+?)```/g,
};

function parseOutput(raw) {
  const result = {
    success: true,
    filesChanged: [],
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
    errors: [],
    warnings: [],
    commits: [],
    commands: [],
    summary: "",
  };

  const seenFiles = new Set();
  const seenErrors = new Set();
  const seenCommits = new Set();

  // Extract files
  for (const pattern of [PATTERNS.fileCreated, PATTERNS.fileModified]) {
    let match;
    pattern.lastIndex = 0; // Reset regex
    while ((match = pattern.exec(raw)) !== null) {
      const file = match[1].trim();
      if (!seenFiles.has(file) && !file.includes("...") && file.length < 200) {
        seenFiles.add(file);
        result.filesChanged.push(file);
      }
    }
  }

  // Extract commits
  for (const pattern of [PATTERNS.gitCommit, PATTERNS.gitCommitAlt]) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(raw)) !== null) {
      const hash = match[1];
      if (!seenCommits.has(hash)) {
        seenCommits.add(hash);
        result.commits.push({ hash, message: match[2]?.trim() || "" });
      }
    }
  }

  // Extract test results
  let match;

  // Jest-style summary
  PATTERNS.jestSummary.lastIndex = 0;
  if ((match = PATTERNS.jestSummary.exec(raw))) {
    result.testsPassed = parseInt(match[1], 10);
    result.testsRun = parseInt(match[2], 10);
    result.testsFailed = result.testsRun - result.testsPassed;
  }
  // Vitest-style
  else {
    PATTERNS.vitestSummary.lastIndex = 0;
    if ((match = PATTERNS.vitestSummary.exec(raw))) {
      result.testsPassed = parseInt(match[1], 10);
      result.testsRun = result.testsPassed;
    }
    // Generic patterns
    else {
      PATTERNS.testsPassed.lastIndex = 0;
      while ((match = PATTERNS.testsPassed.exec(raw)) !== null) {
        result.testsPassed = Math.max(result.testsPassed, parseInt(match[1], 10));
      }
      PATTERNS.testsFailed.lastIndex = 0;
      while ((match = PATTERNS.testsFailed.exec(raw)) !== null) {
        result.testsFailed = Math.max(result.testsFailed, parseInt(match[1], 10));
      }
      result.testsRun = result.testsPassed + result.testsFailed;
    }
  }

  // Extract errors
  for (const pattern of [PATTERNS.error, PATTERNS.compileError]) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(raw)) !== null) {
      const err = match[1].trim().slice(0, 200);
      if (!seenErrors.has(err) && err.length > 5) {
        seenErrors.add(err);
        result.errors.push(err);
      }
    }
  }

  // Extract warnings
  PATTERNS.warning.lastIndex = 0;
  while ((match = PATTERNS.warning.exec(raw)) !== null) {
    const warn = match[1].trim().slice(0, 200);
    if (warn.length > 5) {
      result.warnings.push(warn);
    }
  }

  // Extract commands
  PATTERNS.shellCommand.lastIndex = 0;
  while ((match = PATTERNS.shellCommand.exec(raw)) !== null) {
    const cmd = match[1].trim();
    if (cmd.length > 2 && cmd.length < 200 && !cmd.startsWith("#")) {
      result.commands.push(cmd);
    }
  }
  PATTERNS.bashBlock.lastIndex = 0;
  while ((match = PATTERNS.bashBlock.exec(raw)) !== null) {
    const cmds = match[1].split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    result.commands.push(...cmds.map((c) => c.trim()));
  }

  // Determine success
  result.success = result.errors.length === 0 && result.testsFailed === 0;

  // Generate summary
  const parts = [];
  if (result.filesChanged.length > 0) {
    parts.push(`${result.filesChanged.length} files changed`);
  }
  if (result.commits.length > 0) {
    parts.push(`${result.commits.length} commit(s)`);
  }
  if (result.testsRun > 0) {
    parts.push(`${result.testsPassed}/${result.testsRun} tests passed`);
  }
  if (result.errors.length > 0) {
    parts.push(`${result.errors.length} error(s)`);
  }
  result.summary = parts.length > 0 ? parts.join(", ") : "No significant activity detected";

  return result;
}

// CLI entry point
if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const result = parseOutput(input);
    console.log(JSON.stringify(result, null, 2));
  });
}

module.exports = { parseOutput };
