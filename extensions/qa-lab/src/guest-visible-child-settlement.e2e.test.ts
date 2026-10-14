import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const TRIGGER = "delegate one visible qa task";
const REQUESTER_CONVERSATION = { id: "requester-user", kind: "direct" as const };

/** Issue #171647: a guest with own-session write scope must be resumed by the
 * settlement of the visible child it started and yielded on. */
function withGuestRole(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    gateway: {
      ...config.gateway,
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "none" },
            agents: ["main"],
            scopes: ["operator.sessions.read", "operator.sessions.write"],
            sandbox: "required",
          },
        },
      },
    },
  };
}

describe("guest visible-child settlement", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it("resumes the yielded guest requester with the failed visible child's notice", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await owner.stop()).errors).toEqual([]);
    });
    const gateway = await owner.start({
      repoRoot: REPO_ROOT,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: withGuestRole,
    });
    await transport.waitReady({ gateway });
    const sinceIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: REQUESTER_CONVERSATION,
      senderId: REQUESTER_CONVERSATION.id,
      text: TRIGGER,
    });
    // The settlement wake must resume the guest's paused turn; without the
    // host-owned requester binding admission denies it and nothing arrives.
    const notice = await transport.waitForOutbound({
      conversation: REQUESTER_CONVERSATION,
      sinceIndex,
      textIncludes: "QA injected visible child failure",
      timeoutMs: 120_000,
    });
    expect(notice.accountId).toBe("default");
  }, 180_000);
});
