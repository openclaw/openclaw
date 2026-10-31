import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

type InviteHandler = (roomId: string, inviteEvent: unknown) => void;
type RunTask = Parameters<typeof registerMatrixAutoJoin>[0]["runDetachedTask"];
const aliasConfig: MatrixConfig = {
  autoJoin: "allowlist",
  autoJoinAllowlist: ["#allowed:example.org"],
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const taskRunner = () => createMatrixMonitorTaskRunner({ logger, logVerboseMessage: vi.fn() });

async function flushInviteTasks() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function setup(accountConfig: MatrixConfig = {}, runner?: RunTask) {
  let listener: InviteHandler | null = null;
  const mocks = {
    on: vi.fn((event: string, handler: unknown) => {
      if (event === "room.invite") {
        listener = handler as InviteHandler;
      }
      return client;
    }),
    off: vi.fn((event: string, handler: unknown) => {
      if (event === "room.invite" && listener === handler) {
        listener = null;
      }
      return client;
    }),
    joinRoom: vi.fn(async () => {}),
    resolveRoom: vi.fn<MatrixClient["resolveRoom"]>(async () => null),
  };
  const client: MatrixClient = mocks as unknown as MatrixClient;
  const error = vi.fn();
  const runDetachedTask = vi.fn<RunTask>((_label, task) => Promise.resolve().then(task));
  const register = (run: RunTask = runDetachedTask) =>
    registerMatrixAutoJoin({
      client,
      accountConfig,
      runtime: { log: vi.fn(), error } as unknown as RuntimeEnv,
      runDetachedTask: run,
    });
  return {
    ...mocks,
    error,
    runDetachedTask,
    register,
    dispose: register(runner),
    getListener: () => listener,
    invite: async (event: unknown = {}) => {
      if (!listener) {
        throw new Error("expected Matrix invite handler");
      }
      listener("!room:example.org", event);
      await flushInviteTasks();
    },
  };
}

describe("registerMatrixAutoJoin", () => {
  beforeEach(() => {
    logger.warn.mockReset();
    setMatrixRuntime({
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () => logger,
      },
    } as unknown as PluginRuntime);
  });

  it("does not auto-join invites by default", () => {
    const f = setup();
    expect(f.getListener()).toBeNull();
    expect(f.joinRoom).not.toHaveBeenCalled();
  });

  it("retries alias resolution after an unresolved lookup", async () => {
    const f = setup(aliasConfig);
    f.resolveRoom.mockResolvedValueOnce(null).mockResolvedValueOnce("!room:example.org");
    await f.invite();
    await f.invite();
    expect(f.resolveRoom).toHaveBeenCalledTimes(2);
    expect(f.joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not join when the originating monitor retires during alias lookup", async () => {
    vi.useFakeTimers();
    const retired = taskRunner();
    const active = taskRunner();
    const f = setup(aliasConfig, retired.runDetachedTask);
    const lookup = createDeferred<string>();
    f.resolveRoom.mockReturnValue(lookup.promise);
    await f.invite();
    expect(f.resolveRoom).toHaveBeenCalled();
    const idle = retired.waitForIdle();
    await vi.advanceTimersByTimeAsync(30_000);
    await idle;
    lookup.resolve("!room:example.org");
    await flushInviteTasks();
    expect(f.joinRoom).not.toHaveBeenCalled();
    f.resolveRoom.mockResolvedValue("!room:example.org");
    f.register(active.runDetachedTask);
    await f.invite();
    expect(f.joinRoom).toHaveBeenCalledWith("!room:example.org");
    retired.close();
    active.close();
    vi.useRealTimers();
  });

  it("logs and skips allowlist alias resolution failures", async () => {
    const f = setup(aliasConfig);
    f.resolveRoom.mockRejectedValue(new Error("temporary homeserver failure"));
    await f.invite();
    expect(f.joinRoom).not.toHaveBeenCalled();
    expect(f.error).toHaveBeenCalledWith(
      "matrix: failed resolving allowlisted alias #allowed:example.org: Error: temporary homeserver failure",
    );
  });

  it("does not trust room-provided alias claims for allowlist joins", async () => {
    const f = setup(aliasConfig);
    f.resolveRoom.mockResolvedValue("!different-room:example.org");
    await f.invite();
    expect(f.joinRoom).not.toHaveBeenCalled();
  });

  it("removes the exact invite listener on disposal", () => {
    const f = setup({ autoJoin: "always" });
    const listener = f.getListener();
    expect(listener).not.toBeNull();
    f.dispose();
    expect(f.off).toHaveBeenCalledWith("room.invite", listener);
    expect(f.getListener()).toBeNull();
    expect(f.runDetachedTask).not.toHaveBeenCalled();
    expect(f.joinRoom).not.toHaveBeenCalled();
  });

  it("does not warn for room, alias, or wildcard allowlist entries", () => {
    setup({
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!room:example.org", "#alias:example.org", "*"],
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ignores an unmatchable user-ID allowlist entry without joining", async () => {
    const f = setup({ autoJoin: "allowlist", autoJoinAllowlist: ["@ryan:example.org"] });
    await f.invite({ sender: "@ryan:example.org" });
    expect(f.joinRoom).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: autoJoinAllowlist entries cannot match an invited room and are ignored: @ryan:example.org",
    );
  });
});
