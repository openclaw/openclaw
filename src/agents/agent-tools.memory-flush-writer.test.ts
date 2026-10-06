import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertMemoryAudienceSession,
  delegateMemoryAudience,
  resolveMemoryAudienceFromEntry,
} from "../plugins/memory-audience.js";
import { fakeSessionOwner } from "../plugins/memory-audience.test-support.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";

const warnings = vi.hoisted(() => [] as string[]);

vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } =
    await import("../plugins/memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
vi.mock("../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } = await import("../plugins/memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    logWarn: (message: unknown, ...rest: unknown[]) => {
      warnings.push(String(message));
      return actual.logWarn(message as never, ...(rest as never[]));
    },
  };
});

import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { MemoryFlushToolsUnavailableError } from "./agent-tools.memory-flush.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { runWithAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";

const MEMORY_PATH = "memory/2026-08-22.md";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Concrete plugin metadata lets the production projection distinguish equal tool names.
function persistenceTool(pluginId: string, name = "save_memory"): AnyAgentTool {
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: "Persist a memory",
    parameters: { type: "object", properties: {} },
    execute: vi.fn<AnyAgentTool["execute"]>(async () => ({
      content: [{ type: "text", text: "saved" }],
      details: {},
    })),
  };
  setPluginToolMeta(tool, { pluginId, optional: false });
  return tool;
}

// Exercise the full assembly and policy boundary with a lightweight plugin tool factory.
function assembleProviderFlush(tools: AnyAgentTool[], options: OpenClawCodingToolsOptions = {}) {
  vi.mocked(createOpenClawTools).mockReturnValueOnce(tools);
  const recordPersistenceToolSuccess = vi.fn();
  const assembled = createOpenClawCodingTools({
    workspaceDir: tempDirs.make("openclaw-provider-flush-"),
    trigger: "memory",
    senderIsOwner: false,
    wrapBeforeToolCallHook: false,
    memoryFlushTools: {
      flushId: "same-compaction-cycle",
      ownerPluginId: "memory-provider",
      persistenceToolNames: ["save_memory"],
      lookupToolNames: [],
      recordPersistenceToolSuccess,
    },
    ...options,
  });
  return { assembled, recordPersistenceToolSuccess };
}

describe("memory flush writer availability", () => {
  afterEach(() => {
    warnings.length = 0;
    vi.mocked(createOpenClawTools).mockClear();
  });

  it("projects read and the declared owner's writer, excluding same-name foreign tools", async () => {
    const foreign = persistenceTool("sidecar");
    const owned = persistenceTool("memory-provider");
    const undeclared = persistenceTool("memory-provider", "delete_memory");
    const { assembled } = assembleProviderFlush([foreign, owned, undeclared]);

    expect(assembled.map((tool) => tool.name).toSorted()).toEqual(["read", "save_memory"]);
    await assembled.find((tool) => tool.name === "save_memory")!.execute("save-call", {});
    expect(owned.execute).toHaveBeenCalledOnce();
    expect(foreign.execute).not.toHaveBeenCalled();
    expect(undeclared.execute).not.toHaveBeenCalled();
  });

  it("warns once when policy removes declared lookup tools and keeps the flush runnable", () => {
    const { assembled } = assembleProviderFlush(
      [
        persistenceTool("memory-provider"),
        persistenceTool("memory-provider", "find_memory"),
        persistenceTool("memory-provider", "get_memory"),
      ],
      {
        config: { tools: { deny: ["get_memory"] } },
        memoryFlushTools: {
          flushId: "same-compaction-cycle",
          ownerPluginId: "memory-provider",
          persistenceToolNames: ["save_memory"],
          lookupToolNames: ["find_memory", "get_memory"],
          recordPersistenceToolSuccess: vi.fn(),
        },
      },
    );

    expect(assembled.map((tool) => tool.name).toSorted()).toEqual([
      "find_memory",
      "read",
      "save_memory",
    ]);
    expect(warnings).toEqual([
      expect.stringContaining(
        'plugin "memory-provider" flush cannot check for existing memory: get_memory',
      ),
    ]);
  });

  it("does not reintroduce harness setup tools outside the provider flush projection", () => {
    const { assembled } = runWithAgentRingZeroTools([persistenceTool("host", "openclaw")], () =>
      assembleProviderFlush([persistenceTool("memory-provider")]),
    );
    expect(assembled.map((tool) => tool.name).toSorted()).toEqual(["read", "save_memory"]);
  });

  it("carries the delegated audience and only the public flush identity into plugin context", async () => {
    const sessionId = "3a17bcec-6331-4b0e-aac7-b7e1b9da2ad9";
    const sourceKey = "agent:main:direct:owner";
    const flushKey = "agent:main:memory-flush:detached";
    const storePath = "/tmp/openclaw-memory-flush/main.sqlite";
    const sourceEntry = { sessionId, updatedAt: 1, chatType: "direct" as const };
    fakeSessionOwner.reset();
    fakeSessionOwner.rows.set(sourceKey, sourceEntry);
    const sourceAudience = await resolveMemoryAudienceFromEntry(
      { agentId: "main", sessionKey: sourceKey, sessionId, senderIsOwner: true, storePath },
      sourceEntry,
    );
    if (sourceAudience.status !== "granted") {
      throw new Error(sourceAudience.reason);
    }
    const { audience: delegatedAudience } = await delegateMemoryAudience(sourceAudience.audience, {
      sessionKey: flushKey,
      storePath,
      detached: true,
    });
    assembleProviderFlush([persistenceTool("memory-provider")], {
      sessionKey: flushKey,
      memoryAudience: delegatedAudience,
    });
    const options = vi.mocked(createOpenClawTools).mock.lastCall?.[0];
    const { context } = resolveOpenClawPluginToolInputs({ options });

    expect(context.sessionKey).toBe(flushKey);
    expect(context.senderIsOwner).toBe(false);
    expect(context.memoryAudience).toEqual({ kind: "owner-private", agentId: "main" });
    expect(() => assertMemoryAudienceSession(context.memoryAudience!, flushKey)).not.toThrow();
    expect(() => assertMemoryAudienceSession(context.memoryAudience!, sourceKey)).toThrow(
      "different session",
    );
    expect(() => context.assertMemoryAudienceCurrent?.()).not.toThrow();
    expect(context.memoryFlush).toStrictEqual({ flushId: "same-compaction-cycle" });
  });

  it("refuses inference when transport policy removes every persistence tool", () => {
    expect(() =>
      assembleProviderFlush([persistenceTool("memory-provider")], { messageProvider: "node" }),
    ).toThrow(MemoryFlushToolsUnavailableError);
  });

  it("rejects an empty declaration without an owned writer", () => {
    expect(() =>
      assembleProviderFlush([], {
        memoryFlushTools: {
          flushId: "same-compaction-cycle",
          ownerPluginId: "memory-provider",
          persistenceToolNames: [],
          recordPersistenceToolSuccess: vi.fn(),
        },
      }),
    ).toThrow(MemoryFlushToolsUnavailableError);
  });

  it("records persistence only after an owned tool completes successfully", async () => {
    const result = { content: [{ type: "text" as const, text: "saved" }], details: {} };
    const completion = createDeferred<typeof result>();
    const owned = persistenceTool("memory-provider");
    vi.mocked(owned.execute).mockReturnValue(completion.promise);
    const { assembled, recordPersistenceToolSuccess } = assembleProviderFlush([owned]);
    const writer = assembled.find((tool) => tool.name === "save_memory")!;
    const pending = writer.execute("save-call", {});
    expect(recordPersistenceToolSuccess).not.toHaveBeenCalled();
    completion.resolve(result);
    await expect(pending).resolves.toEqual(result);
    expect(recordPersistenceToolSuccess).toHaveBeenCalledOnce();
  });

  it.each(["returns an error", "returns isError"])(
    "does not record persistence when a tool %s",
    async (failure) => {
      const owned = persistenceTool("memory-provider");
      const result = {
        content: [{ type: "text" as const, text: "provider write failed" }],
        ...(failure === "returns isError"
          ? { isError: true, details: {} }
          : { details: { status: "error", error: "provider write failed" } }),
      };
      vi.mocked(owned.execute).mockResolvedValue(result);
      const { assembled, recordPersistenceToolSuccess } = assembleProviderFlush([owned]);
      const call = assembled.find((tool) => tool.name === "save_memory")!.execute("save-call", {});
      await expect(call).resolves.toMatchObject(
        failure === "returns isError" ? { isError: true } : { details: { status: "error" } },
      );
      expect(recordPersistenceToolSuccess).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "denied by policy",
      config: { tools: { deny: ["write"] } },
      messageProvider: undefined,
      writable: false,
      warning: true,
    },
    {
      name: "excluded by transport",
      config: undefined,
      messageProvider: "node",
      writable: false,
      warning: false,
    },
  ])("reports a writer $name", ({ config, messageProvider, writable, warning }) => {
    const tools = createOpenClawCodingTools({
      workspaceDir: tempDirs.make("openclaw-flush-writer-"),
      config,
      messageProvider,
      trigger: "memory",
      memoryFlushWritePath: MEMORY_PATH,
      senderIsOwner: true,
    });
    expect(tools.some((tool) => tool.name === "write")).toBe(writable);
    const flushWarnings = warnings.filter((line) => line.includes("memory flush cannot persist"));
    expect(flushWarnings).toEqual(warning ? [expect.stringContaining(MEMORY_PATH)] : []);
  });
});
