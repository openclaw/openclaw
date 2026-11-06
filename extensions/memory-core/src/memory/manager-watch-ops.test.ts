import fs from "node:fs/promises";
import path from "node:path";
import { registerAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import {
  listMemoryFiles,
  readMemoryFile,
  type MemoryWorkspaceFiles,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const managers = await import("./index.js");

describe("memory workspace watcher lifecycle", () => {
  const fixture = createManagerIndexFixture(managers);
  const createConfig = (overrides: Parameters<typeof fixture.createConfig>[0] = {}) =>
    fixture.createConfig({
      provider: "none",
      sources: ["memory"],
      vectorEnabled: false,
      ...overrides,
    });

  let release: (() => void) | undefined;
  afterEach(async () => {
    release?.();
    release = undefined;
    await managers.closeAllMemorySearchManagers();
  });

  /**
   * Registers a workspace whose subscription retires on its own (no abort) for the
   * first `selfEndingSubscriptions` claims, then stays live until closed.
   */
  async function registerSelfEndingWatch(selfEndingSubscriptions: number) {
    const gateway = fixture.paths.workspace;
    const remote = (file: string) => path.join(gateway, file);
    let subscriptions = 0;
    const files: MemoryWorkspaceFiles = {
      assertCurrent() {},
      async listFiles() {
        return await listMemoryFiles(remote("."), [], undefined, undefined);
      },
      async inspectFile() {
        return null;
      },
      readFile: (params) => readMemoryFile({ ...params, workspaceDir: gateway }),
      async readForIndexing(file) {
        return { content: await fs.readFile(file, "utf8") };
      },
      buildMultimodalChunk: async () => null,
      async watch(_request, _onChange, signal) {
        subscriptions += 1;
        if (subscriptions <= selfEndingSubscriptions) {
          // The transport retires without a cancellation request from this owner.
          return;
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    release = registerAgentWorkspaceAccess(gateway, {
      memoryFiles: files,
      bridge: {
        readFile: () => {
          throw new Error("Unexpected document access");
        },
        writeFile: () => {
          throw new Error("Unexpected document access");
        },
        stat: () => {
          throw new Error("Unexpected document access");
        },
      },
    });
    return { subscriptions: () => subscriptions };
  }

  it("re-subscribes when the remote subscription ends without an abort", async () => {
    const watch = await registerSelfEndingWatch(1);

    const manager = await fixture.getFreshManager(createConfig());
    await vi.waitFor(() => expect(watch.subscriptions()).toBe(2), { timeout: 10_000 });

    await manager.close();
  });

  it("keeps the search fallback instead of retrying forever", async () => {
    const watch = await registerSelfEndingWatch(Number.POSITIVE_INFINITY);

    const manager = await fixture.getFreshManager(createConfig());
    await vi.waitFor(() => expect(watch.subscriptions()).toBe(2), { timeout: 10_000 });
    // A transport that keeps retiring must settle after the bounded re-subscription.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    expect(watch.subscriptions()).toBe(2);

    await manager.close();
  });
});
