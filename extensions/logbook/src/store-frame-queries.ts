import type { DatabaseSync } from "node:sqlite";
import {
  prepareSqliteQuerySync,
  type getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { MAX_FRAMES_PER_CALL } from "./analyze.js";
import type { LogbookDatabase, toFrame } from "./store-schema.js";

export function createLogbookFrameQueries(
  db: DatabaseSync,
  query: ReturnType<typeof getNodeSqliteKysely<LogbookDatabase>>,
) {
  // Timestamp ties follow insertion ids, matching existing SQLite reads.
  const framesQuery = query
    .selectFrom("frames")
    .select([
      "id",
      "captured_at_ms",
      "day",
      "path",
      "screen_index",
      "width",
      "height",
      "byte_size",
      "idle",
    ])
    .orderBy("captured_at_ms", "asc")
    .orderBy("id", "asc");
  const sampledBatchFrames = prepareSqliteQuerySync<number, Parameters<typeof toFrame>[0]>(
    db,
    (p) => {
      const sampledIds = query
        .with("ordered_frames", (cte) =>
          cte
            .selectFrom("frames")
            .select("id")
            .select((eb) => [
              eb.fn
                .agg<number>("row_number", [])
                .over((ob) => ob.orderBy("captured_at_ms", "asc").orderBy("id", "asc"))
                .as("ordinal"),
              eb.fn.countAll<number>().over().as("total"),
            ])
            .where(
              "batch_id",
              "=",
              p((batchId) => batchId),
            ),
        )
        .selectFrom("ordered_frames")
        .select("id")
        .where((eb) => {
          const step = eb(
            eb.cast<number>(eb("total", "-", eb.val(1)), "real"),
            "/",
            eb.val(MAX_FRAMES_PER_CALL - 1),
          );
          return eb.or([
            eb("total", "<=", MAX_FRAMES_PER_CALL),
            ...Array.from({ length: MAX_FRAMES_PER_CALL }, (_, index) =>
              // Positive ordinals use Math.round(index * ((total - 1) / 15)) + 1.
              eb(
                "ordinal",
                "=",
                eb(
                  eb.cast<number>(eb(eb(eb.val(index), "*", step), "+", eb.val(0.5)), "integer"),
                  "+",
                  eb.val(1),
                ),
              ),
            ),
          ]);
        });
      return framesQuery.where("id", "in", sampledIds);
    },
  );
  return { framesQuery, sampledBatchFrames };
}
