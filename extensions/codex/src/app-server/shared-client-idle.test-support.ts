import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { listCodexAppServerModels } from "./models.js";
import { CodexNativeProcessAuthority } from "./native-process-authority.js";
import {
  captureSharedCodexAppServerCatalogLifetime,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

export function registerSharedClientIdleTests() {
  it("retires an idle discovery client after the grace and reacquires on demand", async () => {
    vi.useFakeTimers();
    const start = vi.spyOn(CodexAppServerClient, "start");
    const first = createIdleLifecycleHarness();
    const second = createIdleLifecycleHarness();
    start.mockResolvedValueOnce(first.client).mockResolvedValueOnce(second.client);
    const read = () => listCodexAppServerModels();
    expect((await read()).models).toMatchObject([{ id: "fixture-model" }]);
    const current = captureSharedCodexAppServerCatalogLifetime(first.client);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.client.getCloseError()).toBeUndefined();
    expect((await read()).models).toMatchObject([{ id: "fixture-model" }]);
    expect(start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(current()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.client.getCloseError()).toBeDefined();
    expect(current()).toBe(false);
    expect((await read()).models).toMatchObject([{ id: "fixture-model" }]);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it.each(["lease", "claimed", "retained", "ephemeral", "protected", "releasing"] as const)(
    "idle retirement waits for %s ownership to settle",
    async (kind) => {
      vi.useFakeTimers();
      const harness = createIdleLifecycleHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const client = await getLeasedSharedCodexAppServerClient();
      const releaseGate = createDeferred<void>();
      let finish: () => Promise<unknown>;
      if (kind === "lease") {
        finish = async () => releaseLeasedSharedCodexAppServerClient(client);
      } else {
        if (kind === "claimed") {
          const thread = await claimCodexAppServerLiveThread(client, "thread");
          expect(thread).toBeDefined();
          finish = async () => thread!.release("thread");
        } else if (kind === "protected") {
          const unprotect = protectCodexAppServerLiveThread(client, "thread");
          finish = async () => unprotect();
        } else {
          expect(
            await retainCodexAppServerLiveThread(
              client,
              "thread",
              async () => releaseGate.promise,
              undefined,
              undefined,
              kind === "ephemeral" ? {} : undefined,
            ),
          ).toBe(true);
          if (kind === "releasing") {
            const releasing = releaseCodexAppServerLiveThread(client, "thread");
            finish = async () => {
              releaseGate.resolve();
              await releasing;
            };
          } else {
            finish = async () => {
              releaseGate.resolve();
              await releaseCodexAppServerLiveThread(client, "thread");
            };
          }
        }
        releaseLeasedSharedCodexAppServerClient(client);
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.getCloseError()).toBeUndefined();
      await finish();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(client.getCloseError()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(client.getCloseError()).toBeDefined();
    },
  );

  it("idle retirement preserves a confirmed background terminal until its completion receipt", async () => {
    vi.useFakeTimers();
    const harness = createIdleLifecycleHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const client = await getLeasedSharedCodexAppServerClient();
    const failure = vi.fn();
    const authority = new CodexNativeProcessAuthority(createCodexTestHostCapabilities(), failure);
    const turn = { threadId: "thread", turnId: "turn" };
    authority.bindTurn(client, turn.threadId, turn.turnId);
    const confirm = authority.prepareBackgroundCommands(client, turn, new Map([["item", "pid"]]));
    confirm(new Map([["item", "pid"]]));
    authority.release();
    releaseLeasedSharedCodexAppServerClient(client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getCloseError()).toBeUndefined();
    harness.send({
      method: "item/completed",
      params: { ...turn, item: { id: "item", type: "commandExecution", processId: "pid" } },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.getCloseError()).toBeDefined();
    expect(failure).not.toHaveBeenCalled();
  });
}

function createIdleLifecycleHarness() {
  return createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as { id?: number; method: string };
      if (request.method === "initialize") {
        send({ id: request.id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } });
      } else if (request.method === "model/list") {
        send({
          id: request.id,
          result: {
            data: [
              {
                id: "fixture-model",
                model: "fixture-model",
                displayName: "Fixture",
                description: "Fixture",
                hidden: false,
                isDefault: true,
                inputModalities: ["text"],
                supportedReasoningEfforts: [],
                defaultReasoningEffort: "medium",
                supportsPersonality: false,
              },
            ],
            nextCursor: null,
          },
        });
      } else if (request.method === "thread/unsubscribe") {
        send({ id: request.id, result: {} });
      }
    },
  });
}
