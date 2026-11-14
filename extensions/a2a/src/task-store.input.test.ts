import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { A2aTaskStore } from "./task-store.js";

it.each(["completed", "restart", "lost-ack"] as const)(
  "keeps source input identity and receipts through %s",
  async (outcome) => {
    const state = await createOpenClawTestState({ label: `a2a-input-${outcome}` });
    try {
      type Terminal = Parameters<ConstructorParameters<typeof A2aTaskStore>[0]["register"]>[1];
      type Pending = Parameters<ConstructorParameters<typeof A2aTaskStore>[1]["register"]>[1];
      const terminal = createPluginStateKeyedStoreV2ForTests<Terminal>(
        "a2a",
        { namespace: "input-terminal", maxEntries: 500, env: state.env },
        { assertCurrent() {} },
      );
      const pending = createPluginStateKeyedStoreV2ForTests<Pending>(
        "a2a",
        {
          namespace: "input-pending",
          maxEntries: 500,
          overflowPolicy: "reject-new",
          env: state.env,
        },
        { assertCurrent() {} },
      );
      let loseAck = false;
      const store = new A2aTaskStore(terminal, {
        ...pending,
        register: async (...args) => {
          await pending.register(...args);
          if (loseAck) {
            throw new Error("lost ACK");
          }
        },
      });
      const task = store.create("ctx-input", "alice", "initial");
      await store.start(task.id);
      const waiter = store.wait(task, 60_000);
      const source = new AbortController();
      const question = {
        version: 1 as const,
        expiresAtMs: Date.now() + 60_000,
        signal: source.signal,
        questions: [
          {
            id: "seats",
            header: "Seats",
            question: "How many seats?",
            options: [{ label: "100" }, { label: "200" }],
          },
        ],
      };
      await store.requireInput(task.id, question);
      await expect(waiter).resolves.toBe(task);
      if (task.status.state !== "TASK_STATE_INPUT_REQUIRED") {
        throw new Error("Question was not published");
      }
      const prompt = task.status.message.messageId;
      expect(JSON.stringify(task)).not.toContain("resolutionId");
      expect(task.artifacts).toEqual([]);
      await expect(
        store.beginAnswer(task.id, "bob", "answer", prompt, "100"),
      ).rejects.toMatchObject({
        code: -32001,
      });
      await expect(
        store.beginAnswer(task.id, "alice", "answer", "other-prompt", "100"),
      ).rejects.toMatchObject({ code: -32602 });
      if (outcome === "lost-ack") {
        loseAck = true;
        await expect(store.beginAnswer(task.id, "alice", "answer", prompt, "100")).rejects.toThrow(
          "lost ACK",
        );
        await expect(store.beginAnswer(task.id, "alice", "answer", prompt, "100")).rejects.toThrow(
          "lost ACK",
        );
      } else {
        const accepted = await store.beginAnswer(task.id, "alice", "answer", prompt, "100");
        expect(accepted.question).toBe(question);
        const duplicate = await store.beginAnswer(task.id, "alice", "answer", prompt, "100");
        expect(duplicate.question).toBeUndefined();
        if (outcome === "completed") {
          // Native completion can beat its incoming answer's receipt callback.
          await store.complete(task.id, "100 seats");
          await store.recordAnswer(task.id, accepted.receipt, {
            status: "confirmed",
            resolutionId: "native-receipt",
          });
        }
      }
      const restored = new A2aTaskStore(terminal, pending);
      await restored.restore();
      const original = restored.get(task.id, "alice");
      expect(original?.status.state).toBe(
        outcome === "completed" ? "TASK_STATE_COMPLETED" : "TASK_STATE_FAILED",
      );
      expect(restored.create("different-context", "alice", "answer").id).toBe(task.id);
      const replay = await restored.beginAnswer(task.id, "alice", "answer", prompt, "100");
      expect(replay.question).toBeUndefined();
      expect(replay.receipt.result.status).toBe(outcome === "completed" ? "confirmed" : "pending");
      expect(JSON.stringify(original)).not.toContain("native-receipt");
      expect(await pending.entries()).toEqual([]);
    } finally {
      await state.cleanup();
    }
  },
);
