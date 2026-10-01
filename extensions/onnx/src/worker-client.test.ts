import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassificationInput } from "./models/types.js";
import { InferenceWorkerClient } from "./worker-client.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const clients: InferenceWorkerClient[] = [];
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
let dir;
const record = (event) => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ...event, pid: process.pid }) + '\\n');
process.on('disconnect', () => process.exit(0));
process.on('message', async (request) => {
  if (request.kind === 'init') {
    dir = request.config.modelDir;
    record({ kind: 'init' });
    if (${options.holdInit === true}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    process.send({ kind: 'ready' });
    return;
  }
  if (request.kind === 'warm') {
    record({ kind: 'warm' });
    process.send({ kind: 'warmed', id: request.id });
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
  if (text === 'missing') { process.send({ kind: 'error', id: request.id, code: 'model-missing' }); return; }
  if (text === 'exit') process.exit(7);
  const results = request.inputs.map(() => ({ logits: [process.pid, Number(Boolean(process.env.ONNX_CLIENT_TEST_SECRET))], inputTokens: 1 }));
  if (text === 'malformed') results[0].logits = ['invalid', 0];
  process.send({ kind: 'results', id: text === 'stale' ? request.id + 1000 : request.id, results: text === 'shape' ? [] : results });
});
`,
  );
  const client = new InferenceWorkerClient({
    workerUrl: pathToFileURL(entry),
    config: { modelDir: dir, threads: 1, maxLoadedModels: 1 },
  });
  clients.push(client);
  const events = (): FixtureEvent[] =>
    fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
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
  return {
    client,
    events,
    waitFor,
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

describe("InferenceWorkerClient", () => {
  it.for([
    [input("x".repeat(262145))[0]!],
    Array.from({ length: 8 }, () => input("x".repeat(150000))[0]!),
  ])("rejects oversized input before starting a worker and remains usable", async (inputs) => {
    const { client, events } = fixture();
    await expect(client.classify("test-model", inputs, signal())).rejects.toMatchObject({
      code: "unsupported-input",
    });
    expect(events()).toEqual([]);
    await expect(client.classify("test-model", input("valid"), signal())).resolves.toHaveLength(1);
  });

  it("reuses a warm process, preserves known model errors, and excludes inherited credentials", async () => {
    vi.stubEnv("ONNX_CLIENT_TEST_SECRET", "synthetic");
    const { client, events } = fixture();
    await client.warm(["test-model"], signal());
    const first = await client.classify("test-model", input("first"), signal());
    await expect(client.classify("test-model", input("missing"), signal())).rejects.toMatchObject({
      code: "model-missing",
    });
    const second = await client.classify("test-model", input("second"), signal());
    expect(first).toEqual(second);
    expect(first[0]?.logits[1]).toBe(0);
    expect(events().filter((event) => event.kind === "init")).toHaveLength(1);
    const pid = first[0]!.logits[0]!;
    expect(alive(pid)).toBe(true);
    await client.stop();
    expect(alive(pid)).toBe(false);
  });

  it("removes canceled queued work without killing active work and enforces FIFO capacity", async () => {
    const { client, events, waitFor, release } = fixture();
    const active = client.classify("test-model", input("wait"), signal());
    const started = await waitFor((event) => event.text === "wait");
    const canceled = new AbortController();
    const queued = client.classify("test-model", input("canceled"), canceled.signal);
    const queuedRejected = expect(queued).rejects.toThrow("queued canceled");
    const second = client.classify("test-model", input("second"), signal());
    const third = client.classify("test-model", input("third"), signal());
    await expect(client.classify("test-model", input("overflow"), signal())).rejects.toMatchObject({
      code: "runtime",
    });
    canceled.abort(new Error("queued canceled"));
    await queuedRejected;
    const fourth = client.classify("test-model", input("fourth"), signal());
    expect(alive(started.pid)).toBe(true);
    release();
    const results = await Promise.all([active, second, third, fourth]);
    expect(results.every((result) => result[0]?.logits[0] === started.pid)).toBe(true);
    expect(
      events()
        .filter((event) => event.kind === "classify")
        .map((event) => event.text),
    ).toEqual(["wait", "second", "third", "fourth"]);
  });

  it("joins native process exit before settling active cancellation and restarts surviving queued work", async () => {
    const { client, waitFor } = fixture();
    const controller = new AbortController();
    const active = client.classify("test-model", input("block"), controller.signal);
    const rejected = expect(active).rejects.toThrow("active canceled");
    const started = await waitFor((event) => event.text === "block");
    const queued = client.classify("test-model", input("survivor"), signal());
    controller.abort(new Error("active canceled"));
    await rejected;
    expect(alive(started.pid)).toBe(false);
    const result = await queued;
    expect(result[0]?.logits[0]).not.toBe(started.pid);
  });

  it.each(["stale", "malformed", "shape", "exit"])(
    "rejects %s replies and recovers queued work in a new process",
    async (text) => {
      const { client, events } = fixture();
      const bad = client.classify("test-model", input(text), signal());
      const rejected = expect(bad).rejects.toMatchObject({ code: "runtime" });
      const good = client.classify("test-model", input("recovery"), signal());
      await rejected;
      const result = await good;
      const oldPid = events().find((event) => event.text === text)!.pid;
      expect(alive(oldPid)).toBe(false);
      expect(result[0]?.logits[0]).not.toBe(oldPid);
    },
  );

  it.each([false, true])(
    "stops and joins running work even before readiness (%s), then refuses new admission",
    async (holdInit) => {
      const { client, waitFor, events } = fixture({ holdInit });
      const active = client.classify("test-model", input("block"), signal());
      const activeRejected = expect(active).rejects.toMatchObject({ code: "runtime" });
      const started = await waitFor((event) =>
        holdInit ? event.kind === "init" : event.text === "block",
      );
      const queued = client.warm(["test-model"], signal());
      const queuedRejected = expect(queued).rejects.toMatchObject({ code: "runtime" });
      await Promise.all([client.stop(), client.stop(), activeRejected, queuedRejected]);
      expect(alive(started.pid)).toBe(false);
      await expect(client.classify("test-model", input("late"), signal())).rejects.toMatchObject({
        code: "runtime",
      });
      expect(events().filter((event) => event.kind === "init")).toHaveLength(1);
      expect(events().some((event) => event.kind === "warm")).toBe(false);
    },
  );
});
