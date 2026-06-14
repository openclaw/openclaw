import { spawnSync } from "node:child_process";
// Check Codex App Server Protocol script supports OpenClaw repository automation.
import fs from "node:fs/promises";
import path from "node:path";
import {
  generateExperimentalCodexAppServerProtocolSource,
  normalizeCodexAppServerProtocolJsonText,
  selectedCodexAppServerJsonSchemas,
} from "./lib/codex-app-server-protocol-source.js";

const generatedRoot = path.resolve(
  process.cwd(),
  "extensions/codex/src/app-server/protocol-generated",
);

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
      'type: "contextCompaction"',
      'type: "dynamicToolCall"',
      'type: "commandExecution"',
      'type: "mcpToolCall"',
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
    file: "v2/Account.ts",
    snippets: ['type: "apiKey"', 'type: "chatgpt"', 'type: "amazonBedrock"'],
  },
  {
    file: "v2/ThreadStartParams.ts",
    snippets: [
      "permissions?: string | null",
      "dynamicTools?: Array<DynamicToolSpec> | null",
      "experimentalRawEvents",
    ],
  },
  {
    file: "v2/TurnStartParams.ts",
    snippets: ["permissions?: string | null", "serviceTier?: string | null"],
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
await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const source = await generateExperimentalCodexAppServerProtocolSource();

  try {
    await compareGeneratedProtocolMirror(source.jsonRoot);
    await checkMaintainedProtocolTypes(source.typescriptRoot);

    for (const check of checks) {
      const filePath = path.join(source.typescriptRoot, check.file);
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
  } finally {
    await source.cleanup();
  }

  if (failures.length > 0) {
    console.error("Codex app-server generated protocol drift:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    console.error(
      `Run \`pnpm codex-app-server:protocol:sync\` after refreshing the Codex checkout at ${source.codexRepo}.`,
    );
    process.exit(1);
  }

  console.log(
    `Codex app-server generated protocol matches OpenClaw bridge assumptions: ${source.codexRepo}`,
  );
}

async function checkMaintainedProtocolTypes(sourceRoot: string): Promise<void> {
  // Turn responses are normalized into a uniform projector shape before their
  // checked-in JSON schemas validate them. Probe only raw contracts consumed directly.
  const probePath = path.join(sourceRoot, "openclaw-protocol-compatibility.ts");
  const protocolPath = path.resolve(process.cwd(), "extensions/codex/src/app-server/protocol.ts");
  const protocolImport = relativeTypeScriptImport(probePath, protocolPath);
  const generatedImport = (file: string) =>
    relativeTypeScriptImport(probePath, path.join(sourceRoot, file));
  const probe = `
import type {
  CodexDynamicToolSpec,
  CodexDynamicToolCallParams,
  CodexErrorNotification,
  CodexModelListResponse,
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadResumeParams,
  CodexThreadResumeResponse,
  CodexThreadStartParams,
  CodexThreadStartResponse,
  CodexTurnEnvironmentParams,
  CodexTurnInterruptParams,
  CodexTurnStartParams,
} from ${JSON.stringify(protocolImport)};
import type { DynamicToolCallParams } from ${JSON.stringify(generatedImport("v2/DynamicToolCallParams.ts"))};
import type { DynamicToolSpec } from ${JSON.stringify(generatedImport("v2/DynamicToolSpec.ts"))};
import type { ErrorNotification } from ${JSON.stringify(generatedImport("v2/ErrorNotification.ts"))};
import type { ModelListResponse } from ${JSON.stringify(generatedImport("v2/ModelListResponse.ts"))};
import type { ThreadForkParams } from ${JSON.stringify(generatedImport("v2/ThreadForkParams.ts"))};
import type { ThreadForkResponse } from ${JSON.stringify(generatedImport("v2/ThreadForkResponse.ts"))};
import type { ThreadResumeParams } from ${JSON.stringify(generatedImport("v2/ThreadResumeParams.ts"))};
import type { ThreadResumeResponse } from ${JSON.stringify(generatedImport("v2/ThreadResumeResponse.ts"))};
import type { ThreadStartParams } from ${JSON.stringify(generatedImport("v2/ThreadStartParams.ts"))};
import type { ThreadStartResponse } from ${JSON.stringify(generatedImport("v2/ThreadStartResponse.ts"))};
import type { TurnEnvironmentParams } from ${JSON.stringify(generatedImport("v2/TurnEnvironmentParams.ts"))};
import type { TurnInterruptParams } from ${JSON.stringify(generatedImport("v2/TurnInterruptParams.ts"))};
import type { TurnStartParams } from ${JSON.stringify(generatedImport("v2/TurnStartParams.ts"))};

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

type ProtocolCompatibilityChecks = [
  Assert<Assignable<CodexDynamicToolSpec, DynamicToolSpec>>,
  Assert<Assignable<CodexTurnEnvironmentParams, TurnEnvironmentParams>>,
  Assert<Assignable<CodexThreadStartParams, ThreadStartParams>>,
  Assert<Assignable<CodexThreadResumeParams, ThreadResumeParams>>,
  Assert<Assignable<CodexThreadForkParams, ThreadForkParams>>,
  Assert<Assignable<CodexTurnInterruptParams, TurnInterruptParams>>,
  Assert<Assignable<CodexTurnStartParams, TurnStartParams>>,
  Assert<
    Assignable<
      Omit<DynamicToolCallParams, "arguments">,
      Omit<CodexDynamicToolCallParams, "arguments">
    >
  >,
  Assert<Assignable<ErrorNotification, CodexErrorNotification>>,
  Assert<Assignable<ModelListResponse, CodexModelListResponse>>,
  Assert<Assignable<ThreadForkResponse, CodexThreadForkResponse>>,
  Assert<Assignable<ThreadResumeResponse, CodexThreadResumeResponse>>,
  Assert<Assignable<ThreadStartResponse, CodexThreadStartResponse>>,
];

export type { ProtocolCompatibilityChecks };
`;
  await fs.writeFile(probePath, probe);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-tsgo.mjs",
      "--ignoreConfig",
      "--noEmit",
      "--allowImportingTsExtensions",
      "--strict",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      probePath,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.error) {
    failures.push(`maintained protocol types: failed to start tsgo (${result.error.message})`);
    return;
  }
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    failures.push(`maintained protocol types differ from generated Codex types\n${output}`);
  }
}

function relativeTypeScriptImport(fromFile: string, toFile: string): string {
  const relative = path.relative(path.dirname(fromFile), toFile).replaceAll(path.sep, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function compareGeneratedProtocolMirror(sourceJsonRoot: string): Promise<void> {
  for (const schema of selectedCodexAppServerJsonSchemas) {
    const sourcePath = path.join(sourceJsonRoot, schema);
    const targetPath = path.join(generatedRoot, "json", schema);
    let sourceValue: string;
    let target: string;
    try {
      sourceValue = await fs.readFile(sourcePath, "utf8");
    } catch (error) {
      failures.push(
        `protocol-generated/json/${schema}: missing upstream schema (${String(error)})`,
      );
      continue;
    }
    try {
      target = await fs.readFile(targetPath, "utf8");
    } catch (error) {
      failures.push(`protocol-generated/json/${schema}: missing local schema (${String(error)})`);
      continue;
    }
    if (normalizeJsonSchema(sourceValue) !== normalizeJsonSchema(target)) {
      failures.push(`protocol-generated/json/${schema}: differs from source schema`);
    }
  }
}

function normalizeJsonSchema(sourceLocal: string): string {
  return normalizeCodexAppServerProtocolJsonText(sourceLocal);
}
