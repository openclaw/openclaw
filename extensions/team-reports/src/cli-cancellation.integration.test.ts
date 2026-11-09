import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { once } from "node:events";
import { Command } from "commander";
import { AsyncWorkScope, createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { expect, it, onTestFinished, vi } from "vitest";
import { registerTeamReportsCli } from "./cli.js";

it.each([
  { args: ["status"], method: "status" },
  { args: ["list"], method: "list" },
  { args: ["show", "day", "2026-11-07"], method: "get" },
  { args: ["generate", "--date", "2026-11-07"], method: "generate" },
])("settles interrupted $method according to read/write ownership", async ({ args, method }) => {
  const port = await acquireTestPortBlock({ offsets: [0] });
  onTestFinished(() => port.release());
  const server = new WebSocketServer({ host: "127.0.0.1", port: port.port });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) {
    throw new Error("Expected a loopback TCP listener");
  }
  const received = createDeferred<() => void>();
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "fictional-nonce", ts: Date.now() },
      }),
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(rawDataToString(raw)) as {
        id: string;
        method: string;
        params: { maxProtocol: number; scopes: string[] };
      };
      const reply = (payload: unknown) =>
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
      if (frame.method === "connect") {
        reply({
          type: "hello-ok",
          protocol: frame.params.maxProtocol,
          auth: { scopes: frame.params.scopes },
          policy: { maxPayload: 1_048_576, tickIntervalMs: 30_000 },
        });
      } else if (frame.method === `team-reports.${method}`) {
        received.resolve(() => reply({ runId: "fictional-run" }));
      }
    });
  });
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const scope = new AsyncWorkScope();
  const program = new Command().exitOverride();
  registerTeamReportsCli({ program });
  const command = scope.track(() =>
    program.parseAsync([
      "node",
      "openclaw",
      "team-reports",
      ...args,
      "--json",
      "--url",
      `ws://127.0.0.1:${address.port}`,
      "--token",
      "fictional-token",
      "--timeout",
      "2000",
    ]),
  );
  let outcome = "pending";
  const settled = command.then(
    () => {
      outcome = "completed";
    },
    (error: unknown) => {
      outcome = error instanceof Error && error.name === "AbortError" ? "aborted" : String(error);
    },
  );
  try {
    const reply = await Promise.race([
      received.promise,
      command.then(() => {
        throw new Error("CLI returned before its RPC arrived");
      }),
    ]);
    scope.beginClose(new DOMException("CLI stopping (SIGINT)", "AbortError"));
    if (method === "generate") {
      // A submitted mutation still owns its receipt after interruption.
      reply();
      await settled;
      expect(outcome).toBe("completed");
      expect(output).toHaveBeenCalledWith(expect.stringContaining("fictional-run"));
    } else {
      await settled;
      expect(outcome).toBe("aborted");
      expect(output).not.toHaveBeenCalled();
    }
  } finally {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await settled;
    await scope.drain();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    output.mockRestore();
  }
});
