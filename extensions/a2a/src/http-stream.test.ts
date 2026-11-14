import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import {
  expectReply,
  rpcError,
  rpcFailure,
  sendRequest,
  startHttpHarness,
  taskRequest,
  wireHeaders,
  workingTask,
} from "./http.test-support.js";

it("streams native snapshots and reconnects to the same peer-owned task without redispatch", async () => {
  const release = createDeferred<void>();
  const harness = await startHttpHarness({
    onDispatch: async ({ store, taskId }) => {
      await release.promise;
      await store.complete(taskId, "Final answer");
    },
  });
  await withServer(
    (req, res) => void harness.handler(req, res),
    async (baseUrl) => {
      const post = (body: unknown, token = "alpha-secret") =>
        fetch(`${baseUrl}/a2a/v1`, {
          method: "POST",
          headers: { ...wireHeaders, authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      const request = {
        ...sendRequest({ messageId: "stream-original" }),
        method: "SendStreamingMessage",
      };
      const first = await post(request);
      expect(first.headers.get("content-type")).toContain("text/event-stream");
      const reader = first.body!.getReader();
      const initial = new TextDecoder().decode((await reader.read()).value);
      const task = JSON.parse(initial.split("data: ")[1]!.trim()).result.task;
      expect(task.status.state).toBe("TASK_STATE_WORKING");
      harness.taskStore.update(task.id, "First native snapshot");
      const partial = JSON.parse(
        new TextDecoder()
          .decode((await reader.read()).value)
          .split("data: ")[1]!
          .trim(),
      );
      expect(partial.result.artifactUpdate).toMatchObject({
        taskId: task.id,
        append: false,
        lastChunk: false,
        artifact: { parts: [{ text: "First native snapshot" }] },
      });
      await reader.cancel();
      expect(harness.taskStore.get(task.id, "alpha")?.status.state).toBe("TASK_STATE_WORKING");
      expect(
        await (
          await post(taskRequest(task.id, "wrong-peer", "SubscribeToTask"), "beta-secret")
        ).json(),
      ).toMatchObject(rpcError(-32001));
      const resumed = await post(taskRequest(task.id, "resume", "SubscribeToTask"));
      const resumedReader = resumed.body!.getReader();
      const snapshot = JSON.parse(
        new TextDecoder()
          .decode((await resumedReader.read()).value)
          .split("data: ")[1]!
          .trim(),
      );
      expect(snapshot.result.task).toMatchObject({
        id: task.id,
        artifacts: [partial.result.artifactUpdate.artifact],
      });
      harness.taskStore.update(task.id, "Second native snapshot");
      const next = JSON.parse(
        new TextDecoder()
          .decode((await resumedReader.read()).value)
          .split("data: ")[1]!
          .trim(),
      );
      expect(next.result.artifactUpdate.artifact.artifactId).toBe(
        partial.result.artifactUpdate.artifact.artifactId,
      );
      expect(next.result.artifactUpdate.artifact.parts).toEqual([
        { text: "Second native snapshot" },
      ]);
      release.resolve();
      let tail = "";
      for (;;) {
        const { done, value } = await resumedReader.read();
        if (done) {
          break;
        }
        tail += new TextDecoder().decode(value);
      }
      expect(tail).toContain("TASK_STATE_COMPLETED");
      expect(tail).toContain("Final answer");
      expect(await (await post(request)).text()).toContain(task.id);
      expect(harness.onDispatch).toHaveBeenCalledOnce();
    },
  ).finally(() => release.resolve());
});

it("bounds stream admission before new work and rejects streaming batches", async () => {
  const harness = await startHttpHarness({
    a2aConfig: { rateLimitPerMinute: 0 },
    onDispatch: async () => {},
  });
  const taskId = await workingTask(harness);
  const send = { ...sendRequest({ messageId: "over-capacity" }), method: "SendStreamingMessage" };
  await expectReply(harness.post([send]), [rpcFailure("send-1", -32600, expect.any(String))]);
  await withServer(
    (req, res) => void harness.handler(req, res),
    async (baseUrl) => {
      const post = (body: unknown) =>
        fetch(`${baseUrl}/a2a/v1`, {
          method: "POST",
          headers: wireHeaders,
          body: JSON.stringify(body),
        });
      const streams: Response[] = [];
      try {
        for (let index = 0; index < 64; index++) {
          const response = await post(
            taskRequest(taskId, `subscription-${index}`, "SubscribeToTask"),
          );
          streams.push(response);
          expect(response.headers.get("content-type")).toContain("text/event-stream");
        }
        expect(await (await post(send)).json()).toMatchObject(
          rpcError(-32000, expect.stringContaining("capacity")),
        );
        expect(harness.onDispatch).toHaveBeenCalledOnce();
      } finally {
        await Promise.all(streams.map(async (response) => response.body?.cancel()));
      }
    },
  );
});

it.each(["peer removed", "channel disabled", "token rotated"] as const)(
  "revokes an existing stream after %s before the channel restart tail",
  async (change) => {
    const harness = await startHttpHarness({ onDispatch: async () => {} });
    await withServer(
      (req, res) => void harness.handler(req, res),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/a2a/v1`, {
          method: "POST",
          headers: wireHeaders,
          body: JSON.stringify({
            ...sendRequest({ messageId: "revocable-stream" }),
            method: "SendStreamingMessage",
          }),
        });
        const reader = response.body!.getReader();
        try {
          const first = new TextDecoder().decode((await reader.read()).value);
          const taskId = JSON.parse(first.split("data: ")[1]!.trim()).result.task.id;
          const candidate = structuredClone(harness.runtime.config.current({ clone: true }));
          const channel = candidate.channels!.a2a!;
          if (change === "peer removed") {
            delete channel.peers!.alpha;
          } else if (change === "channel disabled") {
            channel.enabled = false;
          } else {
            channel.peers!.alpha!.token = "replacement-secret";
          }
          // The runtime owner has published; account teardown has not reached its abort yet.
          vi.mocked(harness.runtime.config.current).mockReturnValue(candidate);
          expect(harness.signal.aborted).toBe(false);
          const next = reader.read().then(
            (value) => (value.done ? "closed" : new TextDecoder().decode(value.value)),
            () => "closed",
          );
          harness.taskStore.update(taskId, "must not reach the revoked stream");
          expect(await next).toBe("closed");
          expect(harness.taskStore.get(taskId, "alpha")?.status.state).toBe("TASK_STATE_WORKING");
          await expectReply(harness.post(taskRequest(taskId)), { error: expect.any(String) }, 401);
          await harness.taskStore.complete(taskId, "independent final answer");
          if (change === "token rotated") {
            await expectReply(harness.post(taskRequest(taskId), "replacement-secret"), {
              result: { id: taskId, status: { state: "TASK_STATE_COMPLETED" } },
            });
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      },
    );
  },
);
