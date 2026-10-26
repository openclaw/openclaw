import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { expect, it } from "vitest";
import { memoryPublicationCrashEntrypoint } from "./manager-publication-crash-entrypoint.test-support.js";
import {
  createPublication,
  publicationReplacement as replacement,
} from "./manager-publication-fixture.test-support.js";

const names = ["first", "second"];
const sourceRows = (hash: string) => names.map((name) => ({ path: `memory/${name}.md`, hash }));
const chunkRows = (text: string) =>
  names.flatMap((name) =>
    [1, 2].map((line) => ({ path: `memory/${name}.md`, text: `${text} ${line}` })),
  );

it.skipIf(process.platform === "win32")(
  "recovers rows and revision together after a publication process dies before commit",
  () => {
    let databasePath: string;
    {
      using seed = createPublication({ ftsEnabled: true });
      databasePath = seed.filename;
      seed.expectResult(
        { type: "source.replace.group", input: replacement("original") },
        { ok: true, facts: { revision: 1 } },
      );
    }
    const root = path.dirname(databasePath);

    const crashed = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(memoryPublicationCrashEntrypoint)),
        databasePath,
        JSON.stringify(replacement("discarded")),
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          OPENCLAW_STATE_DIR: root,
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
    expect(crashed.error, crashed.stderr).toBeUndefined();
    expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
    expect(JSON.parse(crashed.stdout)).toEqual({
      inTransaction: true,
      revision: 2,
      sources: sourceRows("discarded"),
      chunks: chunkRows("discarded"),
    });

    using retry = createPublication({ filename: databasePath, initialize: false });
    const reopened = retry.db;
    const readChunks = () =>
      reopened
        .prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, start_line")
        .all();
    expect(reopened.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()).toEqual({
      revision: 1,
    });
    expect(
      reopened.prepare("SELECT path, hash FROM memory_index_sources ORDER BY path").all(),
    ).toEqual(sourceRows("original"));
    expect(readChunks()).toEqual(chunkRows("original"));
    retry.expectResult(
      { type: "source.replace.group", input: replacement("replacement") },
      { ok: true, facts: { revision: 2 } },
    );
    expect(readChunks()).toEqual(chunkRows("replacement"));
  },
);
