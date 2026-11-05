import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { expect, it } from "vitest";

// The caller owns a staged-source Gateway and its configured auth. This test never
// builds/restarts a Gateway, imports provider credentials, or changes its config.
const enabled =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_NATIVE_GOAL_GATEWAY === "1";

type Row = {
  key: string;
  sessionId: string;
  hasActiveRun?: boolean;
  agentRuntime?: { id?: string };
  goal?: { id: string; objective: string; status: string };
};
type Receipt = { runId: string; threadId: string; turnId: string; method: string };

it.skipIf(!enabled)(
  "keeps real native turns in one host run and resumes the same paused goal",
  async () => {
    const url = process.env.OPENCLAW_LIVE_NATIVE_GOAL_GATEWAY_URL;
    const token = process.env.OPENCLAW_LIVE_NATIVE_GOAL_GATEWAY_TOKEN;
    const model = process.env.OPENCLAW_LIVE_CODEX_HARNESS_MODEL;
    if (!url || !token || !model) {
      throw new Error("Provide the isolated staged Gateway URL/token and configured Codex model");
    }
    const address = new URL(url);
    if (
      address.protocol !== "ws:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) ||
      !address.port ||
      address.port === "18789"
    ) {
      throw new Error("Use a dedicated loopback staged Gateway, not the live default Gateway");
    }
    const sessionKey = `agent:main:native-goal-proof-${randomUUID()}`;
    const receipts: Receipt[] = [];
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let client: GatewayClient | undefined;
    let created = false;
    const until = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const value = await read();
        if (value !== undefined) {
          return value;
        }
        await delay(100);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        client = new GatewayClient({
          url,
          token,
          clientName: "test",
          clientVersion: "native-goal-proof",
          mode: "test",
          requestTimeoutMs: 120_000,
          onHelloOk: () => resolve(),
          onConnectError: reject,
          onEvent: (event) => {
            if (event.event !== "agent" || !event.payload || typeof event.payload !== "object") {
              return;
            }
            const payload = event.payload as Record<string, unknown>;
            if (
              payload.sessionKey !== sessionKey ||
              payload.stream !== "codex_app_server.diagnostic"
            ) {
              return;
            }
            const data = payload.data as Record<string, unknown> | undefined;
            if (
              data?.phase === "notification" &&
              typeof payload.runId === "string" &&
              typeof data.threadId === "string" &&
              typeof data.turnId === "string" &&
              typeof data.method === "string"
            ) {
              receipts.push({
                runId: payload.runId,
                threadId: data.threadId,
                turnId: data.turnId,
                method: data.method,
              });
            }
          },
        });
        connectTimer = setTimeout(
          () => reject(new Error("Staged Gateway did not connect")),
          30_000,
        );
        client.start();
      });
      clearTimeout(connectTimer);
      const rpc = <T>(method: string, params: unknown) => client!.request<T>(method, params);
      const row = async () => {
        const result = await rpc<{ sessions: Row[] }>("sessions.list", { limit: 1000 });
        return result.sessions.find((entry) => entry.key === sessionKey);
      };
      const mutate = async (action: "pause" | "resume") => {
        const current = await row();
        if (!current?.goal) {
          throw new Error("Proof goal disappeared");
        }
        return rpc<{ runId?: string; status: string }>("sessions.goal.update", {
          sessionKey,
          sessionId: current.sessionId,
          goalId: current.goal.id,
          action,
          operationId: randomUUID(),
          issuedAtMs: Date.now(),
        });
      };
      const paused = async () => {
        await mutate("pause");
        return until(async () => {
          const current = await row();
          return current?.goal?.status === "paused" && !current.hasActiveRun ? current : undefined;
        }, "committed Pause and native run settlement");
      };
      const completedTurns = (runId: string) => [
        ...new Map(
          receipts
            .filter((r) => r.runId === runId && r.method === "turn/completed")
            .map((r) => [r.turnId, r]),
        ).values(),
      ];
      await rpc("sessions.create", {
        key: sessionKey,
        agentId: "main",
        model,
        agentRuntime: "codex",
      });
      created = true;
      const objective =
        "Native continuation verification: count upward from one, replying with only the next integer once per native turn. End each turn after that one integer. Continue automatically on subsequent native goal turns until the operator pauses you. Do not complete, block, or modify the goal. Do not use tools, write files, or send messages.";
      const start = await rpc<{ runId: string }>("chat.send", {
        sessionKey,
        message: objective,
        idempotencyKey: randomUUID(),
        intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
      });
      const initial = await until(row, "created goal");
      expect(initial.agentRuntime?.id).toBe("codex");
      expect(initial.goal?.objective).toBe(objective);
      const first = await until(async () => {
        const turns = completedTurns(start.runId);
        return turns.length >= 2 ? turns : undefined;
      }, "two native completions under the initial host run (enable OPENCLAW_LIVE_TEST in Gateway)");
      expect(new Set(first.map((r) => r.threadId)).size).toBe(1);
      const firstPaused = await paused();
      expect(firstPaused.goal?.id).toBe(initial.goal?.id);
      const settledReceiptCount = receipts.length;
      await delay(1_500);
      expect(receipts).toHaveLength(settledReceiptCount);
      const resume = await mutate("resume");
      expect(resume.status).toBe("started");
      expect(resume.runId).toBeTruthy();
      expect(resume.runId).not.toBe(start.runId);
      const resumed = await until(async () => {
        const turns = completedTurns(resume.runId!);
        return turns.length >= 2 ? turns : undefined;
      }, "two resumed native completions under a fresh host run");
      const firstTurn = first[0];
      if (!firstTurn) {
        throw new Error("Initial native turn receipt missing");
      }
      expect(resumed.every((r) => r.threadId === firstTurn.threadId)).toBe(true);
      const last = await paused();
      expect(last.sessionId).toBe(initial.sessionId);
      expect(last.goal).toMatchObject({ id: initial.goal!.id, objective, status: "paused" });
      console.log(
        JSON.stringify({
          proof: "staged-gateway-native-goal-smoke",
          firstNativeTurns: first.length,
          resumedNativeTurns: resumed.length,
          sameNativeThread: true,
          sameHostGoal: true,
          differentHostRun: true,
          pausedAndSettled: true,
          privateInferenceOrdering: "not observed by this black-box test",
          activeVsIdlePause: "not synchronized by this black-box test",
        }),
      );
    } finally {
      clearTimeout(connectTimer);
      try {
        // Stop also covers a failure before the goal row was observed. Preserve the
        // diagnostic session in the disposable Gateway; its owner removes that state.
        if (created) {
          await client?.request("chat.abort", { sessionKey });
        }
      } finally {
        await client?.stopAndWait();
      }
    }
  },
  300_000,
);
