import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createOnnxProvider } from "./decisions.js";
import type { ClassificationInput } from "./models/types.js";
import { InferenceWorkerClient } from "./worker-client.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const clients: InferenceWorkerClient[] = [];
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  vi.unstubAllEnvs();
});

type FixtureEvent = { kind: string; pid: number; text?: string };

function fixture(options: { holdInit?: boolean } = {}) {
  const dir = tempDirs.make("openclaw-onnx-client-");
  const entry = path.join(dir, "worker.mjs");
  const eventsPath = path.join(dir, "events.jsonl");
  fs.writeFileSync(eventsPath, "");
  fs.writeFileSync(
    entry,
    `
import fs from 'node:fs';
import path from 'node:path';
${fixtureReceiptClientSource(receipts.endpoint)}
let dir;
const record = (event) => {
  const eventsPath = path.join(dir, 'events.jsonl');
  fs.appendFileSync(eventsPath, JSON.stringify({ ...event, pid: process.pid }) + '\\n');
  if (event.text === 'wait') sendReceipt(eventsPath, 'classify wait');
};
process.on('disconnect', () => process.exit(0));
process.on('message', async (request) => {
  if (request.kind === 'init') {
    dir = request.config.modelDir;
    record({ kind: 'init' });
    if (${options.holdInit === true}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return;
  }
  if (request.kind === 'warm') {
    record({ kind: 'warm' });
    process.send({ kind: 'warmed' });
    return;
  }
  const text = request.inputs[0].text;
  record({ kind: 'classify', text });
  if (text === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  if (text === 'wait') {
    const releasePath = path.join(dir, 'release');
    while (!fs.existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (text === 'missing') { process.send({ kind: 'error', code: 'model-missing' }); return; }
  if (text === 'exit') process.exit(7);
  const results = request.inputs.map(() => ({ logits: [process.pid, Number(Boolean(process.env.ONNX_CLIENT_TEST_SECRET))], inputTokens: 1 }));
  process.send({ kind: 'results', results });
});
`,
  );
  const client = new InferenceWorkerClient({
    workerUrl: pathToFileURL(entry),
    config: { modelDir: dir, threads: 1, maxLoadedModels: 1 },
  });
  clients.push(client);
  const events = (kind?: string): FixtureEvent[] =>
    fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string): FixtureEvent => JSON.parse(line))
      .filter((event) => kind === undefined || event.kind === kind);
  const waitFor = (match: (event: FixtureEvent) => boolean): Promise<FixtureEvent> =>
    vi.waitFor(
      () => {
        const found = events().find(match);
        if (!found) {
          throw new Error("Fixture did not reach the requested IPC boundary");
        }
        return found;
      },
      { timeout: 10_000 },
    );
  const observedHeld = () => {
    const found = events().find((event) => event.text === "wait");
    if (!found) {
      throw new Error("Fixture did not reach the requested IPC boundary");
    }
    return found;
  };
  const classify = (text: string, abortSignal = signal()) =>
    client.classify("test-model", input(text), abortSignal);
  return {
    client,
    classify,
    events,
    waitFor,
    waitHeld: async (operation: PromiseLike<unknown>, signal: AbortSignal) => {
      await withinTest(
        Promise.race([
          receipts.waitFor(eventsPath, "classify wait"),
          // The event log is durable before any reply; receipts use a separate pipe.
          Promise.resolve(operation).then(observedHeld, (error: unknown) => {
            if (!events().some((event) => event.text === "wait")) {
              throw error;
            }
          }),
        ]),
        signal,
      );
      return observedHeld();
    },
    release: () => fs.writeFileSync(path.join(dir, "release"), ""),
  };
}

function input(text: string): ClassificationInput[] {
  return [{ text, labels: ["yes", "no"], task: "test" }];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

const signal = () => new AbortController().signal;
const rejectsCode = (operation: Promise<unknown>, code = "runtime") =>
  expect(operation).rejects.toMatchObject({ code });

describe("InferenceWorkerClient", () => {
  it.for([
    [input("x".repeat(262145))[0]!],
    Array.from({ length: 8 }, () => input("x".repeat(150000))[0]!),
  ])("rejects oversized input before starting a worker and remains usable", async (inputs) => {
    const { client, classify, events } = fixture();
    await rejectsCode(client.classify("test-model", inputs, signal()), "unsupported-input");
    expect(events()).toEqual([]);
    await expect(classify("valid")).resolves.toHaveLength(1);
  });

  it("reuses a warm process, preserves known model errors, and excludes inherited credentials", async () => {
    vi.stubEnv("ONNX_CLIENT_TEST_SECRET", "synthetic");
    const { client, classify, events } = fixture();
    await client.warm(["test-model"], signal());
    const first = await classify("first");
    await rejectsCode(classify("missing"), "model-missing");
    const second = await classify("second");
    expect(first).toEqual(second);
    expect(first[0]?.logits[1]).toBe(0);
    expect(events("init")).toHaveLength(1);
    const pid = first[0]!.logits[0]!;
    expect(alive(pid)).toBe(true);
    await client.stop();
    expect(alive(pid)).toBe(false);
  });

  it("removes canceled queued work without killing active work and enforces FIFO capacity", async ({
    signal: testSignal,
  }) => {
    const { client, classify, events, waitHeld, release } = fixture();
    const active = classify("wait");
    void active.catch(() => {});
    try {
      const started = await waitHeld(active, testSignal);
      const canceled = new AbortController();
      const queued = classify("canceled", canceled.signal);
      const queuedRejected = expect(queued).rejects.toThrow("queued canceled");
      const second = classify("second");
      const third = classify("third");
      await rejectsCode(classify("overflow"));
      canceled.abort(new Error("queued canceled"));
      await queuedRejected;
      const fourth = classify("fourth");
      expect(alive(started.pid)).toBe(true);
      release();
      const results = await Promise.all([active, second, third, fourth]);
      expect(results.every((result) => result[0]?.logits[0] === started.pid)).toBe(true);
      expect(events("classify").map((event) => event.text)).toEqual([
        "wait",
        "second",
        "third",
        "fourth",
      ]);
    } finally {
      release();
      await client.stop();
    }
  });

  it.for(["closed", "throws"] as const)(
    "skips queued decisions whose admission %s without restarting the warm worker",
    async (mode, { signal: testSignal }) => {
      const { client, events, waitHeld, release } = fixture();
      const provider = createOnnxProvider(client, vi.fn());
      const evaluate = (text: string, isAdmissible?: () => boolean) =>
        provider.evaluate(
          {
            state: text,
            questions: {
              needed: {
                type: "boolean",
                criteria: { true: "Work is needed", false: "No work is needed" },
              },
            },
          },
          {
            model: "gliclass-edge-v3.0",
            signal: signal(),
            deadlineMonotonicMs: performance.now() + 30_000,
            isAdmissible,
          },
        );
      const active = evaluate("wait");
      try {
        const started = await waitHeld(active, testSignal);
        let admitted = true;
        const queued = evaluate("revoked", () => {
          if (!admitted && mode === "throws") {
            throw new Error("consumer authority closed");
          }
          return admitted;
        });
        admitted = false;
        const survivor = evaluate("survivor");
        release();
        const outcomes = await Promise.all([active, queued, survivor]);
        const classifications = events("classify");
        expect(classifications.map((event) => event.text)).toEqual(["wait", "survivor"]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(["ok", "unavailable", "ok"]);
        expect(classifications.every((event) => event.pid === started.pid)).toBe(true);
        expect(alive(started.pid)).toBe(true);
      } finally {
        release();
        await client.stop();
      }
    },
  );

  it("joins native process exit before settling active cancellation and restarts surviving queued work", async () => {
    const { classify, waitFor } = fixture();
    const controller = new AbortController();
    const active = classify("block", controller.signal);
    const rejected = expect(active).rejects.toThrow("active canceled");
    const started = await waitFor((event) => event.text === "block");
    const queued = classify("survivor");
    controller.abort(new Error("active canceled"));
    await rejected;
    expect(alive(started.pid)).toBe(false);
    const result = await queued;
    expect(result[0]?.logits[0]).not.toBe(started.pid);
  });

  it("recovers queued work in a new process after the worker exits", async () => {
    const { classify, events } = fixture();
    const rejected = rejectsCode(classify("exit"));
    const good = classify("recovery");
    await rejected;
    const result = await good;
    const oldPid = events().find((event) => event.text === "exit")!.pid;
    expect(alive(oldPid)).toBe(false);
    expect(result[0]?.logits[0]).not.toBe(oldPid);
  });

  it.each([false, true])(
    "stops and joins running work with initialization blocked=%s, then refuses new admission",
    async (holdInit) => {
      const { client, classify, waitFor, events } = fixture({ holdInit });
      const activeRejected = rejectsCode(classify("block"));
      const started = await waitFor((event) =>
        holdInit ? event.kind === "init" : event.text === "block",
      );
      const queued = client.warm(["test-model"], signal());
      const queuedRejected = rejectsCode(queued);
      await Promise.all([client.stop(), client.stop(), activeRejected, queuedRejected]);
      expect(alive(started.pid)).toBe(false);
      await rejectsCode(classify("late"));
      expect(events("init")).toHaveLength(1);
      expect(events("warm")).toHaveLength(0);
    },
  );
});
