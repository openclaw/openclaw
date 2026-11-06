import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { listAllMcpTools, listMcpServerItems } from "./mcp-catalog-listing.js";

afterEach(() => vi.useRealTimers());

async function fixture() {
  const client = new Client(
    { name: "catalog-test", version: "1" },
    { capabilities: {}, versionNegotiation: { mode: "legacy" } },
  );
  const server = new Server(
    { name: "catalog-test", version: "1" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const [outbound, inbound] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(outbound), server.connect(inbound)]);
  return {
    server,
    transport: inbound,
    list(
      kind: "tools" | "resources" | "prompts",
      timeoutMs = 1_000,
      signal = new AbortController().signal,
    ) {
      return kind === "tools"
        ? listAllMcpTools(client, timeoutMs, signal)
        : listMcpServerItems(kind, {
            client,
            timeoutMs,
            signal: new AbortController().signal,
            callerSignal: signal,
            runRequest: (request, requestSignal) => request(requestSignal),
          });
    },
    [Symbol.asyncDispose]: async () => {
      await client.close();
      await server.close();
    },
  };
}

it("preserves ordered tools and an empty opaque cursor", async () => {
  await using catalog = await fixture();
  const cursors: Array<string | undefined> = [];
  catalog.server.setRequestHandler("tools/list", async ({ params }) => {
    cursors.push(params?.cursor);
    return {
      tools: [
        {
          name: params?.cursor === undefined ? "one" : "two",
          inputSchema: { type: "object" },
        },
      ],
      ...(params?.cursor === undefined ? { nextCursor: "" } : {}),
    };
  });
  expect((await catalog.list("tools")).map((item) => item.name)).toEqual(["one", "two"]);
  expect(cursors).toEqual([undefined, ""]);
});

it("rejects repeated and cyclic cursors", async () => {
  await using catalog = await fixture();
  catalog.server.setRequestHandler("tools/list", async ({ params }) => ({
    tools: [],
    nextCursor: params?.cursor === undefined ? "a" : params.cursor === "a" ? "b" : "a",
  }));
  await expect(catalog.list("tools")).rejects.toThrow("repeated pagination cursor");
});

it.each(["tools", "resources", "prompts"] as const)(
  "rejects malformed %s entries at the SDK boundary",
  async (kind) => {
    await using catalog = await fixture();
    catalog.server.setRequestHandler("tools/list", async () => ({ tools: [] }));
    catalog.server.setRequestHandler("resources/list", async () => ({ resources: [] }));
    catalog.server.setRequestHandler("prompts/list", async () => ({ prompts: [] }));
    const send = catalog.transport.send.bind(catalog.transport);
    catalog.transport.send = (message, options) =>
      send(
        "result" in message ? { ...message, result: { [kind]: [undefined] } } : message,
        options,
      );
    await expect(catalog.list(kind)).rejects.toThrow(`Invalid result for ${kind}/list`);
  },
);

it("enforces page, item, and aggregate byte bounds through the SDK", async () => {
  await using catalog = await fixture();
  vi.useFakeTimers();
  let pages = 0;
  catalog.server.setRequestHandler("tools/list", async () => ({
    tools: [],
    nextCursor: String(++pages),
  }));
  await expect(catalog.list("tools")).rejects.toThrow("exceeded 128 pages");
  expect(pages).toBe(128);
  catalog.server.setRequestHandler("resources/list", async () => ({
    resources: Array.from({ length: 16_385 }, (_, i) => ({
      name: String(i),
      uri: `test:///${i}`,
    })),
  }));
  await expect(catalog.list("resources")).rejects.toThrow("exceeded 16384 resources");
  let promptPages = 0;
  catalog.server.setRequestHandler("prompts/list", async () => ({
    prompts: [{ name: "large", description: "x".repeat(6 * 1024 * 1024) }],
    ...(promptPages++ === 0 ? { nextCursor: "next" } : {}),
  }));
  await expect(catalog.list("prompts")).rejects.toThrow("exceeded 10485760 bytes");
  expect(promptPages).toBe(2);
});

it("uses one absolute deadline across SDK requests", async () => {
  await using catalog = await fixture();
  vi.useFakeTimers();
  let pages = 0;
  catalog.server.setRequestHandler("tools/list", async () => {
    pages++;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    return { tools: [], nextCursor: String(pages) };
  });
  const rejected = expect(catalog.list("tools", 50)).rejects.toThrow(
    "MCP tool listing timed out after 50ms",
  );
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(pages).toBe(2);
  await vi.advanceTimersByTimeAsync(10);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the canonical deadline ahead of the nested SDK timeout", async () => {
  await using catalog = await fixture();
  const release = createDeferred();
  catalog.server.setRequestHandler("resources/list", async () => {
    await release.promise;
    return { resources: [] };
  });
  vi.useFakeTimers();
  try {
    const rejected = expect(catalog.list("resources", 50)).rejects.toThrow(
      "MCP resource listing timed out after 50ms",
    );
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
  } finally {
    release.resolve();
  }
});

it("does not treat a forward wall-clock jump as elapsed time", async () => {
  await using catalog = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  let page = 0;
  catalog.server.setRequestHandler("tools/list", async () => {
    vi.setSystemTime(61_000);
    return {
      tools: [{ name: `tool-${++page}`, inputSchema: { type: "object" } }],
      ...(page < 3 ? { nextCursor: String(page) } : {}),
    };
  });
  expect((await catalog.list("tools", 50)).map((item) => item.name)).toEqual([
    "tool-1",
    "tool-2",
    "tool-3",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects caller abort before a server returns its page", async () => {
  await using catalog = await fixture();
  const controller = new AbortController();
  catalog.server.setRequestHandler("prompts/list", async () => {
    controller.abort("runtime disposed");
    return { prompts: [{ name: "must-not-return" }] };
  });
  await expect(catalog.list("prompts", 1_000, controller.signal)).rejects.toThrow(
    "MCP prompt listing aborted",
  );
});

it("aborts an in-flight page through its caller signal", async () => {
  await using catalog = await fixture();
  const controller = new AbortController();
  const entered = createDeferred();
  const release = createDeferred();
  catalog.server.setRequestHandler("prompts/list", async () => {
    entered.resolve();
    await release.promise;
    return { prompts: [] };
  });
  const listing = catalog.list("prompts", 1_000, controller.signal);
  try {
    await entered.promise;
    const rejected = expect(listing).rejects.toThrow("runtime disposed");
    controller.abort(new Error("runtime disposed"));
    await rejected;
  } finally {
    release.resolve();
  }
});
