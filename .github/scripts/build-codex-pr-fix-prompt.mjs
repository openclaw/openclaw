#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(
    "Usage: node .github/scripts/build-codex-pr-fix-prompt.mjs --template <file> --context <file> --output <file>",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let templatePath = "";
let contextPath = "";
let outputPath = "";

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--template") {
    templatePath = args[i + 1] ?? "";
    i += 1;
  } else if (arg === "--context") {
    contextPath = args[i + 1] ?? "";
    i += 1;
  } else if (arg === "--output") {
    outputPath = args[i + 1] ?? "";
    i += 1;
  } else {
    usage();
  }
}

if (!templatePath || !contextPath || !outputPath) {
  usage();
}

const template = fs.readFileSync(templatePath, "utf8").trim();
const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));

const sections = [];
sections.push(template);

sections.push(`## Repository

- Repo: ${context.repository}
- PR: #${context.pr.number} - ${context.pr.title}
- URL: ${context.pr.url}
- Base: ${context.pr.baseRef} (${context.pr.baseSha})
- Head: ${context.pr.headRef} (${context.pr.headSha})
- Triggered by: ${context.trigger.actor} via ${context.trigger.source}`);

if (context.trigger.url) {
  sections.push(`## Trigger Comment

- URL: ${context.trigger.url}
- Body:

\`\`\`text
${context.trigger.body || ""}
\`\`\``);
}

if (context.trigger.extraInstruction) {
  sections.push(`## Extra Instruction

\`\`\`text
${context.trigger.extraInstruction}
\`\`\``);
}

sections.push(`## Changed Files

\`\`\`json
${JSON.stringify(context.changedFiles ?? [], null, 2)}
\`\`\``);

sections.push(`## Failing Checks

\`\`\`json
${JSON.stringify(context.failingChecks ?? [], null, 2)}
\`\`\``);

sections.push(`## Pull Request Reviews

\`\`\`json
${JSON.stringify(context.reviews ?? [], null, 2)}
\`\`\``);

sections.push(`## Pull Request Review Comments

\`\`\`json
${JSON.stringify(context.reviewComments ?? [], null, 2)}
\`\`\``);

sections.push(`## Pull Request Issue Comments

\`\`\`json
${JSON.stringify(context.issueComments ?? [], null, 2)}
\`\`\``);

const outputDir = path.dirname(outputPath);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, `${sections.join("\n\n")}\n`, "utf8");
