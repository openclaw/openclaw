import { randomUUID } from "node:crypto";
import { MemoryIndexDatabase } from "./manager-database-context.js";

/** Retain the agent connection, but release its writer queue between staging batches. */
export async function withPostgresMemoryReindex<T>(
  published: MemoryIndexDatabase,
  run: (stage: MemoryIndexDatabase) => Promise<T>,
): Promise<T> {
  const assertCurrent = () => {
    if (!published.isOpen) {
      throw new Error("Memory publication owner closed during reindex");
    }
  };
  const stage = new MemoryIndexDatabase(
    undefined,
    undefined,
    false,
    published.writeOptions,
    true,
    published.admission,
  );
  const stageId = randomUUID();
  stage.postgresStageId = stageId;
  Object.assign(stage.vector, published.vector);
  Object.assign(stage.fts, published.fts);
  try {
    await stage.retryPublication(() =>
      stage.executePublication({ type: "database.stage.start", input: undefined }, assertCurrent),
    );
    return await run(stage);
  } finally {
    await stage.closeShadow();
    if (published.isOpen) {
      await published.executePublication(
        { type: "database.stage.discard", input: { stageId } },
        assertCurrent,
      );
    }
  }
}

export async function publishPostgresMemoryStage(
  published: MemoryIndexDatabase,
  stage: MemoryIndexDatabase,
  expectedRevision: number,
  vectorIndexComplete: boolean,
  assertCurrent: () => void,
) {
  const stageId = stage.postgresStageId;
  if (!stageId) {
    throw new Error("Memory reindex has no PostgreSQL stage");
  }
  await published.retryPublication(() =>
    published.executePublication(
      {
        type: "database.stage.publish",
        input: { stageId, expectedRevision, vectorIndexComplete },
      },
      assertCurrent,
    ),
  );
}
