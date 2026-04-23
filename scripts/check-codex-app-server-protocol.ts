import fs from "node:fs/promises";
import path from "node:path";

const codexRepo = process.env.OPENCLAW_CODEX_REPO
  ? path.resolve(process.env.OPENCLAW_CODEX_REPO)
  : path.resolve(process.cwd(), "../codex");
const schemaRoot = path.join(codexRepo, "codex-rs/app-server-protocol/schema/typescript");

const checks: Array<{ file: string; snippets: string[] }> = [
  {
    file: "ServerRequest.ts",
    snippets: [
      '"item/commandExecution/requestApproval"',
      '"item/fileChange/requestApproval"',
      '"item/permissions/requestApproval"',
      '"item/tool/call"',
    ],
  },
  {
    file: "v2/ThreadItem.ts",
    snippets: [
      '"type": "contextCompaction"',
      '"type": "dynamicToolCall"',
      '"type": "commandExecution"',
      '"type": "mcpToolCall"',
    ],
  },
  {
    file: "v2/DynamicToolSpec.ts",
    snippets: ["name: string", "description: string", "inputSchema: JsonValue"],
  },
  {
    file: "v2/CommandExecutionApprovalDecision.ts",
    snippets: ['"accept"', '"acceptForSession"', '"decline"', '"cancel"'],
  },
  {
    file: "ReviewDecision.ts",
    snippets: ['"approved"', '"approved_for_session"', '"denied"', '"abort"'],
  },
  {
    file: "v2/PlanDeltaNotification.ts",
    snippets: ["itemId: string", "delta: string"],
  },
  {
    file: "v2/TurnPlanUpdatedNotification.ts",
    snippets: ["explanation: string | null", "plan: Array<TurnPlanStep>"],
  },
];

const failures: string[] = [];

for (const check of checks) {
  const filePath = path.join(schemaRoot, check.file);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    failures.push(`${check.file}: missing (${String(error)})`);
    continue;
  }
  for (const snippet of check.snippets) {
    if (!text.includes(snippet)) {
      failures.push(`${check.file}: missing ${snippet}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Codex app-server generated protocol drift:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Codex app-server generated protocol matches OpenClaw bridge assumptions: ${schemaRoot}`,
);
