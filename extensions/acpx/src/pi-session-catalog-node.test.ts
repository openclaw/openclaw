import { expect, it, vi } from "vitest";
import { capturePiCatalog } from "./pi-session-catalog.test-support.js";

const PI_SESSIONS_LIST_COMMAND = "acpx.pi.sessions.list.v1";
const PI_SESSION_READ_COMMAND = "acpx.pi.sessions.read.v1";

it("bridges list and read requests without undefined transport fields", async () => {
  const invoke = vi.fn();
  const respond = (payload: unknown) =>
    invoke.mockResolvedValueOnce({ payloadJSON: JSON.stringify(payload) });
  const session = (threadId: unknown, source?: string) => ({
    threadId,
    status: "stored",
    source,
    archived: false,
    canContinue: false,
    canArchive: false,
  });
  const nodeError = [
    expect.objectContaining({
      error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
    }),
  ];
  respond({ sessions: [session("pi-remote", "pi-cli")] });
  respond({ threadId: "pi-remote", items: [{ type: "agentMessage", text: "remote answer" }] });
  const { provider: catalog } = capturePiCatalog({
    nodes: {
      list: vi.fn().mockResolvedValue({
        nodes: [
          {
            nodeId: "node-1",
            displayName: "Remote",
            connected: true,
            commands: [PI_SESSIONS_LIST_COMMAND, PI_SESSION_READ_COMMAND],
          },
        ],
      }),
      invoke,
    },
  });
  expect(catalog).toBeDefined();
  const list = (cursor?: string) =>
    catalog!.list({
      hostIds: ["node:node-1"],
      ...(cursor === undefined ? {} : { cursors: { "node:node-1": cursor } }),
    });
  const read = (cursor?: string) =>
    catalog!.read({
      hostId: "node:node-1",
      threadId: "pi-remote",
      ...(cursor === undefined ? {} : { cursor }),
    });
  await list();
  await read();

  const transport = {
    nodeId: "node-1",
    timeoutMs: 20_000,
    scopes: ["operator.write"],
  };
  expect(invoke.mock.calls).toEqual([
    [{ ...transport, command: PI_SESSIONS_LIST_COMMAND, params: {} }],
    [{ ...transport, command: PI_SESSION_READ_COMMAND, params: { threadId: "pi-remote" } }],
  ]);

  respond({ sessions: [session(123)] });
  await expect(list()).resolves.toEqual(nodeError);
  respond({ sessions: [session("--help")] });
  await expect(list()).resolves.toEqual(nodeError);
  respond({ threadId: "pi-remote", items: [{ type: "invalid", text: "bad" }] });
  await expect(read()).rejects.toThrow("invalid transcript page");

  invoke.mockClear();
  await expect(read("")).rejects.toThrow("cursor is invalid");
  await expect(list("")).resolves.toEqual(nodeError);
  expect(invoke).not.toHaveBeenCalled();

  respond({ sessions: [], nextCursor: " wrapped " });
  await expect(list()).resolves.toEqual(nodeError);
  respond({ threadId: "pi-remote", items: [], nextCursor: " wrapped " });
  await expect(read()).rejects.toThrow("invalid cursor");

  const exactCursor = Buffer.from(JSON.stringify({ offset: 1 }), "utf8").toString("base64url");
  respond({ sessions: [] });
  await list(exactCursor);
  expect(invoke).toHaveBeenLastCalledWith(
    expect.objectContaining({ params: { cursor: exactCursor } }),
  );
  respond({ threadId: "pi-remote", items: [] });
  await read(exactCursor);
  expect(invoke).toHaveBeenLastCalledWith(
    expect.objectContaining({ params: { threadId: "pi-remote", cursor: exactCursor } }),
  );
});
