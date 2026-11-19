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
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createOnnxProvider } from "./decisions.js";
import { InferenceWorkerClient } from "./worker-client.js";

const clients: InferenceWorkerClient[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Kill and join blocked work before removing its fixture files.
    await Promise.all(clients.splice(0).map((client) => client.stop()));
    cleanup();
    vi.unstubAllEnvs();
  }),
);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

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
import { join } from 'node:path';
${fixtureReceiptClientSource(receipts.endpoint)}
let eventsPath;
const record = (event) => {
  fs.appendFileSync(eventsPath, JSON.stringify({ ...event, pid: process.pid }) + '\\n');
  if (event.text === 'wait') sendReceipt(eventsPath, 'classify wait');
};
process.on('disconnect', () => process.exit(0));
process.on('message', async (request) => {
  if (request.kind !== 'classify') {
    if (request.kind === 'init') eventsPath = join(request.config.modelDir, 'events.jsonl');
    record({ kind: request.kind });
    if (request.kind === 'init' && ${options.holdInit === true}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    if (request.kind === 'warm') process.send({ kind: 'warmed' });
    return;
  }
  const text = request.inputs[0].text;
  record({ kind: 'classify', text });
  if (text === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  if (text === 'wait') {
    while (!fs.existsSync(${JSON.stringify(path.join(dir, "release"))})) {
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
  const config = { modelDir: dir, threads: 1, maxLoadedModels: 1 };
  const client = new InferenceWorkerClient({ workerUrl: pathToFileURL(entry), config });
  clients.push(client);
  const events = (kind?: string): FixtureEvent[] =>
    fs
      .readFileSync(eventsPath, "utf8")
      .split("\n")
      .flatMap((line): FixtureEvent[] => (line ? [JSON.parse(line)] : []))
      .filter((event) => kind === undefined || event.kind === kind);
  const findEvent = (match: (event: FixtureEvent) => boolean, failure?: unknown) => {
    const found = events().find(match);
    if (!found) {
      throw failure instanceof Error
        ? failure
        : new Error("Fixture did not reach the requested IPC boundary", { cause: failure });
    }
    return found;
  };
  const waitFor = (match: (event: FixtureEvent) => boolean) =>
    vi.waitFor(() => findEvent(match), { timeout: 10_000 });
  const observedHeld = (failure?: unknown) => findEvent((event) => event.text === "wait", failure);
  const classify = (text: string, abortSignal = signal()) =>
    client.classify("test-model", input(text), abortSignal);
  return {
    client,
    classify,
    events,
    waitFor,
    waitHeld: (operation: PromiseLike<unknown>, signal: AbortSignal) =>
      withinTest(
        Promise.race([
          // The event log is durable before any reply; receipts use a separate pipe.
          receipts.waitFor(eventsPath, "classify wait").then(() => observedHeld()),
          Promise.resolve(operation).then(() => observedHeld(), observedHeld),
        ]),
        signal,
      ),
    release: () => fs.writeFileSync(path.join(dir, "release"), ""),
  };
}

const input = (text: string) => [{ text, labels: ["yes", "no"], task: "test" }];

const expectDead = (pid: number) =>
  expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));

const signal = () => new AbortController().signal;
const rejectsCode = (operation: Promise<unknown>, code = "runtime") =>
  expect(operation).rejects.toMatchObject({ code });

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
  expect(() => process.kill(pid, 0)).not.toThrow();
  await client.stop();
  expectDead(pid);
});

it("preserves FIFO and active work when queued work is canceled", async (ctx) => {
  const { classify, events, waitHeld, release } = fixture();
  const active = classify("wait");
  void active.catch(() => {});
  const started = await waitHeld(active, ctx.signal);
  const canceled = new AbortController();
  const queued = classify("canceled", canceled.signal);
  const queuedRejected = expect(queued).rejects.toThrow("queued canceled");
  const second = classify("second");
  const third = classify("third");
  await rejectsCode(classify("overflow"));
  canceled.abort(new Error("queued canceled"));
  await queuedRejected;
  const fourth = classify("fourth");
  expect(() => process.kill(started.pid, 0)).not.toThrow();
  release();
  const results = await Promise.all([active, second, third, fourth]);
  expect(results.every((result) => result[0]?.logits[0] === started.pid)).toBe(true);
  expect(events("classify")).toMatchObject(
    ["wait", "second", "third", "fourth"].map((text) => ({ text, pid: started.pid })),
  );
});

it.for(["closed", "throws"] as const)(
  "skips admission=%s without restarting the warm worker",
  async (mode, ctx) => {
    const { client, events, waitHeld, release } = fixture();
    const provider = createOnnxProvider(client, vi.fn());
    const question = { type: "boolean" as const, criteria: { true: "yes", false: "no" } };
    const context = {
      model: "gliclass-edge-v3.0",
      signal: signal(),
      deadlineMonotonicMs: performance.now() + 30_000,
    };
    const evaluate = (text: string, isAdmissible?: () => boolean) =>
      provider.evaluate(
        { state: text, questions: { needed: question } },
        { ...context, isAdmissible },
      );
    const active = evaluate("wait");
    const started = await waitHeld(active, ctx.signal);
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
    expect(events("classify")).toMatchObject(
      ["wait", "survivor"].map((text) => ({ text, pid: started.pid })),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["ok", "unavailable", "ok"]);
    expect(() => process.kill(started.pid, 0)).not.toThrow();
  },
);

it.each(["cancel", "exit"])("joins %s before recovery", async (mode) => {
  const { classify, waitFor } = fixture();
  const controller = new AbortController();
  const text = mode === "cancel" ? "block" : "exit";
  const active = classify(text, controller.signal);
  const rejected =
    mode === "cancel" ? expect(active).rejects.toThrow("active canceled") : rejectsCode(active);
  const queued = classify("survivor");
  const started = await waitFor((event) => event.text === text);
  if (mode === "cancel") {
    controller.abort(new Error("active canceled"));
  }
  await rejected;
  expectDead(started.pid);
  const result = await queued;
  expect(result[0]?.logits[0]).not.toBe(started.pid);
});

it.each([false, true])("joins stop and rejects new work (init=%s)", async (holdInit) => {
  const { client, classify, waitFor, events } = fixture({ holdInit });
  const activeRejected = rejectsCode(classify("block"));
  const started = await waitFor((event) =>
    holdInit ? event.kind === "init" : event.text === "block",
  );
  const queued = client.warm(["test-model"], signal());
  const queuedRejected = rejectsCode(queued);
  await Promise.all([client.stop(), client.stop(), activeRejected, queuedRejected]);
  expectDead(started.pid);
  await rejectsCode(classify("late"));
  expect(events("init")).toHaveLength(1);
  expect(events("warm")).toHaveLength(0);
});
