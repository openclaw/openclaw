import { expect, it, vi, type Mock } from "vitest";
import type { spawnAcpDirect as SpawnAcpDirect } from "./acp-spawn.js";

type SpawnResult = Awaited<ReturnType<typeof SpawnAcpDirect>>;
type GatewayRequest = Parameters<typeof import("./subagent-spawn.runtime.js").callGateway>[0];

/** Uses the existing ACP suite's backend, Gateway and registration fixtures. */
export function registerAcpDispatchAcceptanceTests({
  spawnAcpDirect,
  mocks: hoisted,
  expectAcceptedSpawn,
  expectFailedSpawn,
}: {
  spawnAcpDirect: typeof SpawnAcpDirect;
  mocks: {
    callGatewayMock: Mock;
    registerSubagentRunMock: Mock;
    cleanupFailedAcpSpawnMock: Mock;
  };
  expectAcceptedSpawn: (result: SpawnResult) => Extract<SpawnResult, { status: "accepted" }>;
  expectFailedSpawn: (
    result: SpawnResult,
    status?: "error" | "forbidden",
  ) => Exclude<SpawnResult, { status: "accepted" }>;
}) {
  it("reconciles a transport-ambiguous ACP dispatch so an accepted run is surfaced instead of misreported as dispatch_failed", async () => {
    let agentDispatchAttempts = 0;
    // A plain Error whose message matches isGatewayRpcUnavailableError (the gateway
    // timeout transport shape) models "the gateway may have accepted the ACP run
    // before the ack was lost" - distinct from a genuine dispatch rejection. The
    // reconcile lives on the shared subagent gateway seam, so the ACP launch (which
    // replays with the same childIdem idempotency key) surfaces the accepted run.
    hoisted.callGatewayMock.mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as { method?: string };
      if (args.method === "agent") {
        agentDispatchAttempts += 1;
        if (agentDispatchAttempts === 1) {
          throw new Error("gateway timeout after 60000ms");
        }
        return { runId: "accepted-acp-run", status: "in_flight" };
      }
      if (args.method === "sessions.patch") {
        return { ok: true };
      }
      return args.method === "sessions.delete" ? { ok: true } : {};
    });

    const result = await spawnAcpDirect(
      {
        task: "ambiguous ACP child",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
        agentThreadId: "requester-thread",
      },
    );

    // The reconcile replay reuses the same childIdem idempotency key; the gateway
    // surfaces the already-accepted run, so the caller must not conclude the ACP
    // child never started.
    expect(agentDispatchAttempts).toBe(2);
    const accepted = expectAcceptedSpawn(result);
    expect(accepted.runId).toBe("accepted-acp-run");
    expect(accepted.childSessionKey).toMatch(/^agent:codex:acp:/);
  });

  it("does not register an ACP child when reconciliation finds a terminal run", async () => {
    let agentDispatchAttempts = 0;
    hoisted.callGatewayMock.mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as { method?: string };
      if (args.method === "agent" && ++agentDispatchAttempts === 1) {
        throw new Error("gateway timeout after 60000ms");
      }
      return args.method === "agent"
        ? { runId: "stopped-acp-run", status: "timeout" }
        : { ok: true };
    });

    const result = await spawnAcpDirect(
      { task: "ambiguous ACP child", agentId: "codex", mode: "run" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(agentDispatchAttempts).toBe(2);
    expect(expectFailedSpawn(result).error).toContain("no active subagent run (status: timeout)");
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it.each(["accepted", "in_flight"] as const)(
    "keeps an ACP child independent after Gateway %s and source completion",
    async (status) => {
      let sourceActive = true;
      const assertActive = vi.fn(() => {
        if (!sourceActive) {
          throw new Error("ACP source finished");
        }
      });
      hoisted.callGatewayMock.mockImplementation(async (request: GatewayRequest) => {
        if (request.method !== "agent") {
          return { ok: true };
        }
        expect(request.assertDispatchCurrent).toBeTypeOf("function");
        request.assertDispatchCurrent?.();
        sourceActive = false;
        return { status, runId: "accepted-independent-acp" };
      });
      hoisted.registerSubagentRunMock.mockImplementationOnce(
        (_registration: unknown, options?: { assertCurrent?: () => void }) => {
          options?.assertCurrent?.();
        },
      );

      const result = await spawnAcpDirect(
        { task: "Finish the independent assessment", agentId: "codex", mode: "run" },
        { agentSessionKey: "agent:main:main", assertActive },
      );

      expect(sourceActive).toBe(false);
      expect(expectAcceptedSpawn(result).runId).toBe("accepted-independent-acp");
      expect(hoisted.registerSubagentRunMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ runId: "accepted-independent-acp" }),
        expect.any(Object),
      );
      expect(hoisted.cleanupFailedAcpSpawnMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an ACP source that expires at the Gateway's final dispatch boundary", async () => {
    let sourceActive = true;
    const assertActive = () => {
      if (!sourceActive) {
        throw new Error("ACP source expired before acceptance");
      }
    };
    hoisted.callGatewayMock.mockImplementation(async (request: GatewayRequest) => {
      if (request.method !== "agent") {
        return { ok: true };
      }
      expect(request.assertDispatchCurrent).toBeTypeOf("function");
      sourceActive = false;
      request.assertDispatchCurrent?.();
      throw new Error("Retired source crossed dispatch boundary");
    });

    const result = await spawnAcpDirect(
      { task: "Do not start this assessment", agentId: "codex", mode: "run" },
      { agentSessionKey: "agent:main:main", assertActive },
    );

    expect(expectFailedSpawn(result, "error")).toMatchObject({
      errorCode: "dispatch_failed",
      error: expect.stringContaining("ACP source expired before acceptance"),
    });
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.cleanupFailedAcpSpawnMock).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "error", receipt: { runId: "rejected-acp", status: "error" } },
    {
      name: "provisional",
      receipt: { runId: "pending-acp", status: "in_flight", admissionPending: true },
    },
    { name: "missing run identity", receipt: { status: "accepted" } },
  ])("does not accept or register an ACP $name receipt", async ({ receipt }) => {
    hoisted.callGatewayMock.mockImplementation(async (request: GatewayRequest) =>
      request.method === "agent" ? receipt : { ok: true },
    );
    const result = await spawnAcpDirect(
      { task: "Wait for actual acceptance", agentId: "codex", mode: "run" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(expectFailedSpawn(result, "error")).toMatchObject({ errorCode: "dispatch_failed" });
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.cleanupFailedAcpSpawnMock).toHaveBeenCalledOnce();
  });
}
