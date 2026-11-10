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
import { stubTool } from "./test-helpers/fast-tool-stubs.js";

const MEMORY_PATH = "memory/2026-08-22.md";
const savedResult = { content: [{ type: "text" as const, text: "saved" }], details: {} };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function persistenceTool(pluginId = "memory-provider", name = "save_memory"): AnyAgentTool {
  const tool: AnyAgentTool = {
    ...stubTool(name),
    label: name,
    execute: vi.fn<AnyAgentTool["execute"]>(async () => savedResult),
  };
  setPluginToolMeta(tool, { pluginId, optional: false });
  return tool;
}

function assembleProviderFlush(
  tools: AnyAgentTool[] = [persistenceTool()],
  options: OpenClawCodingToolsOptions = {},
  overrides: Partial<NonNullable<OpenClawCodingToolsOptions["memoryFlushTools"]>> = {},
) {
  vi.mocked(createOpenClawTools).mockReturnValueOnce(tools);
  const memoryFlushTools = {
    flushId: "same-compaction-cycle",
    ownerPluginId: "memory-provider",
    persistenceToolNames: ["save_memory"],
    lookupToolNames: [],
    recordPersistenceToolSuccess: vi.fn(),
    ...overrides,
  };
  const assembled = createOpenClawCodingTools({
    workspaceDir: tempDirs.make("openclaw-provider-flush-"),
    trigger: "memory",
    senderIsOwner: false,
    wrapBeforeToolCallHook: false,
    memoryFlushTools,
    ...options,
  });
  return {
    assembled,
    save: () => assembled.find((tool) => tool.name === "save_memory")!.execute("save-call", {}),
    recordPersistenceToolSuccess: memoryFlushTools.recordPersistenceToolSuccess,
  };
}

function assembleFileFlush(options: OpenClawCodingToolsOptions = {}) {
  return createOpenClawCodingTools({
    workspaceDir: tempDirs.make("openclaw-file-flush-"),
    trigger: "memory",
    memoryFlushWritePath: MEMORY_PATH,
    senderIsOwner: true,
    ...options,
  });
}
const names = (tools: AnyAgentTool[]) => tools.map((tool) => tool.name).toSorted();

describe("memory flush writer availability", () => {
  afterEach(() => {
    warnings.length = 0;
    vi.mocked(createOpenClawTools).mockClear();
  });

  it("projects only read and the declared owner's writer", async () => {
    const foreign = persistenceTool("sidecar");
    const owned = persistenceTool();
    const undeclared = persistenceTool("memory-provider", "delete_memory");
    const { assembled, save } = assembleProviderFlush([foreign, owned, undeclared]);

    expect(names(assembled)).toEqual(["read", "save_memory"]);
    await save();
    expect(owned.execute).toHaveBeenCalledOnce();
    expect(foreign.execute).not.toHaveBeenCalled();
    expect(undeclared.execute).not.toHaveBeenCalled();
  });

  it("warns once for denied lookup but keeps the writer", () => {
    const { assembled } = assembleProviderFlush(
      [
        persistenceTool(),
        persistenceTool("memory-provider", "find_memory"),
        persistenceTool("memory-provider", "get_memory"),
      ],
      { config: { tools: { deny: ["get_memory"] } } },
      { lookupToolNames: ["find_memory", "get_memory"] },
    );

    expect(names(assembled)).toEqual(["find_memory", "read", "save_memory"]);
    expect(warnings).toEqual([
      expect.stringContaining(
        'plugin "memory-provider" flush cannot check for existing memory: get_memory',
      ),
    ]);
  });

  it.each(["provider", "file"] as const)(
    "excludes harness execution tools from %s flush",
    (arm) => {
      const tools = runWithAgentRingZeroTools(
        [persistenceTool("host", "openclaw"), persistenceTool("host", "dispatch_action")],
        () => {
          if (arm === "provider") {
            return assembleProviderFlush().assembled;
          }
          return assembleFileFlush({ includeToolSearchControls: true });
        },
      );
      expect(names(tools)).toEqual(["read", arm === "provider" ? "save_memory" : "write"]);
    },
  );

  it("carries delegated audience and public flush identity", async () => {
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
    assembleProviderFlush(undefined, {
      sessionKey: flushKey,
      memoryAudience: delegatedAudience,
    });
    const options = vi.mocked(createOpenClawTools).mock.lastCall?.[0];
    const { context } = resolveOpenClawPluginToolInputs({ options });

    expect(context).toMatchObject({ sessionKey: flushKey, senderIsOwner: false });
    expect(context.memoryAudience).toEqual({ kind: "owner-private", agentId: "main" });
    expect(() => assertMemoryAudienceSession(context.memoryAudience!, flushKey)).not.toThrow();
    expect(() => assertMemoryAudienceSession(context.memoryAudience!, sourceKey)).toThrow(
      "different session",
    );
    expect(() => context.assertMemoryAudienceCurrent?.()).not.toThrow();
    expect(context.memoryFlush).toStrictEqual({ flushId: "same-compaction-cycle" });
  });

  it.each(["transport", "empty declaration"])("rejects a missing writer: %s", (reason) => {
    const empty = reason === "empty declaration";
    expect(() =>
      assembleProviderFlush(
        empty ? [] : undefined,
        empty ? {} : { messageProvider: "node" },
        empty ? { persistenceToolNames: [] } : {},
      ),
    ).toThrow(MemoryFlushToolsUnavailableError);
  });

  it.each([
    ["success", {}, false, 1],
    ["error status", { status: "error", error: "provider write failed" }, false, 0],
    ["isError", {}, true, 0],
  ] as const)(
    "records only completed successful persistence (%s)",
    async (_name, details, isError, expectedCalls) => {
      const owned = persistenceTool();
      const result = {
        ...savedResult,
        details,
        ...(isError ? { isError } : {}),
      };
      const completion = createDeferred<typeof result>();
      vi.mocked(owned.execute).mockReturnValue(completion.promise);
      const { save, recordPersistenceToolSuccess } = assembleProviderFlush([owned]);
      const call = save();
      expect(recordPersistenceToolSuccess).not.toHaveBeenCalled();
      completion.resolve(result);
      await expect(call).resolves.toEqual(result);
      expect(recordPersistenceToolSuccess).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it.each([
    {
      name: "denied by policy",
      options: { config: { tools: { deny: ["write"] } } },
      warning: true,
    },
    { name: "excluded by transport", options: { messageProvider: "node" }, warning: false },
  ])("reports a writer $name", ({ options, warning }) => {
    const tools = assembleFileFlush(options);
    expect(tools.some((tool) => tool.name === "write")).toBe(false);
    const flushWarnings = warnings.filter((line) => line.includes("memory flush cannot persist"));
    expect(flushWarnings).toEqual(warning ? [expect.stringContaining(MEMORY_PATH)] : []);
  });
});
