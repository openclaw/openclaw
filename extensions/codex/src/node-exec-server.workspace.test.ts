import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodexNodeAppServerCommand,
  createCodexNodeExecServerCommand,
} from "./node-exec-server.js";

const mock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./node-exec-server.runtime.js", () => ({ runCodexNodeExecServer: mock.run }));

beforeEach(() => {
  mock.run.mockReset();
});

it.each(["context", "session", "authorization", "environment", "placement"])(
  "refuses a Codex model process with unapproved %s before borrowing workspace custody",
  async (invalid) => {
    const acquire = vi.fn();
    const authorize = vi.fn(() => () => {});
    const placement = {
      cwd: "/synthetic/workspace",
      environmentId: "environment",
      sessionId: "session",
      ownerEpoch: 1,
      sessionKey: "agent:main:managed",
    };
    const request = {
      placement:
        invalid === "placement" ? { ...placement, IDENTITY_HEADER: "caller-secret" } : placement,
      authorization: invalid === "authorization" ? "human-approved" : "session-full",
      ...(invalid === "environment" ? { env: { IDENTITY_HEADER: "caller-secret" } } : {}),
    };
    const command = createCodexNodeAppServerCommand();
    await expect(
      command.handle(
        JSON.stringify(request),
        {
          signal: new AbortController().signal,
          emitChunk: async () => {},
          onInput: () => {},
          frames: { send: async () => {}, onMessage: () => () => {} },
        },
        invalid === "context"
          ? undefined
          : {
              sessionKey: invalid === "session" ? "agent:main:other" : placement.sessionKey,
              sendNodeEvent: async () => undefined,
              acquireManagedWorkspaceAsync: acquire,
              prepareExecAuthorization: authorize,
            },
      ),
    ).rejects.toThrow();
    expect(acquire).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  },
);

function invocation() {
  const frames = new AbortController();
  const owner = new AbortController();
  const lease = { workspaceDir: "/synthetic/workspace", release: vi.fn() };
  const acquire = vi.fn(async () => lease);
  const io: OpenClawPluginNodeHostCommandIo = {
    signal: frames.signal,
    emitChunk: async () => {},
    onInput: () => {},
    frames: { send: async () => {}, onMessage: () => () => {} },
  };
  const command = createCodexNodeExecServerCommand();
  return {
    frames,
    owner,
    lease,
    acquire,
    start: () =>
      command.handle(
        JSON.stringify({
          placement: {
            cwd: lease.workspaceDir,
            environmentId: "environment",
            sessionId: "session",
            ownerEpoch: 1,
            sessionKey: "agent:main:session",
          },
          authorization: "human-approved",
        }),
        io,
        {
          sessionKey: "agent:main:session",
          signal: owner.signal,
          sendNodeEvent: async () => {},
          acquireManagedWorkspaceAsync: acquire,
          prepareExecAuthorization: () => () => {},
        },
      ),
  };
}

describe("Codex workspace handoff", () => {
  it.each(["frames", "owner"] as const)(
    "releases late acquisition after %s cancellation",
    async (scope) => {
      const fixture = invocation();
      const entered = Promise.withResolvers<void>();
      const acquired = Promise.withResolvers<typeof fixture.lease>();
      fixture.acquire.mockImplementation(() => {
        entered.resolve();
        return acquired.promise;
      });
      const pending = fixture.start();
      const failure = new Error("synthetic workspace scope closed");
      const rejected = expect(pending).rejects.toBe(failure);
      await entered.promise;
      fixture[scope].abort(failure);
      acquired.resolve(fixture.lease);
      await rejected;
      expect(fixture.lease.release).toHaveBeenCalledOnce();
      expect(mock.run).not.toHaveBeenCalled();
    },
  );

  it("keeps invocation cancellation attached after workspace handoff", async () => {
    const fixture = invocation();
    const entered = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<string>();
    const stopped = vi.fn();
    mock.run.mockImplementation(
      async (params: { io: OpenClawPluginNodeHostCommandIo; workspace: typeof fixture.lease }) => {
        params.io.signal.addEventListener("abort", stopped);
        entered.resolve();
        try {
          return await finished.promise;
        } finally {
          params.io.signal.removeEventListener("abort", stopped);
          params.workspace.release();
        }
      },
    );
    const pending = fixture.start();
    try {
      await Promise.race([entered.promise, pending]);
      fixture.owner.abort(new Error("synthetic invocation completed"));
      expect(stopped).toHaveBeenCalledOnce();
      expect(fixture.frames.signal.aborted).toBe(false);
      expect(fixture.lease.release).not.toHaveBeenCalled();
    } finally {
      finished.resolve("closed");
      await pending;
    }
    expect(fixture.lease.release).toHaveBeenCalledOnce();
  });
});
