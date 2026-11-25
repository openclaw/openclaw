import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { format } from "oxfmt";
import { ObjectOptions, Type, type TSchema } from "typebox";
import { Intern } from "typebox/schema";
import { AgentRuntimeRestrictionErrorDetailsSchema } from "../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js";
import {
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
} from "../packages/gateway-protocol/src/schema/approvals.js";
import { BoardSnapshotSchema } from "../packages/gateway-protocol/src/schema/board.js";
import { CommandsListResultSchema } from "../packages/gateway-protocol/src/schema/commands.js";
import {
  AgentActivityItemSchema,
  AgentActivityDelegationSchema,
  ChatHistoryParamsSchema,
  ChatPendingInputsPageSchema,
} from "../packages/gateway-protocol/src/schema/logs-chat.js";
import { ProgressCardSchema } from "../packages/gateway-protocol/src/schema/progress-card.js";
import { SessionParticipantIdentitySchema } from "../packages/gateway-protocol/src/schema/session-participant.js";
import { SessionsCreateParamsSchema } from "../packages/gateway-protocol/src/schema/sessions-create.js";
import {
  SessionsGoalClearParamsSchema,
  SessionsGoalUpdateParamsSchema,
} from "../packages/gateway-protocol/src/schema/sessions-goal.js";
import {
  MessageReactionSummarySchema,
  SessionReactionEventSchema,
} from "../packages/gateway-protocol/src/schema/sessions-reactions.js";
import {
  SessionPermissionModeSchema,
  SessionRowSchema,
  SessionToolOverridesSchema,
} from "../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  SessionNarrationEventSchema,
  SessionObserverDigestSchema,
  SessionsFilesGetResultSchema,
} from "../packages/gateway-protocol/src/schema/sessions.js";
import { TalkVoiceChangeEventSchema } from "../packages/gateway-protocol/src/schema/talk-voice.js";
import { CHAT_TRANSCRIPT_METADATA_KEYS } from "../ui/src/pages/chat/chat-transcript-metadata.ts";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mts";
import {
  assertStandaloneValidatorSource,
  compileStandaloneValidators,
  standaloneValidatorHeader,
} from "./lib/typebox-standalone.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputBase = "ui/src/lib/protocol-validators.generated";
const schemaRoot = "../../../../packages/gateway-protocol/src/schema/";
type Group =
  | "activity"
  | "approvals"
  | "session-input"
  | "transcript"
  | "board"
  | "history-state"
  | "sender-identity";
const additionalLintRules: Partial<Record<Group, string[]>> = {
  activity: ["eslint/curly"],
  approvals: ["unicorn/no-useless-length-check"],
};
const validators: Array<[name: string, schema: TSchema, type: string, group: Group]> = [
  [
    "BoardSnapshot",
    BoardSnapshotSchema,
    'import("' + schemaRoot + 'board.js").BoardSnapshot',
    "board",
  ],
  [
    "SessionParticipantIdentity",
    SessionParticipantIdentitySchema,
    'import("../schema/session-participant.js").SessionParticipantIdentity',
    "sender-identity",
  ],
  [
    "AgentActivityItem",
    AgentActivityItemSchema,
    'import("' + schemaRoot + 'logs-chat.js").AgentActivityItem',
    "activity",
  ],
  [
    "AgentRuntimeRestrictionErrorDetails",
    AgentRuntimeRestrictionErrorDetailsSchema,
    'import("../../../../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js").AgentRuntimeRestrictionErrorDetails',
    "session-input",
  ],
  [
    "SessionObserverDigest",
    SessionObserverDigestSchema,
    'import("' + schemaRoot + 'sessions.js").SessionObserverDigest',
    "activity",
  ],
  [
    "SessionNarrationEvent",
    SessionNarrationEventSchema,
    'import("' + schemaRoot + 'sessions.js").SessionNarrationEvent',
    "activity",
  ],
  [
    "SessionReactionEvent",
    SessionReactionEventSchema,
    'import("' + schemaRoot + 'sessions-reactions.js").SessionReactionEvent',
    "activity",
  ],
  [
    "SessionApprovalEvent",
    SessionApprovalEventSchema,
    'import("' + schemaRoot + 'approvals.js").SessionApprovalEvent',
    "approvals",
  ],
  [
    "SessionApprovalReplay",
    SessionApprovalReplaySchema,
    'import("' + schemaRoot + 'approvals.js").SessionApprovalReplay',
    "approvals",
  ],
  [
    "SessionsGoalUpdateParams",
    SessionsGoalUpdateParamsSchema,
    'import("' + schemaRoot + 'sessions-goal.js").SessionsGoalUpdateParams',
    "session-input",
  ],
  [
    "SessionsGoalClearParams",
    SessionsGoalClearParamsSchema,
    'import("' + schemaRoot + 'sessions-goal.js").SessionsGoalClearParams',
    "session-input",
  ],
  ...(
    [
      "worktreeSource",
      "deviceFolder",
      "repository",
      "fastMode",
      "cyberAccessProgram",
      "titleSource",
    ] as const
  ).map((key): [string, TSchema, string, Group] => [
    `Session${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    SessionsCreateParamsSchema.properties[key],
    `import("${schemaRoot}sessions-create.js").SessionsCreateParams["${key}"]`,
    "session-input",
  ]),
  [
    "SessionPermissionMode",
    SessionPermissionModeSchema,
    'import("' + schemaRoot + 'sessions-row.js").SessionPermissionMode',
    "session-input",
  ],
  [
    "SessionToolOverrides",
    SessionToolOverridesSchema,
    'import("' + schemaRoot + 'sessions-row.js").SessionToolOverrides',
    "session-input",
  ],
  [
    "ChatHistoryState",
    Type.Object(
      {
        stateRevision: Type.Required(ChatHistoryParamsSchema).properties.knownState,
        pendingInputs: Type.Optional(ChatPendingInputsPageSchema),
        sessionInfo: Type.Optional(SessionRowSchema),
        commands: Type.Optional(CommandsListResultSchema.properties.commands),
      },
      { additionalProperties: false },
    ),
    'import("../../pages/chat/chat-transcript-metadata.ts").ChatHistoryState',
    "history-state",
  ],
  [
    "ChatTranscriptMetadata",
    Type.Pick(SessionRowSchema, CHAT_TRANSCRIPT_METADATA_KEYS),
    'import("../../pages/chat/chat-transcript-metadata.ts").ChatTranscriptMetadata',
    "transcript",
  ],
  [
    "ProgressCard",
    ProgressCardSchema,
    'import("' + schemaRoot + 'progress-card.js").ProgressCard',
    "transcript",
  ],
  [
    "MessageReactionSummary",
    MessageReactionSummarySchema,
    'import("' + schemaRoot + 'sessions-reactions.js").MessageReactionSummary',
    "transcript",
  ],
  [
    "TalkVoiceChangeEvent",
    TalkVoiceChangeEventSchema,
    'import("' + schemaRoot + 'talk-voice.js").TalkVoiceChangeEvent',
    "session-input",
  ],
  [
    "SessionFileReadMetadata",
    Type.Pick(SessionsFilesGetResultSchema, ["root", "source"]),
    'Pick<import("' + schemaRoot + 'sessions.js").SessionsFilesGetResult, "root" | "source">',
    "session-input",
  ],
];

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: pnpm ui:validators:gen [--check]");
  }
  // Activity receipts are the only nested record; keep their cleaner schema-derived too.
  for (const schema of [AgentActivityItemSchema, AgentActivityDelegationSchema]) {
    if (ObjectOptions(schema).additionalProperties !== false) {
      throw new Error("Activity cleaners require closed records");
    }
  }
  const cleaner = `const activityKeys = new Set(${JSON.stringify(Object.keys(AgentActivityItemSchema.properties))});
    const delegationKeys = new Set(${JSON.stringify(Object.keys(AgentActivityDelegationSchema.properties))});
    function cleanRecord(value, keys) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      for (const key of Object.getOwnPropertyNames(value)) {
        if (!keys.has(key)) delete value[key];
      }
      return value;
    }
    export function cleanAgentActivityItem(value) {
      cleanRecord(value, activityKeys);
      if (value && typeof value === "object" && Array.isArray(value.delegation)) {
        for (const receipt of value.delegation) cleanRecord(receipt, delegationKeys);
      }
      return value;
    }`;
  for (const group of [
    "activity",
    "approvals",
    "session-input",
    "transcript",
    "history-state",
    "sender-identity",
    "board",
  ] as const) {
    const selected = validators.filter((entry) => entry[3] === group);
    // Share repeated shapes only within each existing lazy boundary.
    const shareSchemaFunctions = ["activity", "approvals", "session-input"].includes(group);
    const compiled = await compileStandaloneValidators(
      selected.map(([name, schema]) => ({
        name: `is${name}`,
        schema:
          name === "ChatHistoryState" || name === "ChatTranscriptMetadata"
            ? Intern(schema)
            : schema,
      })),
      { resolveDir: repoRoot, shareSchemaFunctions, hoistSchemaFunctions: shareSchemaFunctions },
    );
    const source = [compiled, ...(group === "activity" ? [cleaner] : [])].join("\n");
    const result = await build({
      stdin: { contents: source, resolveDir: repoRoot, loader: "js" },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      minifySyntax: true,
      // Remove esbuild's physical input-path banners before canonical formatting.
      // The TypeBox license is retained explicitly below.
      minifyWhitespace: true,
      legalComments: "none",
    });
    const outputFile = result.outputFiles[0];
    if (!outputFile) {
      throw new Error(`${group}: standalone validator build emitted no output`);
    }
    const runtime = outputFile.text;
    assertStandaloneValidatorSource(runtime);
    const declaration = selected
      .map(([name, , type]) => `export function is${name}(value: unknown): value is ${type};`)
      .concat(
        group === "activity"
          ? ["export function cleanAgentActivityItem(value: unknown): unknown;"]
          : [],
      )
      .join("\n");
    for (const [extension, contents] of [
      ["js", runtime],
      ["d.ts", declaration],
    ]) {
      const outputPath =
        group === "sender-identity"
          ? `packages/gateway-protocol/src/compiled/sender-identity.${extension}`
          : `${outputBase}/${group}.${extension}`;
      const generatedHeader = standaloneValidatorHeader("pnpm ui:validators:gen", {
        declaration: extension === "d.ts",
        additionalLintRules: additionalLintRules[group],
      });
      const formatted = await format(outputPath, generatedHeader + contents);
      if (formatted.errors.length) {
        throw new Error(`Cannot format ${outputPath}: ${JSON.stringify(formatted.errors)}`);
      }
      const output = writeGeneratedOutput({
        check: args.includes("--check"),
        next: formatted.code,
        outputPath,
        repoRoot,
      });
      if (args.includes("--check") && output.changed) {
        throw new Error(`${outputPath} is stale; run pnpm ui:validators:gen`);
      }
      console.log(`[ui:validators] ${output.changed ? "updated" : "unchanged"} ${outputPath}`);
    }
  }
}

await main();
