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
import { acquireNativeMcpServer, type NativeMcpServerView } from "./native-mcp-runtime.js";
import { createFixtureRuntime, options } from "./native-mcp-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(era: "legacy" | "modern") {
  const directory = tempDirs.make("native-mcp-output-");
  const file = path.join(directory, "server.mjs");
  const receipts = await openFixtureReceiptChannel();
  await fs.writeFile(
    file,
    `import readline from "node:readline";
${fixtureReceiptClientSource(receipts.endpoint)}
const source = ${JSON.stringify(file)};
announce(source);
let valueType = "number";
let notify;
const list = () => ({ tools: [
  { name: "value", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { count: { type: valueType } }, required: ["count"] } },
  { name: "change-schema", inputSchema: { type: "object" } }
] });
async function call(params, inputResponses) {
  if (params.name === "change-schema") {
    valueType = "string";
    await notify();
    return { content: [] };
  }
  if (params.arguments?.hold) {
    sendReceipt(source, "held");
    await awaitRelease(source, "finish");
  }
  if (params.arguments?.continue && !inputResponses) {
    return { resultType: "input_required", requestState: "value-state", inputRequests: { roots: { method: "roots/list" } } };
  }
  return { content: [], structuredContent: { count: params.arguments?.count } };
}
if (${JSON.stringify(era)} === "modern") {
  const { Server } = await import(${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))});
  const { serveStdio } = await import(${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))});
  serveStdio(() => {
    const server = new Server({ name: "output-fixture", version: "1" }, { capabilities: { tools: { listChanged: true } } });
    notify = () => server.sendToolListChanged();
    server.setRequestHandler("tools/list", list);
    server.setRequestHandler("tools/call", (request, ctx) => call(request.params, ctx.mcpReq.inputResponses));
    return server;
  }, { legacy: "reject" });
} else {
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
  notify = async () => send({ method: "notifications/tools/list_changed" });
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "output-fixture", version: "1" } };
    else if (request.method === "tools/list") result = list();
    else if (request.method === "tools/call") result = await call(request.params);
    else { send({ id: request.id, error: { code: -32601, message: "Method not found" } }); return; }
    send({ id: request.id, result });
  });
}
`,
  );
  const runtime = createFixtureRuntime(directory, file, "output");
  const context = {
    capabilityContext: {},
    capabilities: { roots: {} },
    roots: { roots: [] },
    assertCurrent() {},
  };
  const views: NativeMcpServerView[] = [];
  const acquire = async () => {
    const view = await acquireNativeMcpServer(runtime, "fixture", context);
    views.push(view);
    return view;
  };
  return {
    file,
    receipts,
    acquire,
    async close() {
      try {
        await Promise.all(views.map((view) => view.release()));
        await runtime.dispose();
        assert(runtime.joinCleanup);
        await runtime.joinCleanup();
      } finally {
        await receipts.close();
      }
    },
  };
}

async function changeSchema(view: NativeMcpServerView, signal: AbortSignal) {
  const invalidated = new Promise<void>((resolve) => {
    const unsubscribe = view.subscribe((event) => {
      if (
        event.kind === "invalidated" ||
        (event.kind === "notification" &&
          event.notification.method === "notifications/tools/list_changed")
      ) {
        unsubscribe();
        resolve();
      }
    });
  });
  await view.callTool({ name: "change-schema" }, options(signal));
  await withinTest(invalidated, signal);
}

it.for(["legacy", "modern"] as const)(
  "validates completed %s tool results against their output schema",
  async (era, { signal }) => {
    const peer = await fixture(era);
    try {
      const view = await peer.acquire();
      await expect(
        view.callTool({ name: "value", arguments: { count: "oops" } }, options(signal)),
      ).rejects.toThrow("does not match the tool's output schema");
      expect(
        await view.callTool({ name: "value", arguments: { count: 7 } }, options(signal)),
      ).toMatchObject({
        kind: "complete",
        result: { content: [], structuredContent: { count: 7 } },
      });
    } finally {
      await peer.close();
    }
  },
);

it.for(["legacy", "modern"] as const)(
  "retains the admitted %s output schema across catalog refresh",
  async (era, { signal }) => {
    const peer = await fixture(era);
    try {
      const view = await peer.acquire();
      const pending = view.callTool(
        { name: "value", arguments: { count: 7, hold: true } },
        options(signal),
      );
      void pending.catch(() => {});
      try {
        await withinTest(peer.receipts.waitFor(peer.file, "held"), signal);
        await changeSchema(view, signal);
        const next = await peer.acquire();
        expect(
          (await next.listTools(undefined, options(signal))).tools[0]?.outputSchema,
        ).toMatchObject({
          properties: { count: { type: "string" } },
        });
        peer.receipts.release(peer.file, "finish");
        expect(await pending).toMatchObject({
          kind: "complete",
          result: { structuredContent: { count: 7 } },
        });
        await expect(
          next.callTool({ name: "value", arguments: { count: 7 } }, options(signal)),
        ).rejects.toThrow("does not match the tool's output schema");
      } finally {
        peer.receipts.release(peer.file, "finish");
        await pending.catch(() => {});
      }
    } finally {
      await peer.close();
    }
  },
);

it("validates resumed results with the continuation's original output schema", async ({
  signal,
}) => {
  const peer = await fixture("modern");
  try {
    const view = await peer.acquire();
    const pending = await view.callTool(
      { name: "value", arguments: { count: 7, continue: true } },
      options(signal),
    );
    assert(pending.kind === "input-required");
    await changeSchema(view, signal);
    const next = await peer.acquire();
    expect(await pending.resume({ roots: { roots: [] } }, options(signal))).toMatchObject({
      kind: "complete",
      result: { structuredContent: { count: 7 } },
    });
    const invalid = await next.callTool(
      { name: "value", arguments: { count: 7, continue: true } },
      options(signal),
    );
    assert(invalid.kind === "input-required");
    await expect(invalid.resume({ roots: { roots: [] } }, options(signal))).rejects.toThrow(
      "does not match the tool's output schema",
    );
  } finally {
    await peer.close();
  }
});
