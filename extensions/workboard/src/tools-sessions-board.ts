import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import type { WorkboardSessionsBoardService } from "./sessions-board.js";
import type { WorkboardStore } from "./store.js";
import { strictObject } from "./tools-card-mutations.js";

const boardIdField = Type.Optional(
  Type.String({
    description: "Board id. May be omitted only when exactly one Sessions board exists.",
  }),
);

const matchRuleSchema = strictObject({
  health: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("on-track"),
        Type.Literal("grinding"),
        Type.Literal("stuck"),
        Type.Literal("waiting-on-user"),
        Type.Literal("wrapping-up"),
        Type.Literal("done"),
        Type.Literal("failed"),
      ]),
    ),
  ),
  run: Type.Optional(
    Type.Array(Type.Union([Type.Literal("active"), Type.Literal("idle"), Type.Literal("failed")])),
  ),
  pullRequest: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("none"),
        Type.Literal("open"),
        Type.Literal("draft"),
        Type.Literal("merged"),
        Type.Literal("closed"),
      ]),
    ),
  ),
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

export function createWorkboardSessionsBoardTools(params: {
  store: WorkboardStore;
  caller: { assertCurrent: () => void };
  sessionsBoard?: Pick<WorkboardSessionsBoardService, "read" | "update" | "move">;
}): AnyAgentTool[] {
  const service = () => {
    if (!params.sessionsBoard) {
      throw new Error("Sessions board service is unavailable.");
    }
    return params.sessionsBoard;
  };
  const resolveBoardId = async (record: Record<string, unknown>): Promise<string> => {
    if (record.boardId !== undefined) {
      return readStringParam(record, "boardId", { required: true });
    }
    const boards = (await params.store.listBoards()).boards.filter(
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
      parameters: strictObject({ boardId: boardIdField }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        return jsonResult(
          await service().read(await resolveBoardId(record), undefined, params.caller),
        );
      },
    },
    {
      name: "workboard_sessions_board_update",
      label: "Sessions Board Update",
      description:
        "Edit a Sessions board's columns, match rules, or scope. columns replaces the full ordered list; preserve ids when renaming labels. All fields in each rule must match; a match array accepts any rule, and the first matching column wins. Exactly one fallback is required. Card tools do not apply to Sessions boards.",
      parameters: strictObject({
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
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        const boardId = await resolveBoardId(record);
        const { boardId: _boardId, ...patch } = record;
        return jsonResult({ board: await service().update(boardId, patch, params.caller) });
      },
    },
    {
      name: "workboard_sessions_board_move",
      label: "Sessions Board Move",
      description:
        "Pin a session in a Sessions board column. The pin overrides match rules while the column exists. Card tools do not apply to Sessions boards.",
      parameters: strictObject({
        boardId: boardIdField,
        sessionKey: Type.String({ description: "Exact session key from the board read." }),
        columnId: Type.String({ description: "Destination column id from the board read." }),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        return jsonResult(
          await service().move(
            await resolveBoardId(record),
            readStringParam(record, "sessionKey", { required: true }),
            readStringParam(record, "columnId", { required: true }),
            params.caller,
          ),
        );
      },
    },
  ];
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = (...args) => params.store.runOperation(() => execute(...args));
  }
  return tools;
}
