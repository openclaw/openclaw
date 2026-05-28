#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const SKILL_RELATIVE_PATH = path.join("skills", "openclaw-ai-suite-uib-brain", "SKILL.md");

const DEFAULT_SKILL_CONTENT = `---
name: openclaw-ai-suite-uib-brain
description: "Query OpenClaw AI suite UIB status in a read-only way and return clear blockers plus next safe task."
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["node", "pnpm"] },
        "safety":
          {
            "readOnly": true,
            "loginAttempted": false,
            "liveTradingEnabled": false,
            "writeTradingEnabled": false,
          },
      },
  }
---

# OpenClaw AI Suite UIB Brain

Read-only status skill for the UIB flow.

## Use When

- Need one command to understand current automation status.
- Need blockers and next safe task in a stable format.
- Need safe reporting without broker writes.

## Guardrails

- Read-only only.
- No broker login.
- No order placement.
- No third-party install or code execution.

## Command

\`\`\`powershell
pnpm autonomous:ai-suite:uib:query
\`\`\`

## Output

- core result
- quote status and market session
- source vetting status
- remaining blockers
- next safe task
`;

async function main() {
  const repoRoot = process.cwd();
  const skillPath = path.join(repoRoot, SKILL_RELATIVE_PATH);

  try {
    await fs.access(skillPath);
    process.stdout.write(`UIB_BRAIN_SKILL_INSTALL=ALREADY_INSTALLED path=${SKILL_RELATIVE_PATH}\n`);
    return;
  } catch {
    // Continue to install.
  }

  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, `${DEFAULT_SKILL_CONTENT}\n`, "utf8");
  process.stdout.write(`UIB_BRAIN_SKILL_INSTALL=INSTALLED path=${SKILL_RELATIVE_PATH}\n`);
}

await main().catch((error) => {
  process.stderr.write(
    `install-openclaw-ai-suite-uib-brain-skill failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
