import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ErrorObject } from "ajv";
import Database from "better-sqlite3";
import { z } from "zod";
import type { McpToolResult } from "./proxy.js";
import { LEGACY_DEFAULT_WORKSPACE_ID } from "./workspace-context.js";

const DEFAULT_DB_PATH = join(homedir(), ".airya", "data", "airya.db");
const AIRYA_DEFAULT_REPO_ROOT = join(homedir(), "Projects", "airya");
const AIRYA_WORKTREES_ROOT = join(AIRYA_DEFAULT_REPO_ROOT, ".worktrees");
const RUN_STATUSES = [
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
] as const;
const WORK_ITEM_STATUSES = ["backlog", "todo", "ready", "archived"] as const;
const CARD_TYPES = ["bug", "feature", "initiative", "chore", "rfc", "proposal", "product"] as const;
const CARD_TYPE_SET = new Set<string>(CARD_TYPES);
const STRATEGIC_CARD_TYPES = new Set<string>(["feature", "initiative", "rfc", "product"]);
const STRATEGIC_CREATORS = new Set<string>(["hans", "airya"]);

export interface EngineToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (input: Record<string, unknown>) => Promise<McpToolResult>;
}

export interface EngineToolOptions {
  db?: Database.Database;
  dbPath?: string;
  homeDir?: string;
  defaultWorkspaceId?: string;
  actorName?: string;
  foremanStateMode?: "full" | "workspace";
  now?: () => string;
  generateId?: () => string;
}

export interface EngineToolRegistrar {
  tool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (input: Record<string, unknown>) => Promise<McpToolResult>,
  ): void;
}

interface EngineRuntime {
  db: Database.Database;
  dbPath: string;
  homeDir: string;
  defaultWorkspaceId: string;
  actorName: string;
  foremanStateMode: "full" | "workspace";
  now: () => string;
  generateId: () => string;
}

const sharedDbs = new Map<string, Database.Database>();
const require = createRequire(import.meta.url);
const AjvModule = require("ajv") as {
  default?: new (options?: Record<string, unknown>) => {
    compile: (schema: unknown) => { (value: unknown): boolean; errors?: ErrorObject[] | null };
  };
};
const AjvConstructor =
  AjvModule.default ??
  (AjvModule as unknown as new (options?: Record<string, unknown>) => {
    compile: (schema: unknown) => { (value: unknown): boolean; errors?: ErrorObject[] | null };
  });
const addFormatsModule = require("ajv-formats") as {
  default?: (ajv: {
    compile: (schema: unknown) => { (value: unknown): boolean; errors?: ErrorObject[] | null };
  }) => void;
};
const addFormatsFn =
  addFormatsModule.default ??
  (addFormatsModule as unknown as (ajv: {
    compile: (schema: unknown) => { (value: unknown): boolean; errors?: ErrorObject[] | null };
  }) => void);
const schemaValidator = new AjvConstructor({
  allErrors: true,
  strict: false,
  strictSchema: true,
  validateSchema: true,
});
addFormatsFn(schemaValidator);

type JsonSchemaLike = boolean | Record<string, unknown>;
type LaneProjectionModule = {
  buildLaneProjection: (input: Record<string, unknown>) => Record<string, unknown>;
};
let laneProjectionModulePromise: Promise<LaneProjectionModule> | null = null;

export function createEngineToolDefinitions(
  options: EngineToolOptions = {},
): EngineToolDefinition[] {
  const runtime = createRuntime(options);

  return [
    {
      name: "engine_create_run",
      description:
        "Create a queued workflow run snapshot from an approved definition. Does not enqueue execution.",
      schema: {
        definition_id: z.string().uuid().describe("Workflow definition ID"),
        workspace_id: z
          .string()
          .uuid()
          .optional()
          .describe("Workspace ID (defaults to MCP server workspace)"),
        card_id: z.string().uuid().optional().describe("Optional linked work item ID"),
        created_by: z.string().min(1).optional().describe("Actor creating the run"),
        input: z.record(z.unknown()).optional().describe("Workflow input payload"),
      },
      handler: async (input) => handleCreateRun(input, runtime),
    },
    {
      name: "engine_get_run",
      description: "Get workflow run state, node states, and cost.",
      schema: {
        run_id: z.string().min(1).describe("Workflow run ID"),
        workspace_id: z.string().uuid().optional().describe("Optional workspace guard"),
      },
      handler: async (input) => handleGetRun(input, runtime),
    },
    {
      name: "engine_list_runs",
      description: "List workflow runs with optional status or card filters.",
      schema: {
        workspace_id: z
          .string()
          .uuid()
          .optional()
          .describe("Workspace ID (defaults to MCP server workspace)"),
        status: z.enum(RUN_STATUSES).optional().describe("Optional status filter"),
        card_id: z.string().uuid().optional().describe("Optional linked work item filter"),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max rows to return (default 20)"),
      },
      handler: async (input) => handleListRuns(input, runtime),
    },
    {
      name: "engine_create_task",
      description: "Create a work item card directly in the engine store.",
      schema: {
        title: z.string().min(1).describe("Work item title"),
        description: z.string().optional().describe("Optional description"),
        workspace_id: z
          .string()
          .uuid()
          .optional()
          .describe("Workspace ID (defaults to MCP server workspace)"),
        status: z
          .enum(WORK_ITEM_STATUSES)
          .optional()
          .describe("Initial persisted work item status"),
        priority: z.number().int().min(0).max(100).optional().describe("Priority (0-100)"),
        card_type: z.enum(CARD_TYPES).optional().describe("Optional canonical card type"),
        tags: z.array(z.string()).optional().describe("Optional card tags"),
        parent_card_id: z.string().uuid().optional().describe("Optional parent card/work item ID"),
        created_by: z.string().min(1).optional().describe("Creator identifier"),
      },
      handler: async (input) => handleCreateTask(input, runtime),
    },
    {
      name: "engine_update_task",
      description: "Update work item status, stage, or metadata directly in the engine store.",
      schema: {
        work_item_id: z.string().uuid().describe("Work item ID"),
        workspace_id: z.string().uuid().optional().describe("Optional workspace guard"),
        title: z.string().min(1).optional().describe("Updated title"),
        description: z.string().optional().describe("Updated description"),
        status: z.enum(WORK_ITEM_STATUSES).optional().describe("Updated persisted status"),
        priority: z.number().int().min(0).max(100).optional().describe("Updated priority"),
        current_stage: z.string().min(1).optional().describe("Updated workflow/card stage"),
        card_type: z.enum(CARD_TYPES).optional().describe("Updated canonical card type"),
        governance_tier: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe("Updated governance tier"),
        flow_template: z.string().min(1).optional().describe("Updated flow template"),
        parent_card_id: z.string().uuid().optional().describe("Updated parent card/work item ID"),
        created_by: z.string().min(1).optional().describe("Updated creator identifier"),
        tags: z.array(z.string()).optional().describe("Updated tags"),
      },
      handler: async (input) => handleUpdateTask(input, runtime),
    },
    {
      name: "engine_get_foreman_state",
      description:
        "Summarize foreman rehydration state from task checkpoints, project snapshots, and local SQLite engine state.",
      schema: {},
      handler: async () => handleGetForemanState(runtime),
    },
  ];
}

export function registerEngineTools(
  server: EngineToolRegistrar,
  options: EngineToolOptions = {},
): string[] {
  const definitions = createEngineToolDefinitions(options);
  for (const definition of definitions) {
    server.tool(definition.name, definition.description, definition.schema, definition.handler);
  }
  return definitions.map((definition) => definition.name);
}

function createRuntime(options: EngineToolOptions): EngineRuntime {
  return {
    db: options.db ?? getSharedDb(options.dbPath),
    dbPath:
      options.dbPath ?? (options.db ? ":memory:" : (process.env.AIRYA_DB_PATH ?? DEFAULT_DB_PATH)),
    homeDir: options.homeDir ?? homedir(),
    defaultWorkspaceId:
      options.defaultWorkspaceId ?? process.env.AIRYA_WORKSPACE_ID ?? LEGACY_DEFAULT_WORKSPACE_ID,
    actorName: resolveActorName(options.actorName),
    foremanStateMode: options.foremanStateMode ?? "full",
    now: options.now ?? (() => new Date().toISOString()),
    generateId: options.generateId ?? randomUUID,
  };
}

function getSharedDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env.AIRYA_DB_PATH ?? DEFAULT_DB_PATH;
  const cached = sharedDbs.get(resolvedPath);
  if (cached) {
    return cached;
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(
      `AiRYA database not found at ${resolvedPath}. Set AIRYA_DB_PATH or start AiRYA HQ first.`,
    );
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  sharedDbs.set(resolvedPath, db);
  return db;
}

async function handleCreateRun(
  input: Record<string, unknown>,
  runtime: EngineRuntime,
): Promise<McpToolResult> {
  const definitionId = String(input.definition_id);
  const workspaceId = resolveWorkspaceId(input.workspace_id, runtime);
  const workflowInput = asObject(input.input);
  const cardId = asOptionalString(input.card_id);
  const actor = resolveFixedActor(input.created_by, runtime);
  if (!actor.ok) {
    return errorResult(actor.payload);
  }

  // Workflow definitions are global records keyed by ID; do not workspace-scope this lookup.
  const definitionRow = runtime.db
    .prepare("SELECT * FROM workflow_definitions WHERE id = ?")
    .get(definitionId) as Record<string, unknown> | undefined;
  if (!definitionRow) {
    return errorResult({ error: `Workflow definition not found: ${definitionId}` });
  }

  const definition = normalizeWorkflowDefinition(definitionRow);
  const definitionStatus = asOptionalString(definition.status)?.toLowerCase() ?? "";
  if (definitionStatus !== "approved") {
    return errorResult({
      error: `Workflow definition ${definitionId} is not approved (status: ${definitionStatus || "unknown"}).`,
      code: "WORKFLOW_NOT_APPROVED",
    });
  }

  const definitionVisibilityError = validateWorkflowDefinitionVisibility(definition, workspaceId);
  if (definitionVisibilityError) {
    return errorResult(definitionVisibilityError);
  }

  const validation = validateInputAgainstSchema(
    workflowInput,
    definition.input_schema as JsonSchemaLike,
  );
  if (validation.schemaError) {
    return errorResult({
      error: validation.schemaError,
      code: "WORKFLOW_INPUT_SCHEMA_INVALID",
    });
  }
  if (validation.errors.length > 0) {
    return errorResult({
      error: "Workflow input failed schema validation.",
      code: "WORKFLOW_INPUT_VALIDATION_FAILED",
      details: validation.errors,
    });
  }

  if (cardId) {
    const cardRow = runtime.db
      .prepare("SELECT id FROM work_items WHERE id = ? AND workspace_id = ?")
      .get(cardId, workspaceId) as Record<string, unknown> | undefined;
    if (!cardRow) {
      return errorResult({
        error: `Work item not found: ${cardId}`,
        code: "WORK_ITEM_NOT_FOUND",
      });
    }
  }

  const runId = runtime.generateId();
  const now = runtime.now();
  const executionSnapshot = {
    workflow_definition: {
      id: definition.id,
      name: definition.name,
      version: definition.version,
      input_schema: definition.input_schema,
      output_schema: definition.output_schema,
      steps: definition.steps,
    },
    frozen_at: now,
  };

  const initialNodes = buildInitialNodes({
    runId,
    workspaceId,
    steps: Array.isArray(definition.steps) ? definition.steps : [],
    now,
    generateId: runtime.generateId,
  });

  const insertRun = runtime.db.prepare(`
    INSERT INTO workflow_runs (
      id, workspace_id, workflow_definition_id, workflow_type, execution_snapshot,
      status, input, total_cost_usd, created_by, card_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertNode = runtime.db.prepare(`
    INSERT INTO workflow_run_nodes (
      id, run_id, workspace_id, node_key, node_type, step_definition, status,
      idempotency_key, retry_count, max_retries, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = runtime.db.transaction(() => {
    insertRun.run(
      runId,
      workspaceId,
      definitionId,
      String(definition.name),
      JSON.stringify(executionSnapshot),
      "queued",
      JSON.stringify(workflowInput),
      0,
      actor.actorName,
      cardId ?? null,
      now,
      now,
    );

    for (const node of initialNodes) {
      insertNode.run(
        node.id,
        runId,
        workspaceId,
        node.node_key,
        node.node_type,
        JSON.stringify(node.step_definition),
        node.status,
        node.idempotency_key,
        node.retry_count,
        node.max_retries,
        now,
        now,
      );
    }
  });

  transaction();

  return okResult({
    created: true,
    run_id: runId,
    workflow_name: definition.name,
    status: "queued",
    node_count: initialNodes.length,
    execution_handoff: "not_enqueued",
    message:
      "Workflow run created for inspection only. Direct MCP engine_create_run does not enqueue workflow-tick execution.",
  });
}

async function handleGetRun(
  input: Record<string, unknown>,
  runtime: EngineRuntime,
): Promise<McpToolResult> {
  const runId = String(input.run_id);
  const workspaceId = resolveWorkspaceId(input.workspace_id, runtime);
  const runRow = runtime.db
    .prepare("SELECT * FROM workflow_runs WHERE id = ? AND workspace_id = ?")
    .get(runId, workspaceId);

  if (!runRow) {
    return errorResult({ error: `Workflow run not found: ${runId}` });
  }

  const run = normalizeWorkflowRun(runRow as Record<string, unknown>);
  const nodes = runtime.db
    .prepare(
      "SELECT * FROM workflow_run_nodes WHERE run_id = ? AND workspace_id = ? ORDER BY created_at ASC, node_key ASC",
    )
    .all(runId, workspaceId)
    .map((row) => normalizeRunNode(row as Record<string, unknown>));
  const nodeSummary = summarizeNodeStatuses(nodes);

  return okResult({
    run,
    nodes,
    node_summary: nodeSummary,
    total_cost_usd: Number(run.total_cost_usd ?? 0),
  });
}

async function handleListRuns(
  input: Record<string, unknown>,
  runtime: EngineRuntime,
): Promise<McpToolResult> {
  const workspaceId = resolveWorkspaceId(input.workspace_id, runtime);
  const status = asOptionalString(input.status);
  const cardId = asOptionalString(input.card_id);
  const limit = typeof input.limit === "number" ? input.limit : 20;

  const whereClauses = ["workspace_id = ?"];
  const params: Array<string | number> = [workspaceId];

  if (status) {
    whereClauses.push("status = ?");
    params.push(status);
  }
  if (cardId) {
    whereClauses.push("card_id = ?");
    params.push(cardId);
  }
  params.push(limit);

  const query = `
    SELECT * FROM workflow_runs
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  const runs = runtime.db
    .prepare(query)
    .all(...params)
    .map((row) => {
      const run = normalizeWorkflowRun(row as Record<string, unknown>);
      return {
        id: run.id,
        workflow_definition_id: run.workflow_definition_id,
        workflow_type: run.workflow_type,
        status: run.status,
        card_id: run.card_id ?? null,
        total_cost_usd: Number(run.total_cost_usd ?? 0),
        created_at: run.created_at,
        updated_at: run.updated_at,
        started_at: run.started_at ?? null,
        completed_at: run.completed_at ?? null,
      };
    });

  return okResult({ runs, count: runs.length });
}

async function handleCreateTask(
  input: Record<string, unknown>,
  runtime: EngineRuntime,
): Promise<McpToolResult> {
  const id = runtime.generateId();
  const now = runtime.now();
  const workspaceId = resolveWorkspaceId(input.workspace_id, runtime);
  const title = String(input.title);
  const description = asOptionalString(input.description);
  const status = asOptionalString(input.status) ?? "backlog";
  const priority = typeof input.priority === "number" ? input.priority : 50;
  const cardType = asOptionalString(input.card_type);
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
  const parentCardId = asOptionalString(input.parent_card_id);
  const actor = resolveFixedActor(input.created_by, runtime);
  if (!actor.ok) {
    return errorResult(actor.payload);
  }
  const createdBy = actor.actorName;
  const currentStage = cardType ? "triage" : "backlog";
  const cardGovernanceError = validateCardGovernance(cardType, createdBy, parentCardId);
  if (cardGovernanceError) {
    return errorResult(cardGovernanceError);
  }
  const parentScopeError = validateParentCardScope(runtime.db, workspaceId, parentCardId);
  if (parentScopeError) {
    return errorResult(parentScopeError);
  }

  const insert = runtime.db.prepare(`
    INSERT INTO work_items (
      id, workspace_id, title, description, status, priority, card_type,
      parent_card_id, created_by, origin, current_stage, tags, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    insert.run(
      id,
      workspaceId,
      title,
      description ?? null,
      status,
      priority,
      cardType ?? null,
      parentCardId ?? null,
      createdBy,
      createdBy,
      currentStage,
      JSON.stringify(tags),
      now,
      now,
    );
  } catch (error) {
    return errorResult({
      error: `Failed to create work item: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }

  const item = getWorkItemById(runtime.db, id, workspaceId);
  return okResult({ created: true, work_item_id: id, item });
}

async function handleUpdateTask(
  input: Record<string, unknown>,
  runtime: EngineRuntime,
): Promise<McpToolResult> {
  const workItemId = String(input.work_item_id);
  const workspaceId = resolveWorkspaceId(input.workspace_id, runtime);
  const actor = resolveFixedActor(input.created_by, runtime);
  if (!actor.ok) {
    return errorResult(actor.payload);
  }

  const existing = runtime.db
    .prepare("SELECT * FROM work_items WHERE id = ? AND workspace_id = ?")
    .get(workItemId, workspaceId);

  if (!existing) {
    return errorResult({ error: `Work item not found: ${workItemId}` });
  }

  const patch = new Map<string, unknown>();
  setPatchValue(patch, "title", input.title);
  if (Object.prototype.hasOwnProperty.call(input, "description")) {
    patch.set("description", asOptionalString(input.description));
  }
  setPatchValue(patch, "status", input.status);
  setPatchValue(patch, "priority", input.priority);
  setPatchValue(patch, "current_stage", input.current_stage);
  setPatchValue(patch, "card_type", input.card_type);
  setPatchValue(patch, "governance_tier", input.governance_tier);
  setPatchValue(patch, "flow_template", input.flow_template);
  if (Object.prototype.hasOwnProperty.call(input, "parent_card_id")) {
    patch.set("parent_card_id", asOptionalString(input.parent_card_id));
  }
  if (Object.prototype.hasOwnProperty.call(input, "created_by")) {
    patch.set("created_by", actor.actorName);
  }
  if (Object.prototype.hasOwnProperty.call(input, "tags")) {
    patch.set("tags", JSON.stringify(Array.isArray(input.tags) ? input.tags.map(String) : []));
  }

  if (patch.size === 0) {
    return errorResult({
      error:
        "No updatable fields provided. Supply one of: title, description, status, priority, current_stage, card_type, governance_tier, flow_template, parent_card_id, created_by, tags.",
    });
  }

  const existingItem = existing as Record<string, unknown>;
  const cardTypeProvided = Object.prototype.hasOwnProperty.call(input, "card_type");
  const parentCardIdProvided = Object.prototype.hasOwnProperty.call(input, "parent_card_id");
  const createdByProvided = Object.prototype.hasOwnProperty.call(input, "created_by");
  const governanceTierProvided = Object.prototype.hasOwnProperty.call(input, "governance_tier");
  const flowTemplateProvided = Object.prototype.hasOwnProperty.call(input, "flow_template");
  const effectiveCardType = cardTypeProvided
    ? asOptionalString(patch.get("card_type"))
    : asOptionalString(existingItem.card_type);
  const effectiveParentCardId = parentCardIdProvided
    ? asOptionalString(patch.get("parent_card_id"))
    : asOptionalString(existingItem.parent_card_id);
  const effectiveCreatedBy = createdByProvided
    ? actor.actorName
    : asOptionalString(existingItem.created_by);
  if (
    cardTypeProvided ||
    parentCardIdProvided ||
    createdByProvided ||
    governanceTierProvided ||
    flowTemplateProvided
  ) {
    const actorGovernanceError = validateCardGovernance(
      effectiveCardType,
      actor.actorName,
      effectiveParentCardId,
    );
    if (actorGovernanceError) {
      return errorResult(actorGovernanceError);
    }
    const storedCreatorGovernanceError = validateCardGovernance(
      effectiveCardType,
      effectiveCreatedBy,
      effectiveParentCardId,
    );
    if (storedCreatorGovernanceError) {
      return errorResult(storedCreatorGovernanceError);
    }
    if (createdByProvided) {
      patch.set("created_by", actor.actorName);
    }
    const parentScopeError = validateParentCardScope(
      runtime.db,
      workspaceId,
      effectiveParentCardId,
    );
    if (parentScopeError) {
      return errorResult(parentScopeError);
    }
  }

  patch.set("updated_at", runtime.now());
  const assignments = [...patch.keys()].map((key) => `${key} = ?`).join(", ");
  const values = [...patch.values(), workItemId, workspaceId];
  try {
    runtime.db
      .prepare(`UPDATE work_items SET ${assignments} WHERE id = ? AND workspace_id = ?`)
      .run(...values);
  } catch (error) {
    return errorResult({
      error: `Failed to update work item: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }

  const item = getWorkItemById(runtime.db, workItemId, workspaceId);
  return okResult({ updated: true, work_item_id: workItemId, item });
}

async function handleGetForemanState(runtime: EngineRuntime): Promise<McpToolResult> {
  const warnings: string[] = [];
  const sourcePaths = {
    task_checkpoint: null as string | null,
    board_snapshot: null as string | null,
    sqlite_db: runtime.dbPath,
  };

  let latestTaskCheckpoint: FileSnapshot | null = null;
  let latestBoardSnapshot: FileSnapshot | null = null;

  if (runtime.foremanStateMode === "full") {
    latestTaskCheckpoint = findLatestJsonFile(join(runtime.homeDir, ".airya", "state", "tasks"));
    if (latestTaskCheckpoint) {
      sourcePaths.task_checkpoint = latestTaskCheckpoint.path;
    } else {
      warnings.push(
        `No task checkpoints found under ${join(runtime.homeDir, ".airya", "state", "tasks")}`,
      );
    }

    latestBoardSnapshot = findLatestJsonFile(join(runtime.homeDir, ".claude", "tasks"));
    if (latestBoardSnapshot) {
      sourcePaths.board_snapshot = latestBoardSnapshot.path;
    } else {
      warnings.push(
        `No Claude board/project snapshot found under ${join(runtime.homeDir, ".claude", "tasks")}`,
      );
    }
  } else {
    warnings.push("Global recovery checkpoints are suppressed for workspace-scoped bridge access.");
  }

  const sqliteState = await readEngineState(
    runtime.db,
    runtime.defaultWorkspaceId,
    runtime.foremanStateMode === "full",
  );
  warnings.push(...sqliteState.warnings);
  if (!sqliteState.active_runs.length) {
    warnings.push("No active workflow runs found in SQLite.");
  }
  if (!sqliteState.active_work_items.length) {
    warnings.push("No active work items found in SQLite.");
  }
  if (runtime.foremanStateMode === "full" && !sqliteState.pending_jobs.length) {
    warnings.push("No pending local jobs found in SQLite.");
  }
  if (runtime.foremanStateMode !== "full") {
    warnings.push("Pending local jobs are suppressed for workspace-scoped bridge access.");
  }

  const nextAction = deriveNextAction({
    taskCheckpoint: latestTaskCheckpoint,
    boardSnapshot: latestBoardSnapshot,
    sqliteState,
  });

  return okResult({
    next_action: nextAction,
    warnings,
    source_paths: sourcePaths,
    state: {
      task_checkpoint: latestTaskCheckpoint ? summarizeCheckpoint(latestTaskCheckpoint) : null,
      board_snapshot: latestBoardSnapshot ? summarizeCheckpoint(latestBoardSnapshot) : null,
      sqlite: sqliteState,
    },
  });
}

function resolveWorkspaceId(value: unknown, runtime: EngineRuntime): string {
  return asOptionalString(value) ?? runtime.defaultWorkspaceId;
}

function resolveActorName(value: unknown): string {
  return asOptionalString(value) ?? asOptionalString(process.env.AIRYA_AGENT_NAME) ?? "codex";
}

function resolveFixedActor(
  requestedCreatedBy: unknown,
  runtime: EngineRuntime,
):
  | {
      ok: true;
      actorName: string;
    }
  | {
      ok: false;
      payload: { error: string; code: string; actor_name: string; requested_created_by: string };
    } {
  const requested = asOptionalString(requestedCreatedBy);
  if (requested && requested !== runtime.actorName) {
    return {
      ok: false,
      payload: {
        error: `created_by override is not allowed; fixed local actor is '${runtime.actorName}'`,
        code: "AUTH_FAILED",
        actor_name: runtime.actorName,
        requested_created_by: requested,
      },
    };
  }

  return {
    ok: true,
    actorName: runtime.actorName,
  };
}

function okResult(payload: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function errorResult(payload: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

function validateCardGovernance(
  cardType: string | undefined,
  createdBy: string | undefined,
  parentCardId: string | undefined,
): { error: string; code: string } | null {
  if (!cardType) {
    return null;
  }
  if (!CARD_TYPE_SET.has(cardType)) {
    return {
      error: `Invalid card_type: '${cardType}'. Must be one of: ${CARD_TYPES.join(", ")}`,
      code: "INVALID_CARD_TYPE",
    };
  }
  if (cardType === "proposal") {
    return null;
  }
  if (STRATEGIC_CARD_TYPES.has(cardType)) {
    if (createdBy && !STRATEGIC_CREATORS.has(createdBy)) {
      return {
        error: `Strategic card type '${cardType}' can only be created by hans or airya, not '${createdBy}'`,
        code: "CARD_GOVERNANCE_VIOLATION",
      };
    }
    return null;
  }
  if (!parentCardId) {
    return {
      error: `Derived card type '${cardType}' requires a parent_card_id. Orphan cards are not allowed.`,
      code: "CARD_GOVERNANCE_VIOLATION",
    };
  }
  return null;
}

function validateWorkflowDefinitionVisibility(
  definition: Record<string, unknown>,
  workspaceId: string,
): { error: string; code: string } | null {
  const creatorWorkspaceId = asOptionalString(definition.creator_workspace_id);
  const definitionId = asOptionalString(definition.id) ?? "unknown";
  const visibility = asOptionalString(definition.visibility) ?? "private";

  if (!creatorWorkspaceId) {
    return {
      error: `Workflow definition ${definitionId} is missing creator workspace metadata.`,
      code: "WORKFLOW_DEFINITION_INVALID",
    };
  }

  if (creatorWorkspaceId === workspaceId) {
    return null;
  }

  if (visibility === "shared" || visibility === "public") {
    return null;
  }

  return {
    error: `Workflow definition ${definitionId} is not visible to workspace ${workspaceId}.`,
    code: "WORKFLOW_DEFINITION_NOT_VISIBLE",
  };
}

function validateParentCardScope(
  db: Database.Database,
  workspaceId: string,
  parentCardId: string | undefined,
): { error: string; code: string } | null {
  if (!parentCardId) {
    return null;
  }

  const parent = db
    .prepare("SELECT id FROM work_items WHERE id = ? AND workspace_id = ?")
    .get(parentCardId, workspaceId) as Record<string, unknown> | undefined;
  if (parent) {
    return null;
  }

  return {
    error: `Work item not found: ${parentCardId}`,
    code: "WORK_ITEM_NOT_FOUND",
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function validateInputAgainstSchema(
  value: unknown,
  schema: JsonSchemaLike | undefined,
  path = "input",
): { errors: string[]; schemaError: string | null } {
  if (schema === undefined) {
    return { errors: [], schemaError: null };
  }
  try {
    const validate = schemaValidator.compile(schema);
    const isValid = validate(value);
    if (isValid || !validate.errors) {
      return { errors: [], schemaError: null };
    }
    return {
      errors: validate.errors.map((issue: ErrorObject) => formatSchemaIssue(path, issue)),
      schemaError: null,
    };
  } catch (error) {
    return {
      errors: [],
      schemaError: `${path} schema could not be compiled: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

interface FileSnapshot {
  path: string;
  modifiedAt: string;
  raw: string;
  parsed: unknown;
}

function findLatestJsonFile(rootDir: string): FileSnapshot | null {
  if (!existsSync(rootDir)) {
    return null;
  }

  let latest: FileSnapshot | null = null;
  for (const filePath of collectJsonFiles(rootDir, 3)) {
    try {
      const stats = statSync(filePath);
      const raw = readFileSync(filePath, "utf8");
      const parsed = parseJson(raw);
      const candidate: FileSnapshot = {
        path: filePath,
        modifiedAt: stats.mtime.toISOString(),
        raw,
        parsed,
      };
      if (!latest || stats.mtimeMs > Date.parse(latest.modifiedAt)) {
        latest = candidate;
      }
    } catch {
      continue;
    }
  }

  return latest;
}

function collectJsonFiles(rootDir: string, maxDepth: number, currentDepth = 0): string[] {
  if (currentDepth > maxDepth || !existsSync(rootDir)) {
    return [];
  }

  const entries = readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    } else if (entry.isDirectory()) {
      files.push(...collectJsonFiles(entryPath, maxDepth, currentDepth + 1));
    }
  }
  return files;
}

function summarizeCheckpoint(snapshot: FileSnapshot): Record<string, unknown> {
  const parsed = snapshot.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      path: snapshot.path,
      modified_at: snapshot.modifiedAt,
      kind: typeof parsed,
    };
  }

  const record = parsed as Record<string, unknown>;
  return {
    path: snapshot.path,
    modified_at: snapshot.modifiedAt,
    title: pickFirstString(record, ["title", "name", "project_name", "board_name"]),
    status: pickFirstString(record, ["status", "state", "mode"]),
    next_action: pickFirstString(record, ["next_action", "nextStep", "next_step"]),
    checkpoint: pickFirstValue(record, ["checkpoint", "checkpoint_id", "step", "stage", "cursor"]),
    updated_at: pickFirstString(record, ["updated_at", "updatedAt", "last_updated", "timestamp"]),
    keys: Object.keys(record).slice(0, 12),
  };
}

async function readEngineState(
  db: Database.Database,
  workspaceId: string,
  includePendingJobs: boolean,
): Promise<{
  active_runs: Array<Record<string, unknown>>;
  active_work_items: Array<Record<string, unknown>>;
  pending_jobs: Array<Record<string, unknown>>;
  lane_projections: Array<Record<string, unknown>>;
  warnings: string[];
}> {
  const activeRunRows = db
    .prepare(`
    SELECT id, workflow_definition_id, workflow_type, status, card_id, created_at, updated_at, started_at, completed_at, total_cost_usd
    FROM workflow_runs
    WHERE workspace_id = ?
      AND status IN ('queued', 'running', 'paused')
    ORDER BY updated_at DESC
    LIMIT 10
  `)
    .all(workspaceId) as Array<Record<string, unknown>>;

  const activeWorkItemRows = db
    .prepare(`
    SELECT id, title, status, priority, card_type, parent_card_id, created_by, current_stage, flow_template, governance_tier, updated_at
    FROM work_items
    WHERE workspace_id = ?
      AND archived_at IS NULL
      AND (
        status IN ('todo', 'ready')
        OR active_workflow_run_id IS NOT NULL
        OR blocked_reason IS NOT NULL
      )
    ORDER BY updated_at DESC
    LIMIT 10
  `)
    .all(workspaceId) as Array<Record<string, unknown>>;

  let pendingJobRows: Array<Record<string, unknown>> = [];
  if (includePendingJobs) {
    try {
      pendingJobRows = db
        .prepare(`
        SELECT id, queue, status, retry_count, max_retries, created_at, started_at, completed_at
        FROM local_jobs
        WHERE status IN ('pending', 'running')
        ORDER BY created_at DESC
        LIMIT 10
      `)
        .all() as Array<Record<string, unknown>>;
    } catch {
      pendingJobRows = [];
    }
  }

  const laneProjectionState = await readLaneProjections(
    db,
    workspaceId,
    activeRunRows,
    activeWorkItemRows,
  );

  return {
    active_runs: activeRunRows,
    active_work_items: activeWorkItemRows,
    pending_jobs: pendingJobRows,
    lane_projections: laneProjectionState.lane_projections,
    warnings: laneProjectionState.warnings,
  };
}

async function readLaneProjections(
  db: Database.Database,
  workspaceId: string,
  activeRunRows: Array<Record<string, unknown>>,
  activeWorkItemRows: Array<Record<string, unknown>>,
): Promise<{
  lane_projections: Array<Record<string, unknown>>;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const candidateCardIds = new Set<string>();

  for (const row of activeWorkItemRows) {
    if (typeof row.id === "string" && row.id.trim().length > 0) {
      candidateCardIds.add(row.id);
    }
  }
  for (const row of activeRunRows) {
    if (typeof row.card_id === "string" && row.card_id.trim().length > 0) {
      candidateCardIds.add(row.card_id);
    }
  }

  if (candidateCardIds.size === 0) {
    return { lane_projections: [], warnings };
  }

  let buildLaneProjection: LaneProjectionModule["buildLaneProjection"];
  try {
    ({ buildLaneProjection } = await loadLaneProjectionModule());
  } catch (error) {
    return {
      lane_projections: [],
      warnings: [
        `Lane projection unavailable: ${error instanceof Error ? error.message : "Unable to load buildLaneProjection()."}`,
      ],
    };
  }

  const cards = selectRowsByIds(
    db,
    `
      SELECT *
      FROM work_items
      WHERE workspace_id = ?
        AND id IN (__IDS__)
      ORDER BY updated_at DESC
    `,
    workspaceId,
    [...candidateCardIds],
  ).map(normalizeWorkItem);

  if (cards.length === 0) {
    return { lane_projections: [], warnings };
  }

  const activeRunIds = activeRunRows
    .map((row) => (typeof row.id === "string" && row.id.trim().length > 0 ? row.id : null))
    .filter((value): value is string => value !== null);
  const runRows = readWorkflowRunsForCards(
    db,
    workspaceId,
    cards.map((card) => String(card.id)),
    activeRunIds,
  ).map(normalizeWorkflowRun);
  const runIds = runRows
    .map((row) => (typeof row.id === "string" && row.id.trim().length > 0 ? row.id : null))
    .filter((value): value is string => value !== null);

  let sessionRows: Array<Record<string, unknown>> = [];
  try {
    sessionRows =
      runIds.length === 0
        ? []
        : selectRowsByIds(
            db,
            `
          SELECT *
          FROM agent_sessions
          WHERE workspace_id = ?
            AND workflow_run_id IN (__IDS__)
          ORDER BY updated_at DESC
        `,
            workspaceId,
            runIds,
          ).map(normalizeAgentSession);
  } catch (error) {
    warnings.push(
      `Lane projection session lookup unavailable: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  let messageRows: Array<Record<string, unknown>> = [];
  try {
    messageRows = db
      .prepare(`
      SELECT *
      FROM agent_messages
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT 500
    `)
      .all(workspaceId) as Array<Record<string, unknown>>;
    messageRows = messageRows.map(normalizeAgentMessage);
  } catch (error) {
    warnings.push(
      `Lane projection message lookup unavailable: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  const laneProjections: Array<Record<string, unknown>> = [];
  for (const card of cards) {
    const laneRuns = runRows.filter(
      (run) => run.card_id === card.id || run.id === card.active_workflow_run_id,
    );
    const laneRunIds = new Set(
      laneRuns
        .map((run) => (typeof run.id === "string" && run.id.trim().length > 0 ? run.id : null))
        .filter((value): value is string => value !== null),
    );
    const laneSessions = sessionRows.filter(
      (session) =>
        typeof session.workflow_run_id === "string" && laneRunIds.has(session.workflow_run_id),
    );
    const laneSessionIds = new Set(
      laneSessions
        .map((session) =>
          typeof session.id === "string" && session.id.trim().length > 0 ? session.id : null,
        )
        .filter((value): value is string => value !== null),
    );
    const laneMessages = messageRows.filter((message) => {
      if (typeof message.workflow_run_id === "string" && laneRunIds.has(message.workflow_run_id)) {
        return true;
      }
      if (typeof message.session_id === "string" && laneSessionIds.has(message.session_id)) {
        return true;
      }
      const context = isRecord(message.context) ? message.context : null;
      return context?.card_id === card.id;
    });

    try {
      laneProjections.push(
        buildLaneProjection({
          card,
          runs: laneRuns,
          sessions: laneSessions,
          messages: laneMessages,
        }),
      );
    } catch (error) {
      warnings.push(
        `Lane projection failed for card ${String(card.id)}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return {
    lane_projections: laneProjections,
    warnings,
  };
}

function deriveNextAction(args: {
  taskCheckpoint: FileSnapshot | null;
  boardSnapshot: FileSnapshot | null;
  sqliteState: {
    active_runs: Array<Record<string, unknown>>;
    active_work_items: Array<Record<string, unknown>>;
    pending_jobs: Array<Record<string, unknown>>;
  };
}): string {
  if (args.taskCheckpoint) {
    return `Rehydrate from ${args.taskCheckpoint.path}, then reconcile against the latest project snapshot and active SQLite state before resuming work.`;
  }
  if (args.boardSnapshot) {
    return `Rebuild control context from ${args.boardSnapshot.path}, then cross-check active SQLite runs and work items before resuming work.`;
  }
  if (
    args.sqliteState.active_runs.length ||
    args.sqliteState.active_work_items.length ||
    args.sqliteState.pending_jobs.length
  ) {
    return "Use the active SQLite state as the source of truth, then reconstruct the latest task context from the live engine records.";
  }
  return "No recovery anchors were found; start a fresh control-state capture before restarting the foreman.";
}

function pickFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickFirstValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeWorkflowDefinition(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    input_schema: parseJson(row.input_schema),
    output_schema: parseJson(row.output_schema),
    prerequisites: parseJson(row.prerequisites),
    steps: parseJson(row.steps),
    tags: parseJson(row.tags),
  };
}

function normalizeWorkflowRun(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    execution_snapshot: parseJson(row.execution_snapshot),
    input: parseJson(row.input),
    output: parseJson(row.output),
  };
}

function normalizeRunNode(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    step_definition: parseJson(row.step_definition),
    input: parseJson(row.input),
    output: parseJson(row.output),
  };
}

function normalizeWorkItem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    readiness_check: parseJson(row.readiness_check),
    tags: parseJson(row.tags) ?? [],
    card_activity: parseJson(row.card_activity) ?? [],
    card_documents: parseJson(row.card_documents) ?? [],
    card_criteria: parseJson(row.card_criteria) ?? [],
  };
}

function normalizeAgentSession(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    skill_names: parseJson(row.skill_names) ?? [],
    allowed_tools: parseJson(row.allowed_tools) ?? [],
    artifacts: parseJson(row.artifacts) ?? [],
  };
}

function normalizeAgentMessage(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    context: parseJson(row.context) ?? {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function selectRowsByIds(
  db: Database.Database,
  sql: string,
  workspaceId: string,
  ids: string[],
): Array<Record<string, unknown>> {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(", ");
  return db.prepare(sql.replace("__IDS__", placeholders)).all(workspaceId, ...ids) as Array<
    Record<string, unknown>
  >;
}

function readWorkflowRunsForCards(
  db: Database.Database,
  workspaceId: string,
  cardIds: string[],
  runIds: string[],
): Array<Record<string, unknown>> {
  if (cardIds.length === 0 && runIds.length === 0) {
    return [];
  }

  const clauses: string[] = [];
  const params: unknown[] = [workspaceId];

  if (cardIds.length > 0) {
    clauses.push(`card_id IN (${cardIds.map(() => "?").join(", ")})`);
    params.push(...cardIds);
  }
  if (runIds.length > 0) {
    clauses.push(`id IN (${runIds.map(() => "?").join(", ")})`);
    params.push(...runIds);
  }

  return db
    .prepare(`
    SELECT *
    FROM workflow_runs
    WHERE workspace_id = ?
      AND (${clauses.join(" OR ")})
    ORDER BY updated_at DESC
  `)
    .all(...params) as Array<Record<string, unknown>>;
}

async function loadLaneProjectionModule(): Promise<LaneProjectionModule> {
  laneProjectionModulePromise ??= import(
    resolveLaneProjectionModuleUrl()
  ) as Promise<LaneProjectionModule>;
  return laneProjectionModulePromise;
}

function resolveLaneProjectionModuleUrl(): string {
  const explicitRepoRoot = process.env.AIRYA_REPO_ROOT;
  const candidateRepoRoots = new Set<string>();
  const preferDist = import.meta.url.includes("/dist/");

  if (explicitRepoRoot) {
    candidateRepoRoots.add(explicitRepoRoot);
  }
  candidateRepoRoots.add(AIRYA_DEFAULT_REPO_ROOT);

  const mainWorktreeRepoRoot = findMainWorktreeRepoRoot();
  if (mainWorktreeRepoRoot) {
    candidateRepoRoots.add(mainWorktreeRepoRoot);
  }

  for (const repoRoot of candidateRepoRoots) {
    const sourcePath = join(
      repoRoot,
      "packages",
      "engine",
      "src",
      "navigator",
      "lane-projection.ts",
    );
    const distPath = join(
      repoRoot,
      "packages",
      "engine",
      "dist",
      "navigator",
      "lane-projection.js",
    );
    const candidates = preferDist ? [distPath, sourcePath] : [sourcePath, distPath];

    for (const candidatePath of candidates) {
      if (existsSync(candidatePath)) {
        return pathToFileURL(candidatePath).href;
      }
    }
  }

  throw new Error(
    "Unable to locate @airya/engine buildLaneProjection module. Set AIRYA_REPO_ROOT to a checkout containing packages/engine/src/navigator/lane-projection.ts.",
  );
}

function findMainWorktreeRepoRoot(): string | null {
  if (!existsSync(AIRYA_WORKTREES_ROOT)) {
    return null;
  }

  const candidates = readdirSync(AIRYA_WORKTREES_ROOT)
    .map((name) => join(AIRYA_WORKTREES_ROOT, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((path) => hasLaneProjectionModule(path))
    .filter((path) => getGitBranchName(path) === "main")
    .toSorted();

  return candidates[0] ?? null;
}

function hasLaneProjectionModule(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, "packages", "engine", "src", "navigator", "lane-projection.ts")) ||
    existsSync(join(repoRoot, "packages", "engine", "dist", "navigator", "lane-projection.js"))
  );
}

function getGitBranchName(repoRoot: string): string | null {
  try {
    const output = execFileSync("git", ["-C", repoRoot, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const branch = output.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

function formatSchemaIssue(
  path: string,
  issue: {
    instancePath?: string;
    message?: string;
    params?: Record<string, unknown>;
  },
): string {
  const suffix = issue.instancePath
    ? issue.instancePath
        .split("/")
        .filter(Boolean)
        .map((segment) => (Number.isInteger(Number(segment)) ? `[${segment}]` : `.${segment}`))
        .join("")
    : "";
  const targetPath = `${path}${suffix}`;

  if (issue.params && typeof issue.params.missingProperty === "string") {
    return `${targetPath}.${issue.params.missingProperty} is required`;
  }
  if (issue.params && typeof issue.params.additionalProperty === "string") {
    return `${targetPath}.${issue.params.additionalProperty} is not allowed`;
  }
  return `${targetPath} ${issue.message ?? "is invalid"}`;
}

function getWorkItemById(
  db: Database.Database,
  id: string,
  workspaceId?: string,
): Record<string, unknown> {
  const row = workspaceId
    ? db.prepare("SELECT * FROM work_items WHERE id = ? AND workspace_id = ?").get(id, workspaceId)
    : db.prepare("SELECT * FROM work_items WHERE id = ?").get(id);
  return normalizeWorkItem(row as Record<string, unknown>);
}

function summarizeNodeStatuses(nodes: Record<string, unknown>[]): Record<string, number> {
  return nodes.reduce<Record<string, number>>((summary, node) => {
    const status = asOptionalString(node.status) ?? "unknown";
    summary[status] = (summary[status] ?? 0) + 1;
    return summary;
  }, {});
}

function buildInitialNodes(input: {
  runId: string;
  workspaceId: string;
  steps: Array<Record<string, unknown>>;
  now: string;
  generateId: () => string;
}): Array<Record<string, unknown>> {
  const bodyStepKeys = new Set<string>();
  for (const step of input.steps) {
    if (step.type !== "loop_controller") {
      continue;
    }
    const config = asObject(step.config);
    const bodySteps = Array.isArray(config.body_steps) ? config.body_steps : [];
    for (const key of bodySteps) {
      if (typeof key === "string") {
        bodyStepKeys.add(key);
      }
    }
  }

  return input.steps
    .filter((step) => !bodyStepKeys.has(String(step.key)))
    .map((step) => {
      const nodeKey = String(step.key);
      return {
        id: input.generateId(),
        run_id: input.runId,
        workspace_id: input.workspaceId,
        node_key: nodeKey,
        node_type: String(step.type),
        step_definition: step,
        status: "pending",
        idempotency_key: `${input.runId}:${nodeKey}:0`,
        retry_count: 0,
        max_retries: 3,
        created_at: input.now,
        updated_at: input.now,
      };
    });
}

function setPatchValue(patch: Map<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    patch.set(key, value);
  }
}
