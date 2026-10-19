import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  acquireNativeMcpServer,
  type NativeMcpClientContext,
  type NativeMcpServerView,
} from "./native-mcp-runtime.js";
import {
  context,
  createFixtureRuntime,
  options,
  payload,
  processId,
} from "./native-mcp-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeDelayedCallbackPeer(
  file: string,
  endpoint: string,
  callback: "sampling/createMessage" | "elicitation/create",
) {
  await fs.writeFile(
    file,
    `import { appendFileSync } from "node:fs";
${fixtureReceiptClientSource(endpoint)}
const source = ${JSON.stringify(file)};
const method = ${JSON.stringify(callback)};
function record(line) {
  appendFileSync(source + ".log", line + "\\n");
  sendReceipt(source, line);
}
announce(source + ":" + process.pid);
let buffer = "";
let callbackId = 1000;
const pending = new Map();
let completeCallback;
const callbackCompleted = new Promise((resolve) => { completeCallback = resolve; });
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n"); }
function request(params) {
  const id = ++callbackId;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function callbackParams() {
  return method === "sampling/createMessage"
    ? { messages: [{ role: "user", content: { type: "text", text: "Callback from server" } }], maxTokens: 1 }
    : { mode: "form", message: "Callback from server", requestedSchema: { type: "object", properties: { choice: { type: "string" } } } };
}
async function receive(message) {
  if (!message.method) {
    const reply = pending.get(message.id);
    if (!reply) return;
    pending.delete(message.id);
    if (message.error) reply.reject(new Error(message.error.message));
    else reply.resolve(message.result);
    return;
  }
  if (message.method.startsWith("notifications/")) {
    record(message.method);
    return;
  }
  try {
    let result;
    if (message.method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "delayed-callback", version: "1" } };
    } else if (message.method === "tools/list") {
      result = { tools: ["origin", "successor", "probe", "callback"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) };
    } else if (message.method === "tools/call") {
      const name = message.params.name;
      if (name === "origin") {
        record("origin accepted");
        await awaitRelease(source, "late-callback");
        try { await request(callbackParams()); record("origin late callback accepted"); }
        catch (error) { record("origin late callback refused " + error.message); }
        finally { completeCallback(); }
        await awaitRelease(source, "origin-result");
      } else if (name === "successor") {
        record("successor accepted");
        await callbackCompleted;
      } else if (name === "callback") {
        await request(callbackParams());
      }
      result = { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, name }) }] };
    } else {
      send({ id: message.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    send({ id: message.id, result });
  } catch (error) {
    send({ id: message.id, error: { code: -32603, message: error.message } });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line) void receive(JSON.parse(line));
  }
});
`,
  );
}

for (const callback of ["sampling/createMessage", "elicitation/create"] as const) {
  it(`does not attribute A's delayed ${callback} to B after cancellation`, async ({ signal }) => {
    const directory = tempDirs.make("native-mcp-delayed-callback-");
    const file = path.join(directory, "server.mjs");
    const receipts = await openFixtureReceiptChannel();
    await writeDelayedCallbackPeer(file, receipts.endpoint, callback);
    const runtime = createFixtureRuntime(directory, file, "delayed-callback");
    const effects: string[] = [];
    const shared: NativeMcpClientContext = {
      ...context(),
      capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: { form: {} } },
    };
    const caller = (name: string): NativeMcpClientContext => ({
      ...shared,
      createMessage: async () => {
        effects.push(name + ":sampling");
        return { role: "assistant", content: { type: "text", text: name }, model: "fixture" };
      },
      elicit: async () => {
        effects.push(name + ":elicitation");
        return { action: "accept", content: { choice: name } };
      },
    });
    const views: NativeMcpServerView[] = [];
    try {
      const first = await acquireNativeMcpServer(runtime, "fixture", caller("A"));
      views.push(first);
      const secondContext = caller("B");
      const second = await acquireNativeMcpServer(runtime, "fixture", secondContext);
      views.push(second);
      const firstPid = processId(payload(await first.callTool({ name: "probe" }, options(signal))));
      expect(processId(payload(await second.callTool({ name: "probe" }, options(signal))))).toBe(
        firstPid,
      );
      const cancelled = new AbortController();
      const origin = first.callTool({ name: "origin" }, options(cancelled.signal));
      const rejected = expect(origin).rejects.toThrow("cancelled request A");
      await withinTest(receipts.waitFor(file, "origin accepted"), signal);
      cancelled.abort(new Error("cancelled request A"));
      await rejected;
      // Retirement may reject B; A's callback must never execute with B's authority.
      const successor = second.callTool({ name: "successor" }, options(signal)).then(
        () => undefined,
        () => undefined,
      );
      await withinTest(
        Promise.race([receipts.waitFor(file, "successor accepted"), successor]),
        signal,
      );
      receipts.release(file, "late-callback");
      await withinTest(successor, signal);
      expect(effects).toEqual([]);
      await Promise.all([first.release(), second.release()]);
      const fresh = await acquireNativeMcpServer(runtime, "fixture", secondContext);
      try {
        const result = payload(await fresh.callTool({ name: "probe" }, options(signal)));
        expect(result).toMatchObject({ name: "probe" });
        expect(processId(result)).not.toBe(firstPid);
        expect(payload(await fresh.callTool({ name: "callback" }, options(signal)))).toMatchObject({
          name: "callback",
        });
        expect(effects).toEqual([
          callback === "sampling/createMessage" ? "B:sampling" : "B:elicitation",
        ]);
      } finally {
        await fresh.release();
      }
    } finally {
      receipts.release(file, "late-callback");
      receipts.release(file, "origin-result");
      await Promise.all(views.map((view) => view.release()));
      await runtime.dispose();
      assert(runtime.joinCleanup, "Expected fixture runtime cleanup join");
      await runtime.joinCleanup();
      await receipts.close();
    }
  });
}
