import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEngineToolDefinitions,
  type EngineToolOptions,
  registerEngineTools,
  type EngineToolDefinition,
} from "../engine-tools.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";
const HEADLESS_WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";
const APPROVED_DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_DEFINITION_ID = "22222222-2222-4222-8222-222222222222";
const REQUIRED_INPUT_DEFINITION_ID = "55555555-5555-4555-8555-555555555556";
const STRICT_SCHEMA_DEFINITION_ID = "66666666-6666-4666-8666-666666666666";
const TYPO_SCHEMA_DEFINITION_ID = "77777777-7777-4777-8777-777777777776";
const MALFORMED_SCHEMA_DEFINITION_ID = "88888888-8888-4888-8888-888888888888";
const PARENT_CARD_ID = "33333333-3333-4333-8333-333333333333";
const CARD_ID = "44444444-4444-4444-8444-444444444444";
const FIXED_NOW = "2026-03-19T20:00:00.000Z";
const STEERING_CASES = ["direct_steerable", "self_loop_only", "human_relay_only"] as const;

describe("engine tools", () => {
  let db: Database.Database;
  let nextIds: string[];
  const originalWorkspaceEnv = process.env.AIRYA_WORKSPACE_ID;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    seedData(db);
    nextIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
    ];
  });

  afterEach(() => {
    if (originalWorkspaceEnv === undefined) {
      delete process.env.AIRYA_WORKSPACE_ID;
    } else {
      process.env.AIRYA_WORKSPACE_ID = originalWorkspaceEnv;
    }
    db.close();
  });

  it("defines and registers the six engine tools with zod schemas", () => {
    const definitions = createDefinitions();
    expect(definitions.map((definition) => definition.name)).toEqual([
      "engine_create_run",
      "engine_get_run",
      "engine_list_runs",
      "engine_create_task",
      "engine_update_task",
      "engine_get_foreman_state",
    ]);

    const createRunSchema = z.object(findTool(definitions, "engine_create_run").schema);
    expect(createRunSchema.safeParse({ definition_id: APPROVED_DEFINITION_ID }).success).toBe(true);
    expect(createRunSchema.safeParse({ definition_id: "not-a-uuid" }).success).toBe(false);

    const createTaskSchema = z.object(findTool(definitions, "engine_create_task").schema);
    expect(createTaskSchema.safeParse({ title: "Task", card_type: "product" }).success).toBe(true);
    expect(createTaskSchema.safeParse({ title: "Task", card_type: "invalid_type" }).success).toBe(
      false,
    );

    const updateTaskSchema = z.object(findTool(definitions, "engine_update_task").schema);
    expect(
      updateTaskSchema.safeParse({ work_item_id: CARD_ID, card_type: "proposal" }).success,
    ).toBe(true);
    expect(
      updateTaskSchema.safeParse({ work_item_id: CARD_ID, card_type: "invalid_type" }).success,
    ).toBe(false);

    const foremanStateSchema = z.object(findTool(definitions, "engine_get_foreman_state").schema);
    expect(foremanStateSchema.safeParse({}).success).toBe(true);

    const registered: string[] = [];
    registerEngineTools(
      {
        tool(name, _description, _schema, _handler) {
          registered.push(name);
        },
      },
      {
        db,
        defaultWorkspaceId: WORKSPACE_ID,
        now: () => FIXED_NOW,
        generateId: () => nextIds.shift() ?? crypto.randomUUID(),
      },
    );

    expect(registered).toEqual(definitions.map((definition) => definition.name));
  });

  it("rejects engine_create_run when the workflow definition is not approved", async () => {
    const result = await invoke("engine_create_run", {
      definition_id: DRAFT_DEFINITION_ID,
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.error).toContain("not approved");
    expect(body.code).toBe("WORKFLOW_NOT_APPROVED");
    expect(countRows("workflow_runs")).toBe(0);
  });

  it("creates a queued workflow run and initial nodes for an approved definition without execution handoff", async () => {
    const result = await invoke("engine_create_run", {
      definition_id: APPROVED_DEFINITION_ID,
      card_id: CARD_ID,
      input: { target: "hq" },
    });
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.run_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
    expect(body.status).toBe("queued");
    expect(body.node_count).toBe(2);
    expect(body.execution_handoff).toBe("not_enqueued");
    expect(body.message).toContain("does not enqueue workflow-tick execution");

    const runRow = db
      .prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .get(body.run_id) as Record<string, unknown>;
    expect(runRow.workflow_definition_id).toBe(APPROVED_DEFINITION_ID);
    expect(runRow.card_id).toBe(CARD_ID);
    expect(runRow.status).toBe("queued");

    const nodes = db
      .prepare(
        "SELECT node_key, node_type, status FROM workflow_run_nodes WHERE run_id = ? ORDER BY created_at ASC, node_key ASC",
      )
      .all(body.run_id) as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.node_key)).toEqual(["collect", "loop"]);
    expect(nodes.every((node) => node.status === "pending")).toBe(true);
    expect(countRows("local_jobs")).toBe(0);
  });

  it("rejects engine_create_run when required workflow input is missing", async () => {
    const before = countRows("workflow_runs");
    const result = await invoke("engine_create_run", {
      definition_id: REQUIRED_INPUT_DEFINITION_ID,
      input: {},
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("WORKFLOW_INPUT_VALIDATION_FAILED");
    expect(body.details).toContain("input.work_item_id is required");
    expect(countRows("workflow_runs")).toBe(before);
  });

  it("rejects engine_create_run when workflow input violates integer and additionalProperties constraints", async () => {
    const before = countRows("workflow_runs");
    const result = await invoke("engine_create_run", {
      definition_id: STRICT_SCHEMA_DEFINITION_ID,
      input: {
        retry_count: 1.5,
        extra_field: true,
      },
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("WORKFLOW_INPUT_VALIDATION_FAILED");
    expect(body.details).toEqual(
      expect.arrayContaining([
        "input.retry_count must be integer",
        "input.extra_field is not allowed",
      ]),
    );
    expect(countRows("workflow_runs")).toBe(before);
  });

  it("fails closed when the workflow definition input schema cannot be compiled", async () => {
    const before = countRows("workflow_runs");
    const result = await invoke("engine_create_run", {
      definition_id: MALFORMED_SCHEMA_DEFINITION_ID,
      input: {},
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("WORKFLOW_INPUT_SCHEMA_INVALID");
    expect(body.error).toContain("input schema could not be compiled");
    expect(countRows("workflow_runs")).toBe(before);
  });

  it("fails closed when the workflow definition input schema contains typoed keywords", async () => {
    const before = countRows("workflow_runs");
    const result = await invoke("engine_create_run", {
      definition_id: TYPO_SCHEMA_DEFINITION_ID,
      input: {
        retry_count: 1,
        extra_field: true,
      },
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("WORKFLOW_INPUT_SCHEMA_INVALID");
    expect(body.error).toContain("unknown keyword");
    expect(countRows("workflow_runs")).toBe(before);
  });

  it("rejects engine_create_run when card_id belongs to another workspace", async () => {
    const otherWorkspaceCardId = "99999999-9999-4999-8999-999999999999";
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
      HEADLESS_WORKSPACE_ID,
      "Headless MCP Workspace",
    );
    db.prepare(
      "INSERT INTO work_items (id, workspace_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      otherWorkspaceCardId,
      HEADLESS_WORKSPACE_ID,
      "Other Workspace Card",
      "todo",
      "airya",
      FIXED_NOW,
      FIXED_NOW,
    );

    const before = countRows("workflow_runs");
    const result = await invoke("engine_create_run", {
      definition_id: APPROVED_DEFINITION_ID,
      card_id: otherWorkspaceCardId,
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("WORK_ITEM_NOT_FOUND");
    expect(body.error).toContain(otherWorkspaceCardId);
    expect(countRows("workflow_runs")).toBe(before);
  });

  it("rejects engine_create_run when an approved workflow definition is private to another workspace", async () => {
    const foreignDefinitionId = "12121212-1212-4212-8212-121212121210";
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
      HEADLESS_WORKSPACE_ID,
      "Headless MCP Workspace",
    );
    db.prepare(`
      INSERT INTO workflow_definitions (
        id, name, description, version, creator_workspace_id, visibility,
        input_schema, output_schema, prerequisites, steps, governance_tier,
        status, category, tags, created_by, approved_by, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, '[]', ?, 1, 'approved', 'development', '[]', 'airya', 'hans', ?, ?)
    `).run(
      foreignDefinitionId,
      "foreign-private-workflow",
      "Private foreign workflow",
      HEADLESS_WORKSPACE_ID,
      "private",
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify([]),
      FIXED_NOW,
      FIXED_NOW,
    );

    const before = countRows("workflow_runs");
    const result = await invoke("engine_create_run", {
      definition_id: foreignDefinitionId,
      input: {},
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("WORKFLOW_DEFINITION_NOT_VISIBLE");
    expect(body.error).toContain("not visible");
    expect(countRows("workflow_runs")).toBe(before);
  });

  it("allows engine_create_run when an approved workflow definition is shared from another workspace", async () => {
    const sharedDefinitionId = "12121212-1212-4212-8212-121212121211";
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
      HEADLESS_WORKSPACE_ID,
      "Headless MCP Workspace",
    );
    db.prepare(`
      INSERT INTO workflow_definitions (
        id, name, description, version, creator_workspace_id, visibility,
        input_schema, output_schema, prerequisites, steps, governance_tier,
        status, category, tags, created_by, approved_by, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, '[]', ?, 1, 'approved', 'development', '[]', 'airya', 'hans', ?, ?)
    `).run(
      sharedDefinitionId,
      "foreign-shared-workflow",
      "Shared foreign workflow",
      HEADLESS_WORKSPACE_ID,
      "shared",
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify([
        {
          key: "collect",
          type: "tool",
          label: "Collect context",
          config: { tool: "memory_context" },
        },
      ]),
      FIXED_NOW,
      FIXED_NOW,
    );

    const result = await invoke("engine_create_run", {
      definition_id: sharedDefinitionId,
      input: {},
    });
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.workflow_name).toBe("foreign-shared-workflow");
    expect(body.status).toBe("queued");
  });

  it("returns run state, node state, and total cost from engine_get_run", async () => {
    const createBody = parseResult(
      await invoke("engine_create_run", {
        definition_id: APPROVED_DEFINITION_ID,
        card_id: CARD_ID,
      }),
    );

    db.prepare(
      "UPDATE workflow_runs SET status = ?, total_cost_usd = ?, started_at = ? WHERE id = ?",
    ).run("running", 12.5, FIXED_NOW, createBody.run_id);
    db.prepare(
      "UPDATE workflow_run_nodes SET status = ?, started_at = ? WHERE run_id = ? AND node_key = ?",
    ).run("running", FIXED_NOW, createBody.run_id, "collect");

    const result = await invoke("engine_get_run", {
      run_id: createBody.run_id,
    });
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.run.id).toBe(createBody.run_id);
    expect(body.run.status).toBe("running");
    expect(body.total_cost_usd).toBe(12.5);
    expect(body.node_summary.running).toBe(1);
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes[0].step_definition.key).toBe("collect");
  });

  it("fails closed to the configured workspace when engine_get_run omits workspace_id", async () => {
    const headlessDefinitionId = "12121212-1212-4212-8212-121212121212";
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
      HEADLESS_WORKSPACE_ID,
      "Headless MCP Workspace",
    );
    db.prepare(`
      INSERT INTO workflow_definitions (
        id, name, description, version, creator_workspace_id, visibility,
        input_schema, output_schema, prerequisites, steps, governance_tier,
        status, category, tags, created_by, approved_by, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, 'private', ?, ?, '[]', ?, 1, 'approved', 'development', '[]', 'airya', 'hans', ?, ?)
    `).run(
      headlessDefinitionId,
      "headless-private-workflow",
      "Headless private workflow",
      HEADLESS_WORKSPACE_ID,
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify([
        {
          key: "collect",
          type: "tool",
          label: "Collect context",
          config: { tool: "memory_context" },
        },
      ]),
      FIXED_NOW,
      FIXED_NOW,
    );
    const otherWorkspaceRun = parseResult(
      await invoke("engine_create_run", {
        definition_id: headlessDefinitionId,
        workspace_id: HEADLESS_WORKSPACE_ID,
      }),
    );

    const result = await invoke("engine_get_run", {
      run_id: otherWorkspaceRun.run_id,
    });
    const body = parseResult(result);
    const otherWorkspaceRunId = otherWorkspaceRun.run_id as string;

    expect(result.isError).toBe(true);
    expect(body.error).toContain(`Workflow run not found: ${otherWorkspaceRunId}`);
  });

  it("filters engine_list_runs by status, card_id, and limit", async () => {
    const firstRun = parseResult(
      await invoke("engine_create_run", {
        definition_id: APPROVED_DEFINITION_ID,
        card_id: CARD_ID,
      }),
    );
    const secondRun = parseResult(
      await invoke("engine_create_run", {
        definition_id: APPROVED_DEFINITION_ID,
      }),
    );

    db.prepare("UPDATE workflow_runs SET status = ? WHERE id = ?").run("running", secondRun.run_id);

    const result = await invoke("engine_list_runs", {
      status: "queued",
      card_id: CARD_ID,
      limit: 1,
    });
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe(firstRun.run_id);
    expect(body.runs[0].card_id).toBe(CARD_ID);
    expect(body.runs[0].status).toBe("queued");
  });

  it("uses AIRYA_WORKSPACE_ID for local engine tools when no workspace_id is provided", async () => {
    process.env.AIRYA_WORKSPACE_ID = HEADLESS_WORKSPACE_ID;
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
      HEADLESS_WORKSPACE_ID,
      "Headless MCP Workspace",
    );

    const result = await invokeWithOptions(
      "engine_create_task",
      {
        title: "Headless MCP task",
      },
      {
        defaultWorkspaceId: undefined,
      },
    );
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.item.workspace_id).toBe(HEADLESS_WORKSPACE_ID);
  });

  it("creates a work item with card metadata through engine_create_task", async () => {
    const result = await invokeWithOptions(
      "engine_create_task",
      {
        title: "Expose engine as MCP",
        description: "First cut direct MCP access for workflow runs.",
        status: "todo",
        priority: 80,
        card_type: "feature",
        tags: ["mcp", "engine"],
        parent_card_id: PARENT_CARD_ID,
        created_by: "airya",
      },
      {
        actorName: "airya",
      },
    );
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.work_item_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
    expect(body.item.card_type).toBe("feature");
    expect(body.item.tags).toEqual(["mcp", "engine"]);
    expect(body.item.parent_card_id).toBe(PARENT_CARD_ID);
    expect(body.item.created_by).toBe("airya");
  });

  it("updates work item status, stage, and metadata through engine_update_task", async () => {
    const createBody = parseResult(
      await invoke("engine_create_task", {
        title: "Expose engine as MCP",
      }),
    );

    const result = await invokeWithOptions(
      "engine_update_task",
      {
        work_item_id: createBody.work_item_id,
        status: "ready",
        current_stage: "verify",
        card_type: "feature",
        governance_tier: 2,
        flow_template: "feature-delivery",
        tags: ["cli", "mcp"],
        created_by: "airya",
      },
      {
        actorName: "airya",
      },
    );
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.updated).toBe(true);
    expect(body.item.id).toBe(createBody.work_item_id);
    expect(body.item.status).toBe("ready");
    expect(body.item.current_stage).toBe("verify");
    expect(body.item.governance_tier).toBe(2);
    expect(body.item.tags).toEqual(["cli", "mcp"]);
  });

  it("returns a structured error when engine_create_task receives an invalid card_type in the handler", async () => {
    const before = countRows("work_items");

    const result = await invokeUnchecked("engine_create_task", {
      title: "Bad type",
      card_type: "invalid_type",
      created_by: "codex",
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.error).toContain("Invalid card_type: 'invalid_type'");
    expect(countRows("work_items")).toBe(before);
  });

  it("returns a structured error when engine_create_task allows an unauthorized strategic card", async () => {
    const before = countRows("work_items");

    const result = await invoke("engine_create_task", {
      title: "Unauthorized feature",
      card_type: "feature",
      created_by: "codex",
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.error).toContain(
      "Strategic card type 'feature' can only be created by hans or airya",
    );
    expect(countRows("work_items")).toBe(before);
  });

  it("rejects engine_create_task when created_by tries to override the fixed local actor", async () => {
    const before = countRows("work_items");

    const result = await invokeWithOptions(
      "engine_create_task",
      {
        title: "Override actor",
        created_by: "airya",
      },
      {
        actorName: "codex",
      },
    );
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("AUTH_FAILED");
    expect(body.actor_name).toBe("codex");
    expect(countRows("work_items")).toBe(before);
  });

  it("returns a structured error when engine_create_task creates a derived card without a parent", async () => {
    const before = countRows("work_items");

    const result = await invoke("engine_create_task", {
      title: "Orphan bug",
      card_type: "bug",
      created_by: "codex",
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.error).toContain("Derived card type 'bug' requires a parent_card_id");
    expect(countRows("work_items")).toBe(before);
  });

  it("returns a structured error when engine_update_task receives an invalid card_type in the handler", async () => {
    const createBody = parseResult(
      await invoke("engine_create_task", {
        title: "Existing work item",
      }),
    );

    const result = await invokeUnchecked("engine_update_task", {
      work_item_id: createBody.work_item_id,
      card_type: "invalid_type",
    });
    const body = parseResult(result);
    const row = db
      .prepare("SELECT card_type FROM work_items WHERE id = ?")
      .get(createBody.work_item_id) as { card_type: string | null };

    expect(result.isError).toBe(true);
    expect(body.error).toContain("Invalid card_type: 'invalid_type'");
    expect(row.card_type).toBeNull();
  });

  it("returns a structured error when engine_update_task makes a work item an unauthorized strategic card", async () => {
    const createBody = parseResult(
      await invoke("engine_create_task", {
        title: "Existing work item",
      }),
    );

    const result = await invoke("engine_update_task", {
      work_item_id: createBody.work_item_id,
      card_type: "feature",
      created_by: "codex",
    });
    const body = parseResult(result);
    const row = db
      .prepare("SELECT card_type, created_by FROM work_items WHERE id = ?")
      .get(createBody.work_item_id) as {
      card_type: string | null;
      created_by: string;
    };

    expect(result.isError).toBe(true);
    expect(body.error).toContain(
      "Strategic card type 'feature' can only be created by hans or airya",
    );
    expect(row.card_type).toBeNull();
    expect(row.created_by).toBe("codex");
  });

  it("fails closed to the configured workspace when engine_update_task omits workspace_id", async () => {
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
      HEADLESS_WORKSPACE_ID,
      "Headless MCP Workspace",
    );
    db.prepare(`
      INSERT INTO work_items (
        id, workspace_id, title, status, created_by, origin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "99999999-9999-4999-8999-999999999999",
      HEADLESS_WORKSPACE_ID,
      "Other Workspace Card",
      "todo",
      "airya",
      "airya",
      FIXED_NOW,
      FIXED_NOW,
    );

    const result = await invoke("engine_update_task", {
      work_item_id: "99999999-9999-4999-8999-999999999999",
      status: "ready",
    });
    const body = parseResult(result);
    const row = db
      .prepare("SELECT status FROM work_items WHERE id = ?")
      .get("99999999-9999-4999-8999-999999999999") as {
      status: string;
    };

    expect(result.isError).toBe(true);
    expect(body.error).toContain("Work item not found");
    expect(row.status).toBe("todo");
  });

  it("uses the fixed local actor for strategic governance on engine_update_task", async () => {
    const result = await invokeWithOptions(
      "engine_update_task",
      {
        work_item_id: CARD_ID,
        card_type: "feature",
      },
      {
        actorName: "codex",
      },
    );
    const body = parseResult(result);
    const row = db.prepare("SELECT card_type FROM work_items WHERE id = ?").get(CARD_ID) as {
      card_type: string | null;
    };

    expect(result.isError).toBe(true);
    expect(body.error).toContain(
      "Strategic card type 'feature' can only be created by hans or airya",
    );
    expect(row.card_type).toBeNull();
  });

  it("rejects strategic promotion when the stored creator would remain unauthorized", async () => {
    const derivedCardId = "12121212-1212-4212-8212-121212121212";
    db.prepare(`
      INSERT INTO work_items (
        id, workspace_id, title, status, card_type, parent_card_id, created_by, origin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      derivedCardId,
      WORKSPACE_ID,
      "Derived card",
      "todo",
      "chore",
      PARENT_CARD_ID,
      "codex",
      "codex",
      FIXED_NOW,
      FIXED_NOW,
    );

    const result = await invokeWithOptions(
      "engine_update_task",
      {
        work_item_id: derivedCardId,
        card_type: "feature",
      },
      {
        actorName: "airya",
      },
    );
    const body = parseResult(result);
    const row = db
      .prepare("SELECT card_type, created_by FROM work_items WHERE id = ?")
      .get(derivedCardId) as {
      card_type: string | null;
      created_by: string;
    };

    expect(result.isError).toBe(true);
    expect(body.code).toBe("CARD_GOVERNANCE_VIOLATION");
    expect(body.error).toContain("Strategic card type 'feature'");
    expect(row.card_type).toBe("chore");
    expect(row.created_by).toBe("codex");
  });

  it("rejects creator-only updates that would leave a strategic card with an unauthorized creator", async () => {
    const createBody = parseResult(
      await invokeWithOptions(
        "engine_create_task",
        {
          title: "Strategic feature",
          card_type: "feature",
          created_by: "airya",
        },
        {
          actorName: "airya",
        },
      ),
    );

    const result = await invokeWithOptions(
      "engine_update_task",
      {
        work_item_id: createBody.work_item_id,
        created_by: "codex",
      },
      {
        actorName: "codex",
      },
    );
    const body = parseResult(result);
    const row = db
      .prepare("SELECT card_type, created_by FROM work_items WHERE id = ?")
      .get(createBody.work_item_id) as {
      card_type: string | null;
      created_by: string;
    };

    expect(result.isError).toBe(true);
    expect(body.code).toBe("CARD_GOVERNANCE_VIOLATION");
    expect(body.error).toContain("Strategic card type 'feature'");
    expect(row.card_type).toBe("feature");
    expect(row.created_by).toBe("airya");
  });

  it("allows non-governance updates on an existing strategic card", async () => {
    const createBody = parseResult(
      await invokeWithOptions(
        "engine_create_task",
        {
          title: "Strategic feature",
          card_type: "feature",
          created_by: "airya",
        },
        {
          actorName: "airya",
        },
      ),
    );

    const result = await invokeWithOptions(
      "engine_update_task",
      {
        work_item_id: createBody.work_item_id,
        status: "ready",
        current_stage: "verify",
        tags: ["bridge", "parity"],
      },
      {
        actorName: "codex",
      },
    );
    const body = parseResult(result);
    const row = db
      .prepare(
        "SELECT status, current_stage, card_type, created_by, tags FROM work_items WHERE id = ?",
      )
      .get(createBody.work_item_id) as {
      status: string;
      current_stage: string | null;
      card_type: string | null;
      created_by: string;
      tags: string;
    };

    expect(result.isError).toBeUndefined();
    expect(body.updated).toBe(true);
    expect(body.item.card_type).toBe("feature");
    expect(body.item.status).toBe("ready");
    expect(body.item.current_stage).toBe("verify");
    expect(body.item.tags).toEqual(["bridge", "parity"]);
    expect(row.status).toBe("ready");
    expect(row.current_stage).toBe("verify");
    expect(row.card_type).toBe("feature");
    expect(row.created_by).toBe("airya");
    expect(JSON.parse(row.tags)).toEqual(["bridge", "parity"]);
  });

  it("rejects governance_tier-only updates on an existing strategic card from an unauthorized actor", async () => {
    const createBody = parseResult(
      await invokeWithOptions(
        "engine_create_task",
        {
          title: "Strategic feature",
          card_type: "feature",
          created_by: "airya",
        },
        {
          actorName: "airya",
        },
      ),
    );

    const result = await invokeWithOptions(
      "engine_update_task",
      {
        work_item_id: createBody.work_item_id,
        governance_tier: 3,
      },
      {
        actorName: "codex",
      },
    );
    const body = parseResult(result);
    const row = db
      .prepare("SELECT governance_tier FROM work_items WHERE id = ?")
      .get(createBody.work_item_id) as {
      governance_tier: number;
    };

    expect(result.isError).toBe(true);
    expect(body.code).toBe("CARD_GOVERNANCE_VIOLATION");
    expect(body.error).toContain("Strategic card type 'feature'");
    expect(row.governance_tier).toBe(0);
  });

  it("rejects flow_template-only updates on an existing strategic card from an unauthorized actor", async () => {
    const createBody = parseResult(
      await invokeWithOptions(
        "engine_create_task",
        {
          title: "Strategic feature",
          card_type: "feature",
          created_by: "airya",
        },
        {
          actorName: "airya",
        },
      ),
    );

    const result = await invokeWithOptions(
      "engine_update_task",
      {
        work_item_id: createBody.work_item_id,
        flow_template: "strategic-reroute",
      },
      {
        actorName: "codex",
      },
    );
    const body = parseResult(result);
    const row = db
      .prepare("SELECT flow_template FROM work_items WHERE id = ?")
      .get(createBody.work_item_id) as {
      flow_template: string | null;
    };

    expect(result.isError).toBe(true);
    expect(body.code).toBe("CARD_GOVERNANCE_VIOLATION");
    expect(body.error).toContain("Strategic card type 'feature'");
    expect(row.flow_template).toBeNull();
  });

  it("summarizes recovery state through engine_get_foreman_state", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "airya-foreman-"));
    const taskDir = join(homeDir, ".airya", "state", "tasks");
    const boardDir = join(homeDir, ".claude", "tasks");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(boardDir, { recursive: true });

    const checkpointPath = join(taskDir, "checkpoint-001.json");
    const boardSnapshotPath = join(boardDir, "master-board.json");

    writeFileSync(
      checkpointPath,
      JSON.stringify({
        title: "Crash-compaction checkpoint",
        status: "paused",
        next_action: "resume",
        checkpoint: "task-42",
        updated_at: "2026-03-19T19:59:00.000Z",
      }),
    );
    writeFileSync(
      boardSnapshotPath,
      JSON.stringify({
        project_name: "Foreman Recovery",
        status: "active",
        next_step: "reconcile",
        updated_at: "2026-03-19T19:58:00.000Z",
      }),
    );
    utimesSync(
      checkpointPath,
      new Date("2026-03-19T19:59:00.000Z"),
      new Date("2026-03-19T19:59:00.000Z"),
    );
    utimesSync(
      boardSnapshotPath,
      new Date("2026-03-19T19:58:00.000Z"),
      new Date("2026-03-19T19:58:00.000Z"),
    );

    db.prepare(`
      INSERT INTO workflow_runs (
        id, workspace_id, workflow_definition_id, workflow_type, execution_snapshot,
        status, input, total_cost_usd, created_by, card_id, created_at, updated_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "55555555-5555-4555-8555-555555555555",
      WORKSPACE_ID,
      APPROVED_DEFINITION_ID,
      "approved-workflow",
      JSON.stringify({ workflow_definition: { id: APPROVED_DEFINITION_ID } }),
      "running",
      "{}",
      0,
      "airya",
      CARD_ID,
      FIXED_NOW,
      FIXED_NOW,
      FIXED_NOW,
    );
    db.prepare(`
      INSERT INTO local_jobs (
        id, queue, data, status, retry_count, max_retries, created_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "66666666-6666-4666-8666-666666666666",
      "workflow-tick",
      JSON.stringify({ run_id: APPROVED_DEFINITION_ID }),
      "pending",
      0,
      3,
      FIXED_NOW,
      null,
    );

    try {
      const result = await invokeWithOptions(
        "engine_get_foreman_state",
        {},
        {
          homeDir,
        },
      );
      const body = parseResult(result);

      expect(result.isError).toBeUndefined();
      expect(body.next_action).toContain(checkpointPath);
      expect(body.warnings).toEqual([]);
      expect(body.source_paths.task_checkpoint).toBe(checkpointPath);
      expect(body.source_paths.board_snapshot).toBe(boardSnapshotPath);
      expect(body.state.task_checkpoint.title).toBe("Crash-compaction checkpoint");
      expect(body.state.board_snapshot.title).toBe("Foreman Recovery");
      expect(body.state.sqlite.active_runs).toHaveLength(1);
      expect(body.state.sqlite.active_work_items.length).toBeGreaterThan(0);
      expect(body.state.sqlite.pending_jobs).toHaveLength(1);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("scopes engine_get_foreman_state sqlite snapshots to the configured workspace", async () => {
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
      HEADLESS_WORKSPACE_ID,
      "Headless MCP Workspace",
    );
    db.prepare(
      "INSERT INTO work_items (id, workspace_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "99999999-9999-4999-8999-999999999998",
      HEADLESS_WORKSPACE_ID,
      "Foreign Workspace Card",
      "todo",
      "airya",
      FIXED_NOW,
      FIXED_NOW,
    );
    db.prepare(`
      INSERT INTO workflow_runs (
        id, workspace_id, workflow_definition_id, workflow_type, execution_snapshot,
        status, input, output, total_cost_usd, created_by, card_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "99999999-9999-4999-8999-999999999997",
      HEADLESS_WORKSPACE_ID,
      APPROVED_DEFINITION_ID,
      "foreign-workflow",
      JSON.stringify({ workflow_definition: { id: APPROVED_DEFINITION_ID } }),
      "running",
      JSON.stringify({}),
      null,
      0,
      "airya",
      "99999999-9999-4999-8999-999999999998",
      FIXED_NOW,
      FIXED_NOW,
    );

    const result = await invoke("engine_get_foreman_state", {});
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.state.sqlite.active_runs).toHaveLength(0);
    expect(body.state.sqlite.active_work_items.map((item: { id: string }) => item.id)).toEqual(
      expect.not.arrayContaining(["99999999-9999-4999-8999-999999999998"]),
    );
  });

  it("rejects engine_create_task when parent_card_id belongs to another workspace", async () => {
    const foreignParentId = "99999999-9999-4999-8999-999999999996";
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
      HEADLESS_WORKSPACE_ID,
      "Headless MCP Workspace",
    );
    db.prepare(
      "INSERT INTO work_items (id, workspace_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      foreignParentId,
      HEADLESS_WORKSPACE_ID,
      "Foreign Parent",
      "todo",
      "airya",
      FIXED_NOW,
      FIXED_NOW,
    );

    const before = countRows("work_items");
    const result = await invoke("engine_create_task", {
      title: "Child task",
      card_type: "bug",
      parent_card_id: foreignParentId,
    });
    const body = parseResult(result);

    expect(result.isError).toBe(true);
    expect(body.code).toBe("WORK_ITEM_NOT_FOUND");
    expect(body.error).toContain(foreignParentId);
    expect(countRows("work_items")).toBe(before);
  });

  it("rejects engine_update_task when parent_card_id belongs to another workspace", async () => {
    const foreignParentId = "99999999-9999-4999-8999-999999999995";
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
      HEADLESS_WORKSPACE_ID,
      "Headless MCP Workspace",
    );
    db.prepare(
      "INSERT INTO work_items (id, workspace_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      foreignParentId,
      HEADLESS_WORKSPACE_ID,
      "Foreign Parent",
      "todo",
      "airya",
      FIXED_NOW,
      FIXED_NOW,
    );

    const result = await invoke("engine_update_task", {
      work_item_id: CARD_ID,
      parent_card_id: foreignParentId,
    });
    const body = parseResult(result);
    const row = db.prepare("SELECT parent_card_id FROM work_items WHERE id = ?").get(CARD_ID) as {
      parent_card_id: string | null;
    };

    expect(result.isError).toBe(true);
    expect(body.code).toBe("WORK_ITEM_NOT_FOUND");
    expect(body.error).toContain(foreignParentId);
    expect(row.parent_card_id).toBeNull();
  });

  it("suppresses global checkpoints and pending jobs in workspace-scoped foreman mode", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "airya-foreman-workspace-"));
    const taskDir = join(homeDir, ".airya", "state", "tasks");
    const boardDir = join(homeDir, ".claude", "tasks");
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(boardDir, { recursive: true });

    writeFileSync(
      join(taskDir, "checkpoint-001.json"),
      JSON.stringify({
        title: "Suppressed checkpoint",
        status: "paused",
        next_action: "resume",
      }),
    );
    writeFileSync(
      join(boardDir, "master-board.json"),
      JSON.stringify({
        project_name: "Suppressed board",
        status: "active",
        next_step: "reconcile",
      }),
    );

    db.prepare(`
      INSERT INTO workflow_runs (
        id, workspace_id, workflow_definition_id, workflow_type, execution_snapshot,
        status, input, total_cost_usd, created_by, card_id, created_at, updated_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "77777777-7777-4777-8777-777777777771",
      WORKSPACE_ID,
      APPROVED_DEFINITION_ID,
      "approved-workflow",
      JSON.stringify({ workflow_definition: { id: APPROVED_DEFINITION_ID } }),
      "running",
      "{}",
      0,
      "airya",
      CARD_ID,
      FIXED_NOW,
      FIXED_NOW,
      FIXED_NOW,
    );
    db.prepare(`
      INSERT INTO local_jobs (
        id, queue, data, status, retry_count, max_retries, created_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "77777777-7777-4777-8777-777777777772",
      "workflow-tick",
      JSON.stringify({ run_id: APPROVED_DEFINITION_ID }),
      "pending",
      0,
      3,
      FIXED_NOW,
      null,
    );

    try {
      const result = await invokeWithOptions(
        "engine_get_foreman_state",
        {},
        {
          homeDir,
          foremanStateMode: "workspace",
        },
      );
      const body = parseResult(result);

      expect(result.isError).toBeUndefined();
      expect(body.next_action).toContain("Use the active SQLite state as the source of truth");
      expect(body.source_paths.task_checkpoint).toBeNull();
      expect(body.source_paths.board_snapshot).toBeNull();
      expect(body.state.task_checkpoint).toBeNull();
      expect(body.state.board_snapshot).toBeNull();
      expect(body.state.sqlite.active_runs).toHaveLength(1);
      expect(body.state.sqlite.pending_jobs).toEqual([]);
      expect(body.warnings).toEqual(
        expect.arrayContaining([
          "Global recovery checkpoints are suppressed for workspace-scoped bridge access.",
          "Pending local jobs are suppressed for workspace-scoped bridge access.",
        ]),
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each(STEERING_CASES)(
    "surfaces %s through engine_get_foreman_state lane projections",
    async (classification) => {
      const scenario = seedLaneProjectionScenario(db, classification);

      const result = await invoke("engine_get_foreman_state", {});
      const body = parseResult(result);
      const lane = body.state.sqlite.lane_projections?.find(
        (candidate: { card_id: string }) => candidate.card_id === scenario.cardId,
      );

      expect(result.isError).toBeUndefined();
      expect(Array.isArray(body.state.sqlite.lane_projections)).toBe(true);
      expect(lane).toBeDefined();
      expect(lane.steering_surface.classification).toBe(classification);
    },
  );

  it("uses the requested dbPath instead of silently reusing the first shared database", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "engine-tools-dbpath-"));
    const firstDbPath = join(tempDir, "first.db");
    const secondDbPath = join(tempDir, "second.db");
    const firstDb = new Database(firstDbPath);
    const secondDb = new Database(secondDbPath);

    try {
      createSchema(firstDb);
      createSchema(secondDb);
      seedData(firstDb);
      seedData(secondDb);
      firstDb.prepare("UPDATE work_items SET title = ? WHERE id = ?").run("First DB Card", CARD_ID);
      secondDb
        .prepare("UPDATE work_items SET title = ? WHERE id = ?")
        .run("Second DB Card", CARD_ID);
      firstDb.close();
      secondDb.close();

      createEngineToolDefinitions({
        dbPath: firstDbPath,
        defaultWorkspaceId: WORKSPACE_ID,
        actorName: "codex",
        now: () => FIXED_NOW,
        generateId: () => nextIds.shift() ?? crypto.randomUUID(),
      });

      const secondDefinitions = createEngineToolDefinitions({
        dbPath: secondDbPath,
        defaultWorkspaceId: WORKSPACE_ID,
        actorName: "codex",
        now: () => FIXED_NOW,
        generateId: () => nextIds.shift() ?? crypto.randomUUID(),
      });
      const definition = findTool(secondDefinitions, "engine_update_task");
      const schema = z.object(definition.schema);
      const parsedInput = schema.parse({
        work_item_id: CARD_ID,
        status: "ready",
      });
      const result = await definition.handler(parsedInput);
      const body = parseResult(result);
      const firstCheck = new Database(firstDbPath);
      const secondCheck = new Database(secondDbPath);

      try {
        const firstRow = firstCheck
          .prepare("SELECT title, status FROM work_items WHERE id = ?")
          .get(CARD_ID) as {
          title: string;
          status: string;
        };
        const secondRow = secondCheck
          .prepare("SELECT title, status FROM work_items WHERE id = ?")
          .get(CARD_ID) as {
          title: string;
          status: string;
        };

        expect(result.isError).toBeUndefined();
        expect(body.item.title).toBe("Second DB Card");
        expect(firstRow.status).toBe("todo");
        expect(secondRow.status).toBe("ready");
      } finally {
        firstCheck.close();
        secondCheck.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function invoke(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const definition = findTool(createDefinitions(), toolName);
    const schema = z.object(definition.schema);
    const parsedInput = schema.parse(input);
    return definition.handler(parsedInput);
  }

  async function invokeWithOptions(
    toolName: string,
    input: Record<string, unknown>,
    overrides: Partial<EngineToolOptions>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const definition = findTool(createDefinitions(overrides), toolName);
    const schema = z.object(definition.schema);
    const parsedInput = schema.parse(input);
    return definition.handler(parsedInput);
  }

  async function invokeUnchecked(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const definition = findTool(createDefinitions(), toolName);
    return definition.handler(input);
  }

  function createDefinitions(overrides: Partial<EngineToolOptions> = {}): EngineToolDefinition[] {
    return createEngineToolDefinitions({
      db,
      defaultWorkspaceId: WORKSPACE_ID,
      actorName: "codex",
      now: () => FIXED_NOW,
      generateId: () => nextIds.shift() ?? crypto.randomUUID(),
      ...overrides,
    });
  }

  function countRows(table: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }
});

function findTool(definitions: EngineToolDefinition[], name: string): EngineToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new Error(`Tool not found: ${name}`);
  }
  return definition;
}

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE workflow_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      creator_workspace_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      input_schema TEXT NOT NULL,
      output_schema TEXT NOT NULL,
      prerequisites TEXT NOT NULL DEFAULT '[]',
      steps TEXT NOT NULL,
      governance_tier INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'draft',
      category TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      approved_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      workflow_definition_id TEXT NOT NULL REFERENCES workflow_definitions(id),
      portal_customer_id TEXT,
      workflow_type TEXT NOT NULL,
      execution_snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      input TEXT NOT NULL DEFAULT '{}',
      output TEXT,
      error TEXT,
      plan_approval_id TEXT,
      approved_budget_usd REAL,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      total_cost_usd REAL DEFAULT 0,
      created_by TEXT,
      card_id TEXT REFERENCES work_items(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workflow_run_nodes (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES workflow_runs(id),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      node_key TEXT NOT NULL,
      node_type TEXT NOT NULL,
      step_definition TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT,
      output TEXT,
      error TEXT,
      idempotency_key TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      started_at TEXT,
      completed_at TEXT,
      next_retry_at TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog',
      priority INTEGER DEFAULT 50,
      blocked_reason TEXT,
      blocked_at TEXT,
      active_workflow_run_id TEXT,
      created_by_turn_id TEXT,
      readiness_check TEXT DEFAULT '{}',
      done_at TEXT,
      card_type TEXT CHECK (card_type IS NULL OR card_type IN ('bug','feature','initiative','chore','rfc','proposal','product')),
      parent_card_id TEXT REFERENCES work_items(id),
      created_by TEXT NOT NULL DEFAULT 'hans',
      origin TEXT NOT NULL DEFAULT 'hans',
      current_stage TEXT DEFAULT 'backlog',
      flow_template TEXT,
      governance_tier INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      card_activity TEXT DEFAULT '[]',
      card_documents TEXT DEFAULT '[]',
      card_criteria TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE agent_instances (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id)
    );

    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      parent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
      runtime TEXT NOT NULL,
      agent_definition_id TEXT,
      skill_names TEXT NOT NULL DEFAULT '[]',
      command TEXT NOT NULL,
      prompt TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'autonomous',
      status TEXT NOT NULL,
      pid INTEGER,
      exit_code INTEGER,
      owner_worker_id TEXT,
      heartbeat_at TEXT,
      last_read_offset INTEGER DEFAULT 0,
      reconciled_at TEXT,
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      allowed_paths TEXT,
      forbidden_paths TEXT,
      timeout_seconds INTEGER NOT NULL DEFAULT 3600,
      max_tool_calls INTEGER NOT NULL DEFAULT 200,
      max_elapsed_seconds INTEGER NOT NULL DEFAULT 7200,
      budget_cap_usd REAL NOT NULL DEFAULT 5.0,
      cost_usd REAL DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      governance_tier INTEGER NOT NULL DEFAULT 0,
      deliberation_id TEXT,
      workflow_run_id TEXT,
      node_key TEXT,
      airya_turn_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      output_summary TEXT,
      artifacts TEXT DEFAULT '[]',
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      from_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
      to_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT DEFAULT '{}',
      session_id TEXT,
      workflow_run_id TEXT,
      airya_turn_id TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE local_jobs (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT
    );
  `);
}

function seedData(db: Database.Database): void {
  db.prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)").run(
    WORKSPACE_ID,
    "Default Workspace",
  );
  db.prepare(
    "INSERT INTO work_items (id, workspace_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(PARENT_CARD_ID, WORKSPACE_ID, "Parent Card", "todo", "hans", FIXED_NOW, FIXED_NOW);
  db.prepare(
    "INSERT INTO work_items (id, workspace_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(CARD_ID, WORKSPACE_ID, "Linked Card", "todo", "airya", FIXED_NOW, FIXED_NOW);

  const steps = [
    {
      key: "collect",
      type: "tool",
      label: "Collect context",
      config: { tool: "memory_context" },
    },
    {
      key: "loop",
      type: "loop_controller",
      label: "Loop body",
      config: { body_steps: ["loop.body"] },
    },
    {
      key: "loop.body",
      type: "tool",
      label: "Loop body step",
      config: { tool: "remember" },
    },
  ];

  const insertDefinition = db.prepare(`
    INSERT INTO workflow_definitions (
      id, name, description, version, creator_workspace_id, visibility,
      input_schema, output_schema, prerequisites, steps, governance_tier,
      status, category, tags, created_by, approved_by, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 'private', ?, ?, '[]', ?, 1, ?, 'development', '[]', 'airya', 'hans', ?, ?)
  `);

  insertDefinition.run(
    APPROVED_DEFINITION_ID,
    "approved-workflow",
    "Approved workflow definition",
    WORKSPACE_ID,
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify(steps),
    "approved",
    FIXED_NOW,
    FIXED_NOW,
  );

  insertDefinition.run(
    DRAFT_DEFINITION_ID,
    "draft-workflow",
    "Draft workflow definition",
    WORKSPACE_ID,
    JSON.stringify({}),
    JSON.stringify({}),
    JSON.stringify(steps),
    "draft",
    FIXED_NOW,
    FIXED_NOW,
  );

  insertDefinition.run(
    REQUIRED_INPUT_DEFINITION_ID,
    "required-input-workflow",
    "Approved workflow definition with required input",
    WORKSPACE_ID,
    JSON.stringify({
      type: "object",
      properties: {
        work_item_id: { type: "string" },
      },
      required: ["work_item_id"],
    }),
    JSON.stringify({}),
    JSON.stringify(steps),
    "approved",
    FIXED_NOW,
    FIXED_NOW,
  );

  insertDefinition.run(
    STRICT_SCHEMA_DEFINITION_ID,
    "strict-schema-workflow",
    "Approved workflow definition with strict schema validation",
    WORKSPACE_ID,
    JSON.stringify({
      type: "object",
      properties: {
        retry_count: { type: "integer" },
      },
      required: ["retry_count"],
      additionalProperties: false,
    }),
    JSON.stringify({}),
    JSON.stringify(steps),
    "approved",
    FIXED_NOW,
    FIXED_NOW,
  );

  insertDefinition.run(
    TYPO_SCHEMA_DEFINITION_ID,
    "typo-schema-workflow",
    "Approved workflow definition with typoed schema keywords",
    WORKSPACE_ID,
    JSON.stringify({
      type: "object",
      properties: {
        retry_count: { type: "integer" },
      },
      additionalPropetries: false,
    }),
    JSON.stringify({}),
    JSON.stringify(steps),
    "approved",
    FIXED_NOW,
    FIXED_NOW,
  );

  insertDefinition.run(
    MALFORMED_SCHEMA_DEFINITION_ID,
    "malformed-schema-workflow",
    "Approved workflow definition with malformed schema",
    WORKSPACE_ID,
    JSON.stringify({
      type: "object",
      properties: 1,
    }),
    JSON.stringify({}),
    JSON.stringify(steps),
    "approved",
    FIXED_NOW,
    FIXED_NOW,
  );
}

function seedLaneProjectionScenario(
  db: Database.Database,
  classification: (typeof STEERING_CASES)[number],
): {
  cardId: string;
  runId: string;
  sessionId: string;
} {
  const suffix = classification.replace(/_/g, "-");
  const cardId = `lane-card-${suffix}`;
  const runId = `lane-run-${suffix}`;
  const sessionId = `lane-session-${suffix}`;
  const ownerInstanceId = `lane-owner-${suffix}`;
  const observerInstanceId = `lane-airya-${suffix}`;
  const controllerInstanceId = `lane-controller-${suffix}`;

  const insertInstance = db.prepare("INSERT INTO agent_instances (id, workspace_id) VALUES (?, ?)");
  for (const instanceId of [ownerInstanceId, observerInstanceId, controllerInstanceId]) {
    insertInstance.run(instanceId, WORKSPACE_ID);
  }

  db.prepare(`
    INSERT INTO work_items (
      id, workspace_id, title, description, status, priority, blocked_reason, blocked_at,
      active_workflow_run_id, created_by_turn_id, readiness_check, done_at, card_type,
      parent_card_id, created_by, origin, current_stage, flow_template, governance_tier,
      tags, card_activity, card_documents, card_criteria, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cardId,
    WORKSPACE_ID,
    `Lane ${classification}`,
    `Lane projection scenario for ${classification}`,
    "todo",
    90,
    null,
    null,
    runId,
    null,
    JSON.stringify({}),
    null,
    "bug",
    null,
    "codex",
    "codex",
    "planning",
    "bug-fast",
    2,
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify([]),
    "2026-03-27T23:00:00.000Z",
    "2026-03-27T23:03:00.000Z",
    null,
  );

  db.prepare(`
    INSERT INTO workflow_runs (
      id, workspace_id, workflow_definition_id, workflow_type, execution_snapshot,
      status, input, output, total_cost_usd, created_by, card_id, created_at, updated_at, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    WORKSPACE_ID,
    APPROVED_DEFINITION_ID,
    "execution-planning",
    JSON.stringify({
      frozen_at: "2026-03-27T23:00:00.000Z",
      workflow_definition: {
        id: APPROVED_DEFINITION_ID,
        name: "approved-workflow",
        version: 1,
        input_schema: {},
        output_schema: {},
        steps: [],
      },
    }),
    "running",
    JSON.stringify({}),
    null,
    0,
    "airya",
    cardId,
    "2026-03-27T23:00:00.000Z",
    "2026-03-27T23:03:00.000Z",
    "2026-03-27T23:00:00.000Z",
  );

  db.prepare(`
    INSERT INTO agent_sessions (
      id, workspace_id, parent_instance_id, runtime, agent_definition_id, skill_names, command,
      prompt, mode, status, pid, exit_code, owner_worker_id, heartbeat_at, last_read_offset,
      reconciled_at, allowed_tools, allowed_paths, forbidden_paths, timeout_seconds,
      max_tool_calls, max_elapsed_seconds, budget_cap_usd, cost_usd, input_tokens, output_tokens,
      tool_call_count, governance_tier, deliberation_id, workflow_run_id, node_key, airya_turn_id,
      idempotency_key, output_summary, artifacts, started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    WORKSPACE_ID,
    ownerInstanceId,
    "codex",
    null,
    JSON.stringify([]),
    "codex exec",
    "Implement the lane",
    "autonomous",
    "running",
    1234,
    null,
    null,
    "2026-03-27T23:03:00.000Z",
    0,
    null,
    JSON.stringify([]),
    null,
    null,
    3600,
    100,
    3600,
    5,
    0,
    0,
    0,
    0,
    2,
    null,
    runId,
    null,
    null,
    `${sessionId}:key`,
    null,
    JSON.stringify([]),
    "2026-03-27T23:00:00.000Z",
    null,
    "2026-03-27T23:00:00.000Z",
    "2026-03-27T23:03:00.000Z",
  );

  db.prepare(`
    INSERT INTO agent_messages (
      id, workspace_id, from_instance_id, to_instance_id, message_type, content, context,
      session_id, workflow_run_id, airya_turn_id, read_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `lane-status-${suffix}`,
    WORKSPACE_ID,
    ownerInstanceId,
    observerInstanceId,
    "status",
    `Status proof for ${classification}`,
    JSON.stringify({
      navigator_event_kind: "proof",
      card_id: cardId,
      workflow_run_id: runId,
      session_id: sessionId,
      summary: `Status proof for ${classification}`,
      execution_state: "active",
      navigator_health: "green",
      current_risks: [],
      current_blockers: [],
    }),
    sessionId,
    runId,
    null,
    null,
    "2026-03-27T23:02:00.000Z",
  );

  if (classification !== "human_relay_only") {
    db.prepare(`
      INSERT INTO agent_messages (
        id, workspace_id, from_instance_id, to_instance_id, message_type, content, context,
        session_id, workflow_run_id, airya_turn_id, read_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `lane-control-${suffix}`,
      WORKSPACE_ID,
      classification === "self_loop_only" ? ownerInstanceId : controllerInstanceId,
      ownerInstanceId,
      "query",
      `Control message for ${classification}`,
      JSON.stringify({}),
      sessionId,
      runId,
      null,
      null,
      "2026-03-27T23:03:00.000Z",
    );
  }

  return {
    cardId,
    runId,
    sessionId,
  };
}
