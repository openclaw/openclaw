import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread as claimThread,
  retainCodexAppServerLiveThread as retainThread,
  releaseCodexAppServerLiveThread as releaseThread,
  protectCodexAppServerLiveThread as protectThread,
} from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { listCodexAppServerModels } from "./models.js";
import { CodexNativeProcessAuthority } from "./native-process-authority.js";
import {
  captureCodexAppServerClientLifetime,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

export function registerSharedClientIdleTests() {
  it("reuses discovery across minute polls, then retires after five idle minutes", async () => {
    vi.useFakeTimers();
    const start = vi.spyOn(CodexAppServerClient, "start");
    const first = createIdleLifecycleHarness();
    const second = createIdleLifecycleHarness();
    start.mockResolvedValueOnce(first.client).mockResolvedValueOnce(second.client);
    const read = async () =>
      expect((await listCodexAppServerModels()).models).toMatchObject([{ id: "fixture-model" }]);
    await read();
    const assertCurrent = captureCodexAppServerClientLifetime(first.client, "connection");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.client.getCloseError()).toBeUndefined();
    await read();
    expect(start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(assertCurrent).not.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.client.getCloseError()).toBeDefined();
    expect(assertCurrent).toThrow("connection changed");
    await read();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it.each([
    "lease",
    "claimed",
    "retained",
    "ephemeral",
    "protected",
    "releasing",
    "background",
  ] as const)("idle retirement waits for %s ownership to settle", async (kind) => {
    const { client, send } = await startIdleClient();
    const releaseGate = createDeferred<void>();
    const failure = vi.fn();
    let finish: () => Promise<unknown>;
    if (kind === "lease") {
      finish = async () => releaseLeasedSharedCodexAppServerClient(client);
    } else if (kind === "claimed") {
      const thread = await claimThread(client, "thread");
      expect(thread).toBeDefined();
      finish = async () => thread!.release("thread");
    } else if (kind === "protected") {
      const unprotect = protectThread(client, "thread");
      finish = async () => unprotect();
    } else if (kind === "background") {
      const authority = new CodexNativeProcessAuthority(createCodexTestHostCapabilities(), failure);
      const turn = { threadId: "thread", turnId: "turn" };
      authority.bindTurn(client, turn.threadId, turn.turnId);
      const confirm = authority.prepareBackgroundCommands(client, turn, new Map([["item", "pid"]]));
      confirm(new Map([["item", "pid"]]));
      authority.release();
      finish = async () =>
        send({
          method: "item/completed",
          params: { ...turn, item: { id: "item", type: "commandExecution", processId: "pid" } },
        });
    } else {
      const waitForRelease = async () => releaseGate.promise;
      const retention = kind === "ephemeral" ? {} : undefined;
      expect(
        await retainThread(client, "thread", waitForRelease, undefined, undefined, retention),
      ).toBe(true);
      const releasing = kind === "releasing" && releaseThread(client, "thread");
      finish = async () => {
        releaseGate.resolve();
        await (releasing || releaseThread(client, "thread"));
      };
    }
    if (kind !== "lease") {
      releaseLeasedSharedCodexAppServerClient(client);
    }
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.getCloseError()).toBeUndefined();
    await finish();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(client.getCloseError()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getCloseError()).toBeDefined();
    expect(failure).not.toHaveBeenCalled();
  });
}

async function startIdleClient() {
  vi.useFakeTimers();
  const harness = createIdleLifecycleHarness();
  vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
  return { ...harness, client: await getLeasedSharedCodexAppServerClient() };
}

function createIdleLifecycleHarness() {
  const responses = {
    initialize: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` },
    "model/list": {
      data: [
        {
          id: "fixture-model",
          model: "fixture-model",
          displayName: "Fixture",
          description: "Fixture",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
        },
      ],
    },
    "thread/unsubscribe": {},
  };
  return createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as { id?: number; method: keyof typeof responses };
      if (Object.hasOwn(responses, request.method)) {
        send({ id: request.id, result: responses[request.method] });
      }
    },
  });
}
