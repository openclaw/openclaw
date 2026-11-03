import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { expect, it, vi } from "vitest";
import { initializeSqliteRuntimeCapabilities } from "../../../src/infra/bun-sqlite-library.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow,
  readWorkerRows,
} from "../../../src/infra/sqlite-worker-fixture.test-support.js";
import * as workerCpu from "../../../src/infra/worker-cpu.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { openIMessageChatDbReader } from "./chat-db.js";

await initializeSqliteRuntimeCapabilities();
const { databasePath, open } = useSqliteWorkerStoreFixture("imessage-admission-");

it.for(["open", "read"] as const)(
  "keeps storage responsive during a blocked chat.db %s",
  async (phase, { signal }) => {
    const gate = new Int32Array(new SharedArrayBuffer(8));
    const createWorker = workerCpu.createCpuTrackedWorker;
    using workerObserver = vi.spyOn(workerCpu, "createCpuTrackedWorker");
    workerObserver.mockImplementation((url, options, requestClass) => {
      const data: unknown = options?.workerData;
      return createWorker(
        url,
        {
          ...options,
          workerData: { ...(isRecord(data) ? data : {}), chatDbGate: gate.buffer },
        },
        requestClass,
      );
    });
    const storage = await open(databasePath());
    // Fill the ordinary pool so a foreign read would share a storage carrier.
    const sibling = await open(databasePath());
    const chatPath = databasePath();
    writeFileSync(chatPath, "");
    const backend = path.join(path.dirname(chatPath), "chat-db-fixture.mjs");
    writeFileSync(
      backend,
      `import { workerData } from "node:worker_threads";
       function block() {
         const gate = new Int32Array(workerData.chatDbGate);
         Atomics.store(gate, 1, 1);
         Atomics.notify(gate, 1);
         Atomics.wait(gate, 0, 0);
       }
       export function openExistingSqliteWorkerBackend() {
         ${phase === "open" ? "block();" : ""}
         return { execute() { ${phase === "read" ? "block();" : ""} return 17; }, close() {} };
       }`,
    );
    const resolveWorker = processRuntime.resolveRuntimeWorkerUrl;
    using backendOverride = vi.spyOn(processRuntime, "resolveRuntimeWorkerUrl");
    backendOverride.mockImplementation((entry) =>
      entry.sourceWorkerName === "chat-db.worker" ? pathToFileURL(backend) : resolveWorker(entry),
    );
    let settled = false;
    const reading = openIMessageChatDbReader(chatPath)
      .then(async (store) => {
        assert(store);
        try {
          return await store.execute({ type: "startupWatermark", input: undefined });
        } finally {
          await store.close();
        }
      })
      .finally(() => {
        settled = true;
      });
    void reading.catch(() => undefined);
    try {
      await withinTest(Promise.resolve(Atomics.waitAsync(gate, 1, 0).value), signal);
      const responsive =
        phase === "open" ? await withinTest(open(databasePath()), signal) : storage;
      await withinTest(appendWorkerRow(responsive, "alive"), signal);
      await expect(readWorkerRows(responsive)).resolves.toEqual(["alive"]);
      await withinTest(appendWorkerRow(sibling, "sibling"), signal);
      expect(settled).toBe(false);
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      await reading;
    }
  },
);
