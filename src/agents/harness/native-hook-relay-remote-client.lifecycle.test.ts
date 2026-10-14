import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { invokeRemoteNativeHookRelay } from "./native-hook-relay-remote-client.js";

const boundary = vi.hoisted(() => ({ request: vi.fn() }));
// mock-isolation: Supply credential bytes without reading operator files.
vi.mock("node:fs/promises", () => ({
  open: async () => ({
    stat: async () => ({ isFile: () => true, size: 96 }),
    read: async (buffer: Buffer) => ({
      bytesRead: buffer.write(
        JSON.stringify({
          url: "https://relay.example/__openclaw__/native-hook/relay",
          token: "synthetic-relay-capability",
        }),
      ),
    }),
    close: async () => {},
  }),
}));
// mock-isolation: Control native request error and physical-close events independently.
vi.mock("node:https", () => ({ request: boundary.request }));

it.each(["response", "error"] as const)("joins the socket after %s delivery", async (mode) => {
  const entered = createDeferred();
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  const request = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    end: vi.fn(() => entered.resolve()),
  });
  let deliver: ((incoming: typeof response) => void) | undefined;
  boundary.request.mockImplementation((_url, options, callback) => {
    expect(options.agent).toBe(false);
    deliver = callback;
    return request;
  });
  const operation = invokeRemoteNativeHookRelay(
    "credential-fixture",
    {
      provider: "codex",
      relayId: "relay",
      event: "pre_tool_use",
      rawPayload: {},
    },
    new AbortController().signal,
  );
  let completed = false;
  const result = operation.then(
    (value) => {
      completed = true;
      return { value };
    },
    (error: unknown) => {
      completed = true;
      return { error };
    },
  );
  await entered.promise;
  if (mode === "response") {
    deliver?.(response);
    response.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: true,
          result: {
            stdout: "allow",
            stderr: "",
            exitCode: 0,
          },
        }),
      ),
    );
    response.emit("end");
  } else {
    request.emit("error", new Error("private transport detail"));
    expect(request.destroy).toHaveBeenCalledOnce();
  }
  await Promise.resolve();
  expect(completed).toBe(false);
  request.emit("close");
  expect(await result).toEqual(
    mode === "response"
      ? { value: { stdout: "allow", stderr: "", exitCode: 0 } }
      : { error: new Error("Native hook callback connection failed") },
  );
});
