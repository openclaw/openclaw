import assert from "node:assert/strict";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks, type WorkerTaskChannel } from "../src/infra/worker-task-server.js";

export type WorkerRuntimeBenchmarkInput = {
  id: number;
  payload: Uint8Array;
  exchanges: number;
  transfer: boolean;
};

export type WorkerRuntimeBenchmarkOutput = WorkerRuntimeBenchmarkInput & {
  checksum: number;
  threadId: number;
};

serveWorkerTasks<WorkerRuntimeBenchmarkOutput>(
  async (input, channel): Promise<WorkerRuntimeBenchmarkOutput> => {
    assert.ok(isRecord(input));
    assert.ok(typeof input.id === "number");
    assert.ok(input.payload instanceof Uint8Array);
    assert.ok(typeof input.exchanges === "number");
    assert.ok(typeof input.transfer === "boolean");
    const { id, payload, exchanges, transfer } = input;
    let checksum = 0;
    for (const byte of payload) {
      checksum += byte;
    }
    if (exchanges > 0) {
      assert.ok(channel);
      channel.consumeInput();
      for (let exchange = 0; exchange < exchanges; exchange++) {
        const reply: Awaited<ReturnType<WorkerTaskChannel["request"]>> = await channel.request({
          id,
          exchange,
        });
        assert.deepEqual(reply.input, { id, exchange });
        reply.consumed();
      }
    }
    return { id, payload, exchanges, transfer, checksum, threadId };
  },
  {
    transferList(output) {
      if (!output.transfer) {
        return [];
      }
      const buffer = output.payload.buffer;
      assert.ok(buffer instanceof ArrayBuffer);
      return [buffer];
    },
  },
);
