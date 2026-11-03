import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods, WorkboardStore } from "./runtime-api.js";
import { createWorkboardAutomationNudgeService } from "./src/automation-nudge.js";
import { createWorkboardChangeEventService } from "./src/change-events.js";
import { registerWorkboardCommand } from "./src/command.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
} from "./src/lifecycle-sync.js";
import { createWorkboardSessionsBoardService } from "./src/sessions-board.js";
import { resolveWorkboardSqliteWorkerModuleUrl } from "./src/sqlite-store-paths.js";
import { registerWorkboardStoreLifecycle } from "./src/store-lifecycle.js";
import { strictObject } from "./src/tools-card-mutations.js";
import { createWorkboardTools } from "./src/tools.js";
import {
  guardWorkboardToolsForWorkspaceAccess,
  WORKBOARD_CARD_TOOL_NAMES,
  WORKBOARD_SESSIONS_BOARD_TOOL_NAMES,
} from "./src/workspace-access.js";

const boardIdField = Type.Optional(
  Type.String({
    description: "Board id. May be omitted only when exactly one Sessions board exists.",
  }),
);

function optionalChoices<const T extends string>(choices: readonly T[]) {
  return Type.Optional(Type.Array(Type.Union(choices.map((choice) => Type.Literal(choice)))));
}

const matchRuleSchema = strictObject({
  health: optionalChoices([
    "on-track",
    "grinding",
    "stuck",
    "waiting-on-user",
    "wrapping-up",
    "done",
    "failed",
  ]),
  run: optionalChoices(["active", "idle", "failed"]),
  pullRequest: optionalChoices(["none", "open", "draft", "merged", "closed"]),
  archived: Type.Optional(Type.Boolean()),
});

const columnSchema = strictObject({
  id: Type.String({
    minLength: 1,
    maxLength: 48,
    pattern: "^[a-z0-9][a-z0-9-]{0,47}$",
    description: "Stable column id. Keep this id when renaming the label.",
  }),
  label: Type.String({ minLength: 1, maxLength: 60 }),
  color: Type.Optional(
    Type.String({ description: "red, blue, green, yellow, purple, orange, pink, or cyan." }),
  ),
  description: Type.String({
    minLength: 1,
    maxLength: 400,
    description: "Description shown in the column tooltip.",
  }),
  match: Type.Optional(Type.Union([matchRuleSchema, Type.Array(matchRuleSchema, { minItems: 1 })])),
  fallback: Type.Optional(
    Type.Boolean({ description: "Exactly one column must be the unresolved-session fallback." }),
  ),
});

const sessionsBoardReadSchema = strictObject({ boardId: boardIdField });

const sessionsBoardUpdateSchema = strictObject({
  boardId: boardIdField,
  columns: Type.Optional(Type.Array(columnSchema, { minItems: 2, maxItems: 12 })),
  scope: Type.Optional(
    strictObject({
      agentIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      includeArchived: Type.Optional(Type.Boolean()),
      includeAutomation: Type.Optional(
        Type.Boolean({
          description: "Include automation (cron) and system sessions. Defaults to false.",
        }),
      ),
      includeHome: Type.Optional(
        Type.Boolean({
          description: "Include each agent's Home session. Defaults to false.",
        }),
      ),
      maxAgeHours: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    }),
  ),
});

const sessionsBoardMoveSchema = strictObject({
  boardId: boardIdField,
  sessionKey: Type.String({ description: "Exact session key from the board read." }),
  columnId: Type.String({
    description: "Destination column id from the board read.",
  }),
});

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerWorkboardCli } = await import("./src/cli.js");
        registerWorkboardCli({
          program,
          withStore: async (action) => {
            const cliStore = WorkboardStore.openSqlite(
              resolveWorkboardSqliteWorkerModuleUrl(api.runtimeSource),
            );
            try {
              return await action(cliStore);
            } finally {
              await cliStore.close();
            }
          },
        });
      },
      {
        descriptors: [
          {
            name: "workboard",
            description: "Manage Workboard cards and worker dispatch",
            hasSubcommands: true,
          },
        ],
      },
    );
    if (api.registrationMode === "cli-metadata") {
      return;
    }
    const store = WorkboardStore.openSqlite(
      resolveWorkboardSqliteWorkerModuleUrl(api.runtimeSource),
      { lazy: api.registrationMode === "tool-discovery" },
    );
    const resourceServices: Array<{ stop(): void | Promise<void> }> = [];
    registerWorkboardStoreLifecycle(api, store, async () => {
      await Promise.all(resourceServices.map(async (service) => await service.stop()));
    });
    const changeEvents = createWorkboardChangeEventService(store);
    resourceServices.push(changeEvents);
    const automationNudge = createWorkboardAutomationNudgeService({
      store,
    });
    resourceServices.push(automationNudge);
    const sessionsBoard = createWorkboardSessionsBoardService({
      store,
      gateway: api.runtime.gateway,
    });
    resourceServices.push(sessionsBoard);
    const lifecycleSync = createWorkboardLifecycleService({
      store,
      worktrees: api.runtime.worktrees,
      readSessions: async (options) =>
        await readWorkboardLifecycleSessions(api.runtime.gateway, options),
      onMatched: automationNudge.nudge,
    });
    resourceServices.push(lifecycleSync);
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "workboard",
      label: "Workboard",
      placement: "route:workboard",
      icon: "kanban",
      group: "control",
      requiredScopes: ["operator.read"],
    });
    for (const [id, label, scope] of [
      ["board", "Workboard board", "operator.read"],
      ["card", "Workboard card", "operator.write"],
      ["mini", "Workboard summary", "operator.read"],
    ] as const) {
      api.session.controls.registerControlUiDescriptor({
        surface: "widget",
        id,
        label,
        requiredScopes: [scope],
      });
    }
    registerWorkboardGatewayMethods({ api, store, sessionsBoard });
    registerWorkboardCommand({ api, store });
    for (const service of [changeEvents, automationNudge, sessionsBoard, lifecycleSync]) {
      api.registerService(service);
    }
    api.on("gateway_start", (_event, context) => lifecycleSync.onGatewayStart(context.abortSignal));
    api.on("gateway_stop", () => lifecycleSync.onGatewayStop());
    api.on("subagent_ended", (event) =>
      store.runOperation(async () => {
        await syncWorkboardSubagentEnded({
          store,
          worktrees: api.runtime.worktrees,
          event,
          onMatched: automationNudge.nudge,
        });
      }),
    );
    api.on("agent_end", (event, context) =>
      store.runOperation(async () => {
        await syncWorkboardAgentEnded({
          store,
          event,
          context,
          readSessions: lifecycleSync.readSessions,
          onMatched: automationNudge.nudge,
        });
      }),
    );
    api.registerTool(
      (context) =>
        guardWorkboardToolsForWorkspaceAccess(
          createWorkboardTools({ context, store }),
          context,
          api.runtime.sandbox.resolveWorkspaceAuthority,
        ),
      {
        names: [...WORKBOARD_CARD_TOOL_NAMES],
        optional: true,
      },
    );
    // The docked Board agent needs these without a tools.allow entry.
    api.registerTool(
      {
        contextVersion: 2,
        create: (ctx) => {
          const caller = { assertCurrent: ctx.assertInvocationCurrent };
          const resolveBoardId = async (record: Record<string, unknown>): Promise<string> => {
            if (record.boardId !== undefined) {
              return readStringParam(record, "boardId", { required: true });
            }
            const boards = (await store.listBoards()).boards.filter(
              (board) => board.kind === "sessions",
            );
            const board = boards[0];
            if (boards.length === 1 && board) {
              return board.id;
            }
            throw new Error(
              boards.length === 0
                ? 'No Sessions board exists. Create one with workboard_board_create and kind: "sessions".'
                : "boardId is required when more than one Sessions board exists. Use workboard_boards to choose one.",
            );
          };
          const tools: AnyAgentTool[] = [
            {
              name: "workboard_sessions_board_read",
              label: "Sessions Board Read",
              description:
                "Read a Sessions board and its session placements. Columns match Gateway-owned session status, observer health, and pull-request facts in order; operator pins take precedence. Card tools do not apply to Sessions boards.",
              parameters: sessionsBoardReadSchema,
              execute: async (_toolCallId, rawParams) => {
                const record = asNonArrayRecord(rawParams);
                return jsonResult(
                  await sessionsBoard.read(await resolveBoardId(record), undefined, caller),
                );
              },
            },
            {
              name: "workboard_sessions_board_update",
              label: "Sessions Board Update",
              description:
                "Edit a Sessions board's columns, match rules, or scope. columns replaces the full ordered list; preserve ids when renaming labels. All fields in each rule must match; a match array accepts any rule, and the first matching column wins. Exactly one fallback is required. Card tools do not apply to Sessions boards.",
              parameters: sessionsBoardUpdateSchema,
              execute: async (_toolCallId, rawParams) => {
                const record = asNonArrayRecord(rawParams);
                const boardId = await resolveBoardId(record);
                const { boardId: _boardId, ...patch } = record;
                return jsonResult({ board: await sessionsBoard.update(boardId, patch, caller) });
              },
            },
            {
              name: "workboard_sessions_board_move",
              label: "Sessions Board Move",
              description:
                "Pin a session in a Sessions board column. The pin overrides match rules while the column exists. Card tools do not apply to Sessions boards.",
              parameters: sessionsBoardMoveSchema,
              execute: async (_toolCallId, rawParams) => {
                const record = asNonArrayRecord(rawParams);
                return jsonResult(
                  await sessionsBoard.move(
                    await resolveBoardId(record),
                    readStringParam(record, "sessionKey", { required: true }),
                    readStringParam(record, "columnId", { required: true }),
                    caller,
                  ),
                );
              },
            },
          ];
          for (const tool of tools) {
            const execute = tool.execute;
            tool.execute = (...args) => store.runOperation(() => execute(...args));
          }
          return tools;
        },
      },
      { names: [...WORKBOARD_SESSIONS_BOARD_TOOL_NAMES] },
    );
  },
});
