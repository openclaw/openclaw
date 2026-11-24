import { expect, it, vi } from "vitest";
import { listenSignalServer, signalJsonServer } from "./signal-rpc.test-support.js";

const senderLoaded = vi.hoisted(() => vi.fn());
// Observe module evaluation without replacing the sender or its transport.
vi.mock("./send.js", async (importOriginal) => {
  senderLoaded();
  return importOriginal();
});

it("keeps discovery cold and loads the real sender for an edit", async () => {
  const requests: unknown[] = [];
  await using server = signalJsonServer((payload, _request, response) => {
    requests.push(payload);
    response.end(JSON.stringify({ timestamp: 1700000000999 }));
  });
  const cfg = await listenSignalServer(server, "container");
  const { signalPlugin } = await import("./channel.js");
  expect(signalPlugin.actions?.describeMessageTool?.({ cfg })?.actions).toContain("edit");
  expect(senderLoaded).not.toHaveBeenCalled();
  const result = await signalPlugin.actions?.handleAction?.({
    channel: "signal",
    action: "edit",
    cfg,
    params: { to: "+15559999999", messageId: "1700000000123", text: "Updated status" },
  });
  expect(senderLoaded).toHaveBeenCalledOnce();
  expect(result?.details).toEqual({
    ok: true,
    edited: "1700000000123",
    messageId: "1700000000999",
  });
  expect(requests).toEqual([
    expect.objectContaining({
      recipients: ["+15559999999"],
      message: "Updated status",
      edit_timestamp: 1700000000123,
    }),
  ]);
});
