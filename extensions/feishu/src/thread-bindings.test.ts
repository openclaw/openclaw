import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { getSessionBindingService } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  createFeishuThreadBindingManager,
  ensureFeishuThreadBindingManagerForAccount,
  recordFeishuNativeThreadBinding,
  resolveFeishuThreadBindingByNativeThread,
  stopFeishuThreadBindingManager,
} from "./thread-bindings.js";

describe("feishu thread bindings", () => {
  beforeEach(() => {
    __testing.resetFeishuThreadBindingsForTests();
  });

  it("binds current Feishu thread conversations via the shared session binding service", async () => {
    createFeishuThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    const bound = await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:s1",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_chat_1:thread:om_root_1",
      },
      placement: "current",
      metadata: {
        agentId: "codex",
        boundBy: "user-1",
      },
    });

    expect(bound.conversation.conversationId).toBe("oc_chat_1:thread:om_root_1");
    expect(bound.targetKind).toBe("session");
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_chat_1:thread:om_root_1",
      })?.targetSessionKey,
    ).toBe("agent:codex:acp:s1");
  });

  it("binds child Feishu conversations by using the triggering message as the topic root", async () => {
    createFeishuThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    const bound = await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:s1",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_chat_parent",
      },
      placement: "child",
      metadata: {
        sourceMessageId: "om_seed_1",
      },
    });

    expect(bound.conversation.conversationId).toBe("oc_chat_parent:thread:om_seed_1");
  });

  it("resolves native thread id aliases back to the canonical root-message binding", async () => {
    createFeishuThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:s1",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_chat_1:thread:om_root_1",
      },
      placement: "current",
      metadata: {
        nativeThreadId: "omt_thread_1",
      },
    });

    expect(
      resolveFeishuThreadBindingByNativeThread({
        accountId: "default",
        chatId: "oc_chat_1",
        nativeThreadId: "omt_thread_1",
      })?.targetSessionKey,
    ).toBe("agent:codex:acp:s1");
  });

  it("records native thread ids for an existing canonical binding", async () => {
    createFeishuThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:s3",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_chat_3:thread:om_root_3",
      },
      placement: "current",
    });

    const updated = recordFeishuNativeThreadBinding({
      accountId: "default",
      chatId: "oc_chat_3",
      rootMessageId: "om_root_3",
      nativeThreadId: "omt_thread_3",
    });

    expect(updated?.nativeThreadId).toBe("omt_thread_3");
    expect(
      resolveFeishuThreadBindingByNativeThread({
        accountId: "default",
        chatId: "oc_chat_3",
        nativeThreadId: "omt_thread_3",
      })?.conversation.conversationId,
    ).toBe("oc_chat_3:thread:om_root_3");
  });

  it("persists bindings under the Feishu state directory", async () => {
    const homeDir = await fsMkdtemp();
    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      createFeishuThreadBindingManager({
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:codex:acp:s2",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "work",
          conversationId: "oc_chat_2:thread:om_root_2",
        },
        placement: "current",
      });

      stopFeishuThreadBindingManager("work");
      createFeishuThreadBindingManager({
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });

      expect(
        getSessionBindingService().resolveByConversation({
          channel: "feishu",
          accountId: "work",
          conversationId: "oc_chat_2:thread:om_root_2",
        })?.targetSessionKey,
      ).toBe("agent:codex:acp:s2");
    } finally {
      process.env.HOME = previousHome;
      __testing.resetFeishuThreadBindingsForTests();
    }
  });

  it("ensures the adapter from config when Feishu thread bindings are enabled", () => {
    const cfg: ClawdbotConfig = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      channels: {
        feishu: {
          enabled: true,
        },
      },
    };

    const manager = ensureFeishuThreadBindingManagerForAccount({
      cfg,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    expect(manager?.accountId).toBe("default");
    expect(
      getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      }),
    ).toMatchObject({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["current", "child"],
    });
  });
});

async function fsMkdtemp(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-bindings-"));
}
