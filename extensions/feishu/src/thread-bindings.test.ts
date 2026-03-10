import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  getSessionBindingService,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createFeishuThreadBindingManager,
  ensureFeishuThreadBindingManagerForAccount,
  rehydrateFeishuThreadBindingManagerForAccount,
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

  it("re-registers the shared adapter when reusing an existing manager", () => {
    const first = createFeishuThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    expect(
      getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      }),
    ).toMatchObject({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["current"],
    });

    unregisterSessionBindingAdapter({
      channel: "feishu",
      accountId: "default",
    });

    expect(
      getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      }),
    ).toMatchObject({
      adapterAvailable: false,
      bindSupported: false,
      placements: [],
    });

    const reused = createFeishuThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    expect(reused).toBe(first);
    expect(
      getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      }),
    ).toMatchObject({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["current"],
    });
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
    });

    stopFeishuThreadBindingManager("default");

    expect(
      getSessionBindingService().resolveByConversation({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_chat_4:thread:om_root_4",
      }),
    ).toBeNull();
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

  it("rehydrates persisted Feishu rebinds over stale in-memory state", async () => {
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
      createFeishuThreadBindingManager({
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:codex:acp:stale",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "work",
          conversationId: "oc_chat_rebind:thread:om_root_rebind",
        },
        placement: "current",
      });
      await __testing.flushPersistQueueForTests("work");

      await fsPromises.writeFile(
        bindingsPath,
        JSON.stringify(
          {
            version: 1,
            bindings: [
              {
                accountId: "work",
                conversationId: "oc_chat_rebind:thread:om_root_rebind",
                targetKind: "acp",
                targetSessionKey: "agent:codex:acp:fresh",
                boundAt: 2,
                lastActivityAt: 3,
              },
            ],
          },
          null,
          2,
        ),
      );

      rehydrateFeishuThreadBindingManagerForAccount({
        cfg: createFeishuBindingsConfig(),
        accountId: "work",
      });

      expect(
        getSessionBindingService().resolveByConversation({
          channel: "feishu",
          accountId: "work",
          conversationId: "oc_chat_rebind:thread:om_root_rebind",
        }),
      ).toMatchObject({
        targetSessionKey: "agent:codex:acp:fresh",
      });
    } finally {
      process.env.HOME = previousHome;
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
      __testing.resetFeishuThreadBindingsForTests();
    }
  });

  it("rehydrates persisted unbinds over stale in-memory state", async () => {
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
      createFeishuThreadBindingManager({
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:codex:acp:stale",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "work",
          conversationId: "oc_chat_unbind:thread:om_root_unbind",
        },
        placement: "current",
      });
      await __testing.flushPersistQueueForTests("work");

      await fsPromises.writeFile(
        bindingsPath,
        JSON.stringify({ version: 1, bindings: [] }, null, 2),
      );

      rehydrateFeishuThreadBindingManagerForAccount({
        cfg: createFeishuBindingsConfig(),
        accountId: "work",
      });

      expect(
        getSessionBindingService().resolveByConversation({
          channel: "feishu",
          accountId: "work",
          conversationId: "oc_chat_unbind:thread:om_root_unbind",
        }),
      ).toBeNull();
    } finally {
      process.env.HOME = previousHome;
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
      __testing.resetFeishuThreadBindingsForTests();
    }
  });

  it("does not let disk rehydration roll back bindings with a pending local persist", async () => {
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
          targetSessionKey: "agent:codex:acp:pending",
          targetKind: "session",
          conversation: {
            channel: "feishu",
            accountId: "work",
            conversationId: "oc_chat_pending:thread:om_root_pending",
          },
          placement: "current",
        });

        await vi.waitFor(() => {
          expect(writeSpy).toHaveBeenCalledTimes(1);
        });

        rehydrateFeishuThreadBindingManagerForAccount({
          cfg: createFeishuBindingsConfig(),
          accountId: "work",
        });

        expect(
          getSessionBindingService().resolveByConversation({
            channel: "feishu",
            accountId: "work",
            conversationId: "oc_chat_pending:thread:om_root_pending",
          })?.targetSessionKey,
        ).toBe("agent:codex:acp:pending");

        const unblockWrite = releaseWrite;
        if (!unblockWrite) {
          throw new Error("expected pending persist write to be blocked");
        }
        unblockWrite();
        await __testing.flushPersistQueueForTests("work");
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      process.env.HOME = previousHome;
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
      __testing.resetFeishuThreadBindingsForTests();
    }
  });

  it("does not resurrect a just-unbound binding during pending-write rehydration", async () => {
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
      createFeishuThreadBindingManager({
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });

      const conversationId = "oc_chat_pending_unbind:thread:om_root_pending_unbind";
      const bindingId = `work:${conversationId}`;
      await getSessionBindingService().bind({
        targetSessionKey: "agent:codex:acp:pending-unbind",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "work",
          conversationId,
        },
        placement: "current",
      });
      await __testing.flushPersistQueueForTests("work");

      const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
      let releaseWrite: (() => void) | undefined;
      const writeSpy = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        return originalWriteFile(...args);
      });

      try {
        await getSessionBindingService().unbind({
          bindingId,
          reason: "test-pending-unbind",
        });

        await vi.waitFor(() => {
          expect(writeSpy).toHaveBeenCalledTimes(1);
        });

        rehydrateFeishuThreadBindingManagerForAccount({
          cfg: createFeishuBindingsConfig(),
          accountId: "work",
        });

        expect(
          getSessionBindingService().resolveByConversation({
            channel: "feishu",
            accountId: "work",
            conversationId,
          }),
        ).toBeNull();

        const unblockWrite = releaseWrite;
        if (!unblockWrite) {
          throw new Error("expected pending persist write to be blocked");
        }
        unblockWrite();
        await __testing.flushPersistQueueForTests("work");

        const persisted = JSON.parse(await fsPromises.readFile(bindingsPath, "utf-8")) as {
          bindings: Array<{ conversationId: string }>;
        };
        expect(persisted.bindings).toEqual([]);
      } finally {
        writeSpy.mockRestore();
      }
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

  it("shares the persist queue across duplicate Feishu module copies", async () => {
    const homeDir = await fsMkdtemp();
    const previousHome = process.env.HOME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.HOME = homeDir;
    process.env.OPENCLAW_STATE_DIR = path.join(homeDir, ".openclaw");
    const moduleUrl = new URL("./thread-bindings.ts", import.meta.url).href;
    const suffix = Date.now().toString(36);
    const first = await import(/* @vite-ignore */ `${moduleUrl}?copy=${suffix}-a`);
    const second = await import(/* @vite-ignore */ `${moduleUrl}?copy=${suffix}-b`);
    try {
      const firstManager = first.createFeishuThreadBindingManager({
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });
      await getSessionBindingService().bind({
        targetSessionKey: "agent:codex:acp:stale",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "work",
          conversationId: "oc_chat_shared_queue:thread:om_root_shared_queue",
        },
        placement: "current",
      });
      await Promise.all([
        __testing.flushPersistQueueForTests("work"),
        first.__testing.flushPersistQueueForTests("work"),
      ]);

      second.createFeishuThreadBindingManager({
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });

      const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
      let releaseStaleWrite: (() => void) | undefined;
      let blockedStaleWrite = false;
      const writeSpy = vi.spyOn(fsPromises, "writeFile").mockImplementation(async (...args) => {
        const payload = typeof args[1] === "string" ? args[1] : "";
        if (!blockedStaleWrite && payload.includes('"targetSessionKey": "agent:codex:acp:stale"')) {
          blockedStaleWrite = true;
          await new Promise<void>((resolve) => {
            releaseStaleWrite = resolve;
          });
        }
        return originalWriteFile(...args);
      });

      try {
        firstManager.touchConversation("oc_chat_shared_queue:thread:om_root_shared_queue", 2);

        await vi.waitFor(() => {
          expect(blockedStaleWrite).toBe(true);
        });

        await getSessionBindingService().bind({
          targetSessionKey: "agent:codex:acp:fresh",
          targetKind: "session",
          conversation: {
            channel: "feishu",
            accountId: "work",
            conversationId: "oc_chat_shared_queue:thread:om_root_shared_queue",
          },
          placement: "current",
        });

        const unblockStaleWrite = releaseStaleWrite;
        if (!unblockStaleWrite) {
          throw new Error("expected stale persist write to be blocked");
        }
        unblockStaleWrite();
        await Promise.all([
          __testing.flushPersistQueueForTests("work"),
          first.__testing.flushPersistQueueForTests("work"),
          second.__testing.flushPersistQueueForTests("work"),
        ]);

        const bindingsPath = path.join(
          process.env.OPENCLAW_STATE_DIR,
          "feishu",
          "thread-bindings-work.json",
        );
        const payload = JSON.parse(await fsPromises.readFile(bindingsPath, "utf-8")) as {
          bindings: Array<{
            conversationId: string;
            targetSessionKey: string;
          }>;
        };
        expect(payload.bindings).toEqual([
          expect.objectContaining({
            conversationId: "oc_chat_shared_queue:thread:om_root_shared_queue",
            targetSessionKey: "agent:codex:acp:fresh",
          }),
        ]);
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      process.env.HOME = previousHome;
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
      __testing.resetFeishuThreadBindingsForTests();
      first.__testing.resetFeishuThreadBindingsForTests();
      second.__testing.resetFeishuThreadBindingsForTests();
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
      placements: ["current"],
    });
  });
});

function createFeishuBindingsConfig(): ClawdbotConfig {
  return {
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
}

async function fsMkdtemp(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-bindings-"));
}
