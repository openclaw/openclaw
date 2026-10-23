import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { promisify } from "node:util";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";

type Request = { id: number; method: string; params: Record<string, unknown> };

/** A loopback CLI protocol peer; the client, session, and tool dispatch are the real SDK. */
export async function createCopilotFaultPeer() {
  const sent = createDeferred<void>();
  const detaching = createDeferred<void>();
  const releaseDetach = createDeferred<void>();
  const replies = new Map<string, ReturnType<typeof createDeferred<Record<string, unknown>>>>();
  const sockets = new Set<Socket>();
  let socket: Socket;
  let sessionId: string;
  let previousEventId: string | null = null;
  const send = (value: Record<string, unknown>) => {
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...value }));
    socket.write(`Content-Length: ${bytes.length}\r\n\r\n`);
    socket.write(bytes);
  };
  const emit = (type: string, data: Record<string, unknown>) => {
    const timestamp = new Date().toISOString();
    const event = { id: randomUUID(), parentId: previousEventId, timestamp, type, data };
    send({ method: "session.event", params: { sessionId, event } });
    previousEventId = event.id;
  };
  const handle = async (request: Request) => {
    switch (request.method) {
      case "connect":
        return { protocolVersion: 3 };
      case "session.create":
        sessionId = String(request.params.sessionId);
        return { sessionId };
      case "session.send":
        emit("user.message", { content: request.params.prompt });
        sent.resolve();
        return { messageId: "fixture-user" };
      case "session.tools.handlePendingToolCall":
        replies.get(String(request.params.requestId))?.resolve(request.params);
        return {};
      case "session.abort":
        return {};
      case "session.detach":
        detaching.resolve();
        await releaseDetach.promise;
        return { success: true };
      default:
        throw new Error(`Unexpected Copilot fixture RPC: ${request.method}`);
    }
  };
  const server = createServer((connected) => {
    socket = connected;
    sockets.add(connected);
    connected.on("close", () => sockets.delete(connected));
    let buffer = Buffer.alloc(0);
    connected.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (true) {
        const separator = buffer.indexOf("\r\n\r\n");
        if (separator < 0) {
          return;
        }
        const header = buffer.subarray(0, separator).toString();
        const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
        if (buffer.length < separator + 4 + length) {
          return;
        }
        const end = separator + 4 + length;
        const request = JSON.parse(buffer.subarray(separator + 4, end).toString()) as Request;
        buffer = buffer.subarray(end);
        void handle(request).then(
          (result) => send({ id: request.id, result }),
          (error: unknown) =>
            send({
              id: request.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
      }
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback TCP listener");
  }
  const client = new CopilotClient({
    connection: RuntimeConnection.forUri(`127.0.0.1:${address.port}`),
  });
  return {
    client,
    sent: sent.promise,
    detaching: detaching.promise,
    releaseDetach: () => releaseDetach.resolve(),
    emit,
    requestTool(name: string, args: Record<string, unknown>) {
      const requestId = randomUUID();
      const reply = createDeferred<Record<string, unknown>>();
      replies.set(requestId, reply);
      const tool = { toolCallId: requestId, toolName: name, arguments: args };
      emit("external_tool.requested", { requestId, ...tool });
      return reply.promise;
    },
    async close() {
      releaseDetach.resolve();
      await client.stop();
      for (const connected of sockets) {
        connected.destroy();
      }
      await promisify(server.close.bind(server))();
    },
  };
}
