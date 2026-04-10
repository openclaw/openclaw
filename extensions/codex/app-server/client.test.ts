import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  listCodexAppServerModels,
  MIN_CODEX_APP_SERVER_VERSION,
  readCodexVersionFromUserAgent,
  resetSharedCodexAppServerClientForTests,
} from "./client.js";

function createClientHarness() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(() => {
      process.killed = true;
    }),
  });
  // fromTransportForTests speaks the same newline-delimited JSON-RPC as the
  // spawned app-server, but keeps the process lifecycle fully observable.
  const client = CodexAppServerClient.fromTransportForTests(process);
  return {
    client,
    process,
    writes,
    send(message: unknown) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}

describe("CodexAppServerClient", () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
  });

  it("routes request responses by id", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const request = harness.client.request("model/list", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number; method?: string };
    harness.send({ id: outbound.id, result: { models: [] } });

    await expect(request).resolves.toEqual({ models: [] });
    expect(outbound.method).toBe("model/list");
  });

  it("initializes with the required client version", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const initializing = harness.client.initialize();
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as {
      id?: number;
      method?: string;
      params?: { clientInfo?: { name?: string; title?: string; version?: string } };
    };
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.118.0 (macOS; test)" },
    });

    await expect(initializing).resolves.toBeUndefined();
    expect(outbound).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: {
          name: "openclaw",
          title: "OpenClaw",
          version: expect.any(String),
        },
      },
    });
    expect(outbound.params?.clientInfo?.version).not.toBe("");
    expect(JSON.parse(harness.writes[1] ?? "{}")).toEqual({ method: "initialized" });
  });

  it("blocks unsupported app-server versions during initialize", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const initializing = harness.client.initialize();
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.117.9 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected 0.117.9`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks app-server initialize responses without a version", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const initializing = harness.client.initialize();
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({ id: outbound.id, result: {} });

    await expect(initializing).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("closes the shared app-server when the version gate fails", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    // Model discovery goes through the shared-client startup path, where a
    // failed version gate must also tear down the child process.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.117.9 (macOS; test)" },
    });

    await expect(listPromise).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.process.kill).toHaveBeenCalledTimes(1);
    startSpy.mockRestore();
  });

  it("reads the Codex version from the app-server user agent", () => {
    expect(readCodexVersionFromUserAgent("openclaw/0.118.0 (macOS; test)")).toBe("0.118.0");
    expect(readCodexVersionFromUserAgent("codex_cli_rs/0.118.1-dev (linux; test)")).toBe(
      "0.118.1-dev",
    );
    expect(readCodexVersionFromUserAgent("missing-version")).toBeUndefined();
  });

  it("answers server-initiated requests with the registered handler result", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    harness.client.addRequestHandler((request) => {
      if (request.method === "item/tool/call") {
        return { contentItems: [{ type: "inputText", text: "ok" }], success: true };
      }
      return undefined;
    });

    harness.send({ id: "srv-1", method: "item/tool/call", params: { tool: "message" } });
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "srv-1",
      result: { contentItems: [{ type: "inputText", text: "ok" }], success: true },
    });
  });

  it("fails closed for unhandled native app-server approvals", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    harness.send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", command: "pnpm test" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
  });

  it("lists app-server models through the typed helper", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({ limit: 12, timeoutMs: 1000 });
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.118.0 (macOS; test)" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
    const list = JSON.parse(harness.writes[2] ?? "{}") as { id?: number; method?: string };
    expect(list.method).toBe("model/list");

    harness.send({
      id: list.id,
      result: {
        data: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "gpt-5.4",
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "xhigh", description: "deep" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    });

    await expect(listPromise).resolves.toEqual({
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "gpt-5.4",
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: ["low", "xhigh"],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    });
    startSpy.mockRestore();
  });
});
