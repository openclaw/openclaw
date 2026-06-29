/**
 * Phase 3 associative-memory foundation: local tag/entity vocabulary plus
 * lightweight links from durable turns/spans/boxes to that vocabulary. Retrieval
 * and dreaming can consume this later without changing Phase 2 turn capture.
 */
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";

type AssociativeDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "memory_associations" | "memory_entities" | "memory_tag_edges" | "memory_tags"
>;

export type MemoryTagRow = Selectable<OpenClawAgentKyselyDatabase["memory_tags"]>;
export type MemoryTagEdgeRow = Selectable<OpenClawAgentKyselyDatabase["memory_tag_edges"]>;
export type MemoryEntityRow = Selectable<OpenClawAgentKyselyDatabase["memory_entities"]>;
export type MemoryAssociationRow = Selectable<OpenClawAgentKyselyDatabase["memory_associations"]>;

export type MemoryAssociationTarget =
  | { type: "box"; boxId: string; sessionKey: string }
  | { type: "span"; sessionKey: string; spanId: string }
  | { type: "turn"; seq: number; sessionKey: string };

export type MemoryAssociationSource = "agent" | "dream" | "human" | "import";

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function assertNonBlank(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be blank`);
  }
  return trimmed;
}

function targetId(target: MemoryAssociationTarget): string {
  if (target.type === "turn") {
    return String(target.seq);
  }
  if (target.type === "box") {
    return target.boxId;
  }
  return target.spanId;
}

function associationId(params: {
  entityId?: string | null;
  tagId?: string | null;
  target: MemoryAssociationTarget;
}): string {
  const ref = params.tagId ? `tag:${params.tagId}` : `entity:${params.entityId ?? ""}`;
  return `${params.target.sessionKey}:${params.target.type}:${targetId(params.target)}:${ref}`;
}

function tagExists(database: ReturnType<typeof openOpenClawAgentDatabase>, tagId: string): boolean {
  const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
  return (
    executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("memory_tags").select("tag_id").where("tag_id", "=", tagId),
    ) != null
  );
}

function entityExists(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  entityId: string,
): boolean {
  const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
  return (
    executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("memory_entities").select("entity_id").where("entity_id", "=", entityId),
    ) != null
  );
}

function hasPathToTag(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  startTagId: string,
  targetTagId: string,
  seen = new Set<string>(),
): boolean {
  if (startTagId === targetTagId) {
    return true;
  }
  if (seen.has(startTagId)) {
    return false;
  }
  seen.add(startTagId);
  const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
  const parents = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("memory_tag_edges")
      .select("parent_tag_id")
      .where("child_tag_id", "=", startTagId),
  ).rows;
  return parents.some((row) => hasPathToTag(database, row.parent_tag_id, targetTagId, seen));
}

export function upsertMemoryTag(
  options: OpenClawAgentDatabaseOptions & {
    tag: {
      label: string;
      tagId: string;
    };
  },
): void {
  const tagId = assertNonBlank(options.tag.tagId, "tagId");
  const label = assertNonBlank(options.tag.label, "label");
  const now = Date.now();
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("memory_tags")
        .values({
          tag_id: tagId,
          label,
          normalized_label: normalizeLabel(label),
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("tag_id").doUpdateSet({
            label,
            normalized_label: normalizeLabel(label),
            updated_at: now,
          }),
        ),
    );
  }, options);
}

export function linkMemoryTagParent(
  options: OpenClawAgentDatabaseOptions & {
    childTagId: string;
    parentTagId: string;
    relation?: string;
  },
): void {
  const childTagId = assertNonBlank(options.childTagId, "childTagId");
  const parentTagId = assertNonBlank(options.parentTagId, "parentTagId");
  if (childTagId === parentTagId) {
    throw new Error("A memory tag cannot be its own parent");
  }
  const relation = assertNonBlank(options.relation ?? "is_a", "relation");
  const now = Date.now();
  runOpenClawAgentWriteTransaction((database) => {
    if (!tagExists(database, childTagId)) {
      throw new Error(`Unknown memory tag: ${childTagId}`);
    }
    if (!tagExists(database, parentTagId)) {
      throw new Error(`Unknown memory tag: ${parentTagId}`);
    }
    if (hasPathToTag(database, parentTagId, childTagId)) {
      throw new Error(`Linking ${childTagId} -> ${parentTagId} would create a tag cycle`);
    }
    const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("memory_tag_edges")
        .values({ child_tag_id: childTagId, parent_tag_id: parentTagId, relation, created_at: now })
        .onConflict((conflict) =>
          conflict.columns(["child_tag_id", "parent_tag_id"]).doUpdateSet({ relation }),
        ),
    );
  }, options);
}

export function listMemoryTags(options: OpenClawAgentDatabaseOptions): MemoryTagRow[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("memory_tags").selectAll().orderBy("normalized_label", "asc"),
  ).rows;
}

export function listMemoryTagEdges(options: OpenClawAgentDatabaseOptions): MemoryTagEdgeRow[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("memory_tag_edges")
      .selectAll()
      .orderBy("child_tag_id", "asc")
      .orderBy("parent_tag_id", "asc"),
  ).rows;
}

export function upsertMemoryEntity(
  options: OpenClawAgentDatabaseOptions & {
    entity: {
      entityId: string;
      label: string;
      localOnly?: boolean;
      type: string;
    };
  },
): void {
  const entityId = assertNonBlank(options.entity.entityId, "entityId");
  const entityType = assertNonBlank(options.entity.type, "type");
  const label = assertNonBlank(options.entity.label, "label");
  const now = Date.now();
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("memory_entities")
        .values({
          entity_id: entityId,
          entity_type: entityType,
          label,
          normalized_label: normalizeLabel(label),
          local_only: options.entity.localOnly === false ? 0 : 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("entity_id").doUpdateSet({
            entity_type: entityType,
            label,
            normalized_label: normalizeLabel(label),
            local_only: options.entity.localOnly === false ? 0 : 1,
            updated_at: now,
          }),
        ),
    );
  }, options);
}

export function listMemoryEntities(options: OpenClawAgentDatabaseOptions): MemoryEntityRow[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("memory_entities")
      .selectAll()
      .orderBy("entity_type", "asc")
      .orderBy("normalized_label", "asc"),
  ).rows;
}

export function associateMemoryTag(
  options: OpenClawAgentDatabaseOptions & {
    salience?: number | null;
    source: MemoryAssociationSource;
    tagId: string;
    target: MemoryAssociationTarget;
  },
): void {
  associateMemoryRef({ ...options, entityId: null, tagId: assertNonBlank(options.tagId, "tagId") });
}

export function associateMemoryEntity(
  options: OpenClawAgentDatabaseOptions & {
    entityId: string;
    salience?: number | null;
    source: MemoryAssociationSource;
    target: MemoryAssociationTarget;
  },
): void {
  associateMemoryRef({
    ...options,
    entityId: assertNonBlank(options.entityId, "entityId"),
    tagId: null,
  });
}

function associateMemoryRef(
  options: OpenClawAgentDatabaseOptions & {
    entityId: string | null;
    salience?: number | null;
    source: MemoryAssociationSource;
    tagId: string | null;
    target: MemoryAssociationTarget;
  },
): void {
  const now = Date.now();
  runOpenClawAgentWriteTransaction((database) => {
    if (options.tagId != null && !tagExists(database, options.tagId)) {
      throw new Error(`Unknown memory tag: ${options.tagId}`);
    }
    if (options.entityId != null && !entityExists(database, options.entityId)) {
      throw new Error(`Unknown memory entity: ${options.entityId}`);
    }
    const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("memory_associations")
        .values({
          association_id: associationId(options),
          session_key: options.target.sessionKey,
          target_type: options.target.type,
          target_id: targetId(options.target),
          tag_id: options.tagId,
          entity_id: options.entityId,
          salience: options.salience ?? null,
          source: options.source,
          created_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("association_id").doUpdateSet({
            salience: options.salience ?? null,
            source: options.source,
          }),
        ),
    );
  }, options);
}

export function listMemoryAssociations(
  options: OpenClawAgentDatabaseOptions & {
    sessionKey: string;
    target?: MemoryAssociationTarget;
  },
): MemoryAssociationRow[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<AssociativeDatabase>(database.db);
  let query = db
    .selectFrom("memory_associations")
    .selectAll()
    .where("session_key", "=", options.sessionKey);
  if (options.target) {
    query = query
      .where("target_type", "=", options.target.type)
      .where("target_id", "=", targetId(options.target));
  }
  return executeSqliteQuerySync(database.db, query.orderBy("created_at", "asc")).rows;
}
