import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  createWorkerDiagnosticForwarder,
  createWorkerDiagnosticReceiver,
} from "./worker-diagnostics.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("delivers only bounded native classifications through the Gateway logger, never stderr content", async () => {
  const log = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => {});
  const receiver = createWorkerDiagnosticReceiver();
  const forwarder = createWorkerDiagnosticForwarder(async (frame) => {
    expect(receiver.consume(frame)).toBe(true);
  });
  const trace =
    JSON.stringify({
      level: "ERROR",
      target: "codex_core::client",
      fields: {
        message: "authentication failed Bearer private-token; user prompt and command content",
        token: "private-token",
      },
      span: { prompt: "private input" },
    }) + "\n";
  const bytes = Buffer.from(trace);
  forwarder.append(bytes.subarray(0, 25));
  forwarder.append(bytes.subarray(25));
  // A split multibyte character is retained only in the bounded private line parser.
  const unicode = Buffer.from(
    '{"level":"WARN","target":"codex_exec","fields":{"message":"秘密"}}\n',
  );
  const split = unicode.indexOf(Buffer.from("秘")) + 1;
  forwarder.append(unicode.subarray(0, split));
  forwarder.append(unicode.subarray(split));
  forwarder.append(Buffer.from('{"level":"ERROR","fields":{"message":"truncated 秘'));
  forwarder.nativeExit(7, null);
  await forwarder.finish();
  const records = log.mock.calls.map(([message]) =>
    JSON.parse(message.split("OPENCLAW_WORKER_DIAGNOSTIC_V1 ")[1]!),
  );
  expect(records).toEqual([
    {
      version: 1,
      transportId: expect.any(String),
      event: "native_stderr",
      level: "ERROR",
      component: "core",
      category: "auth",
      bytes: bytes.length - 1,
    },
    {
      version: 1,
      transportId: records[0].transportId,
      event: "native_stderr",
      level: "WARN",
      component: "exec",
      category: "other",
      bytes: unicode.length - 1,
    },
    {
      version: 1,
      transportId: records[0].transportId,
      event: "native_exit",
      code: 7,
      signal: null,
    },
    { version: 1, transportId: records[0].transportId, event: "dropped", count: 1 },
  ]);
  expect(JSON.stringify(records)).not.toMatch(/private|Bearer|prompt|command|span|秘密|truncated/);
});

it("keeps draining noisy stderr while diagnostics are blocked, bounds the queue and closes without waiting forever", async () => {
  vi.useFakeTimers();
  const blocked = Promise.withResolvers<void>();
  const send = vi.fn(async () => blocked.promise);
  const forwarder = createWorkerDiagnosticForwarder(send);
  const trace = Buffer.from(
    JSON.stringify({
      level: "WARN",
      target: "codex_app_server",
      fields: { message: "connection failed" },
    }) + "\n",
  );
  for (let n = 0; n < 10000; n++) {
    forwarder.append(trace);
  }
  forwarder.append(Buffer.alloc(128 * 1024, 120));
  forwarder.append(Buffer.from("\n"));
  forwarder.nativeExit(0, null);
  const finishing = forwarder.finish();
  await vi.advanceTimersByTimeAsync(250);
  await expect(finishing).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
  blocked.resolve();
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(1);
});

it("reports dropped/rate-limited lines, resumes next window, and rejects forged export fields", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => {});
  const receiver = createWorkerDiagnosticReceiver();
  const forwarder = createWorkerDiagnosticForwarder(async (frame) => {
    receiver.consume(frame);
  });
  const trace = Buffer.from('{"level":"INFO","target":"codex_exec","fields":{"message":"ok"}}\n');
  for (let n = 0; n < 25; n++) {
    forwarder.append(trace);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  await vi.advanceTimersByTimeAsync(60000);
  forwarder.append(trace);
  forwarder.nativeExit(0, null);
  await forwarder.finish();
  const output = log.mock.calls.map(([message]) => message);
  expect(output.some((line) => line.includes('"event":"dropped"'))).toBe(true);
  const before = log.mock.calls.length;
  receiver.consume(
    Buffer.from(
      '{"method":"openclaw/workerDiagnostic","params":{"version":1,"event":"native_stderr","level":"private-token","component":"core","category":"auth","bytes":5}}',
    ),
  );
  expect(log).toHaveBeenCalledTimes(before);
  expect(
    receiver.consume(Buffer.from('{"id":1,"result":{"text":"ordinary protocol content"}}')),
  ).toBe(false);
});
