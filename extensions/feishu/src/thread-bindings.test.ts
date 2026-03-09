import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { getSessionBindingService } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("clears in-memory bindings when a manager stops without persistence", async () => {
    createFeishuThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:s4",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_chat_4:thread:om_root_4",
      },
      placement: "current",
      metadata: {
        nativeThreadId: "omt_thread_4",
      },
    });

    stopFeishuThreadBindingManager("default");

    expect(
      getSessionBindingService().resolveByConversation({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_chat_4:thread:om_root_4",
      }),
    ).toBeNull();
    expect(
      resolveFeishuThreadBindingByNativeThread({
        accountId: "default",
        chatId: "oc_chat_4",
        nativeThreadId: "omt_thread_4",
      }),
    ).toBeNull();
  });

  it("logs a diagnostic when child placement is missing the trigger message id", async () => {
    createFeishuThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        getSessionBindingService().bind({
          targetSessionKey: "agent:codex:acp:s5",
          targetKind: "session",
          conversation: {
            channel: "feishu",
            accountId: "default",
            conversationId: "oc_chat_parent_5",
          },
          placement: "child",
          metadata: {},
        }),
      ).rejects.toThrow("Session binding adapter failed to bind target conversation");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "child placement requires parent conversation and source message id",
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("loads persisted bindings from the Feishu state directory", async () => {
    const homeDir = await fsMkdtemp();
    const previousHome = process.env.HOME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.HOME = homeDir;
    process.env.OPENCLAW_STATE_DIR = path.join(homeDir, ".openclaw");
    try {
      const bindingsPath = path.join(
        process.env.OPENCLAW_STATE_DIR,
        "feishu",
        "thread-bindings-work.json",
      );
      await fsPromises.mkdir(path.dirname(bindingsPath), { recursive: true });
      await fsPromises.writeFile(
        bindingsPath,
        JSON.stringify({
          version: 1,
          bindings: [
            {
              accountId: "work",
              conversationId: "oc_chat_2:thread:om_root_2",
              targetKind: "acp",
              targetSessionKey: "agent:codex:acp:s2",
              boundAt: 1,
              lastActivityAt: 1,
            },
          ],
        }),
      );

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
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
      __testing.resetFeishuThreadBindingsForTests();
    }
  });

  it("serializes persisted binding writes per account", async () => {
    const homeDir = await fsMkdtemp();
    const previousHome = process.env.HOME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.HOME = homeDir;
    process.env.OPENCLAW_STATE_DIR = path.join(homeDir, ".openclaw");
    try {
      const manager = createFeishuThreadBindingManager({
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:codex:acp:serial",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "work",
          conversationId: "oc_chat_serial:thread:om_root_serial",
        },
        placement: "current",
      });
      await __testing.flushPersistQueueForTests("work");

      const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
      let releaseFirstWrite: (() => void) | undefined;
      let writeCount = 0;
      const writeSpy = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (...args) => {
        writeCount += 1;
        if (writeCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        return originalWriteFile(...args);
      });

      try {
        manager.touchConversation("oc_chat_serial:thread:om_root_serial", 2);
        manager.unbindConversation({
          conversationId: "oc_chat_serial:thread:om_root_serial",
        });

        await vi.waitFor(() => {
          expect(writeSpy).toHaveBeenCalledTimes(1);
        });
        expect(releaseFirstWrite).toBeTypeOf("function");
        const unblockFirstWrite = releaseFirstWrite;
        if (!unblockFirstWrite) {
          throw new Error("expected first persist write to be blocked");
        }
        unblockFirstWrite();
        await __testing.flushPersistQueueForTests("work");

        expect(writeSpy).toHaveBeenCalledTimes(2);
        const bindingsPath = path.join(
          process.env.OPENCLAW_STATE_DIR,
          "feishu",
          "thread-bindings-work.json",
        );
        const payload = JSON.parse(await fsPromises.readFile(bindingsPath, "utf-8")) as {
          bindings: unknown[];
        };
        expect(payload.bindings).toEqual([]);
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      process.env.HOME = previousHome;
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
      __testing.resetFeishuThreadBindingsForTests();
    }
  });

  it("preserves queued persisted bindings when a manager stops", async () => {
    const homeDir = await fsMkdtemp();
    const previousHome = process.env.HOME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.HOME = homeDir;
    process.env.OPENCLAW_STATE_DIR = path.join(homeDir, ".openclaw");
    try {
      createFeishuThreadBindingManager({
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });

      const bindingsPath = path.join(
        process.env.OPENCLAW_STATE_DIR,
        "feishu",
        "thread-bindings-work.json",
      );
      const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
      let releaseWrite: (() => void) | undefined;
      const writeSpy = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        return originalWriteFile(...args);
      });

      try {
        await getSessionBindingService().bind({
          targetSessionKey: "agent:codex:acp:stop-persist",
          targetKind: "session",
          conversation: {
            channel: "feishu",
            accountId: "work",
            conversationId: "oc_chat_stop:thread:om_root_stop",
          },
          placement: "current",
        });

        await vi.waitFor(() => {
          expect(writeSpy).toHaveBeenCalledTimes(1);
        });

        stopFeishuThreadBindingManager("work");

        expect(
          getSessionBindingService().resolveByConversation({
            channel: "feishu",
            accountId: "work",
            conversationId: "oc_chat_stop:thread:om_root_stop",
          }),
        ).toBeNull();

        const unblockWrite = releaseWrite;
        if (!unblockWrite) {
          throw new Error("expected pending persist write to be blocked");
        }
        unblockWrite();
        await __testing.flushPersistQueueForTests("work");

        const payload = JSON.parse(await fsPromises.readFile(bindingsPath, "utf-8")) as {
          bindings: Array<{
            conversationId: string;
            targetSessionKey: string;
          }>;
        };
        expect(payload.bindings).toEqual([
          expect.objectContaining({
            conversationId: "oc_chat_stop:thread:om_root_stop",
            targetSessionKey: "agent:codex:acp:stop-persist",
          }),
        ]);
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      process.env.HOME = previousHome;
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
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
