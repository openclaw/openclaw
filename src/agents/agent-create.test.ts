import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import { FsSafeError } from "../infra/fs-safe.js";

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  persisted: {} as Record<string, unknown>,
  transformConfigFileWithRetry: vi.fn(),
  withConfigMutationExclusive: vi.fn(),
  parseBindingSpecs: vi.fn(),
  ensureAgentWorkspace: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveAgentDir: vi.fn(),
  rootRead: vi.fn(),
  rootWrite: vi.fn(),
  mkdir: vi.fn(),
  recordAgentProvenance: vi.fn(),
  readAgentDeletionJournal: vi.fn(() => undefined as Record<string, unknown> | undefined),
  claimCompletedAgentDeletion: vi.fn(() => true),
  migrateLegacyMainSessionKeys: vi.fn(),
  resolveSharedAuthStoreOwnership: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ default: { mkdir: mocks.mkdir } }));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
    withConfigMutationExclusive: mocks.withConfigMutationExclusive,
  };
});

vi.mock("../commands/agents.bindings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/agents.bindings.js")>()),
  parseBindingSpecs: mocks.parseBindingSpecs,
}));

vi.mock("./agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-scope.js")>()),
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveAgentDir: mocks.resolveAgentDir,
}));

vi.mock("./agent-lifecycle-registry.js", () => ({
  claimCompletedAgentDeletion: mocks.claimCompletedAgentDeletion,
}));

// mock-isolation: Creation preconditions use injected tombstones without a real SQLite journal owner.
vi.mock("../state/agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalForCreation: mocks.readAgentDeletionJournal,
  readAgentDeletionRecoveryHoldsInWorker: async () => [],
}));

vi.mock("../state/agent-provenance.js", () => ({
  recordAgentProvenance: mocks.recordAgentProvenance,
}));

vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: mocks.migrateLegacyMainSessionKeys,
}));

vi.mock("./auth-profiles/path-resolve.js", () => ({
  resolveSharedAuthStoreOwnership: mocks.resolveSharedAuthStoreOwnership,
}));

vi.mock("./workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace.js")>();
  return { ...actual, ensureAgentWorkspace: mocks.ensureAgentWorkspace };
});

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: (agentId: string) => `/tmp/transcripts-${agentId}`,
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return {
    ...actual,
    root: vi.fn(async () => ({
      read: mocks.rootRead,
      write: mocks.rootWrite,
    })),
  };
});

import { createAgent } from "./agent-create.js";

describe("createAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config = { agents: { entries: { main: {} } } };
    mocks.persisted = {};
    mocks.readAgentDeletionJournal.mockReturnValue(undefined);
    mocks.claimCompletedAgentDeletion.mockReturnValue(true);
    mocks.migrateLegacyMainSessionKeys.mockResolvedValue({
      armed: true,
      changes: [],
      complete: true,
      ledgerComplete: true,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [{ kind: "no-legacy-rows", detail: "matching completed ledger" }],
      ownerAgentId: "researcher",
      warnings: [],
    });
    mocks.resolveSharedAuthStoreOwnership.mockReturnValue({ location: "state-db" });
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/default-researcher");
    mocks.resolveAgentDir.mockReturnValue("/tmp/agent-researcher");
    mocks.ensureAgentWorkspace.mockImplementation(async ({ dir }: { dir: string }) => ({
      dir,
      bootstrapPending: true,
    }));
    mocks.rootRead.mockResolvedValue({ buffer: Buffer.from("") });
    mocks.rootWrite.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.parseBindingSpecs.mockReturnValue({ bindings: [], errors: [] });
    mocks.withConfigMutationExclusive.mockImplementation(
      async (fn: (config: Record<string, unknown>) => Promise<unknown>) => await fn(mocks.config),
    );
    mocks.transformConfigFileWithRetry.mockImplementation(
      async ({
        transform,
      }: {
        transform: (config: Record<string, unknown>, context: unknown) => Promise<unknown>;
      }) => {
        const transformed = (await transform(structuredClone(mocks.config), {
          snapshot: { exists: false },
          previousHash: null,
        })) as {
          nextConfig: Record<string, unknown>;
          result: unknown;
        };
        mocks.persisted = transformed.nextConfig;
        mocks.config = transformed.nextConfig;
        return {
          path: "/tmp/created-config.json",
          result: transformed.result,
          nextConfig: transformed.nextConfig,
        };
      },
    );
  });

  it("returns validation errors before mutation", async () => {
    await expect(createAgent({ name: "  " })).resolves.toMatchObject({
      status: "error",
      reason: "invalid-name",
    });
    await expect(createAgent({ name: "###" })).resolves.toMatchObject({
      status: "error",
      reason: "invalid-name",
    });
    for (const name of ["OpenClaw", "crestodian"]) {
      await expect(createAgent({ name })).resolves.toMatchObject({
        status: "error",
        reason: "reserved-id",
      });
    }
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "not-armed", armed: false, detail: "owner-unresolved" },
    { kind: "no-legacy-rows", armed: true },
    { kind: "migrated-in-place", armed: true, canonicalKey: "agent:robby:main" },
    { kind: "divergent-aliases", armed: true, canonicalKey: "agent:robby:main" },
    { kind: "legacy-json-store", armed: true, paths: ["/tmp/sessions.json"] },
    { kind: "store-unreadable", armed: true, paths: ["/tmp/store.sqlite"] },
  ] as const)("rejects main while the $kind session outcome is unresolved", async (outcome) => {
    mocks.config = { agents: { entries: { robby: { id: "robby" } } } };
    mocks.migrateLegacyMainSessionKeys.mockResolvedValueOnce({
      armed: outcome.armed,
      changes: [],
      complete: false,
      ledgerComplete: false,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [
        {
          ...outcome,
          paths: "paths" in outcome ? outcome.paths : ["/tmp/legacy.sqlite", "/tmp/owner.sqlite"],
          sourceKeys: ["agent:main:main", "agent:robby:main"],
        },
      ],
      warnings: [],
    });

    await expect(createAgent({ name: "main" })).resolves.toMatchObject({
      status: "error",
      reason: "legacy-session-migration-required",
      message: expect.stringContaining("openclaw doctor --fix"),
    });
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("rejects main while its agent database still owns shared auth", async () => {
    mocks.config = { agents: { entries: { robby: { id: "robby" } } } };
    mocks.resolveSharedAuthStoreOwnership.mockReturnValueOnce({ location: "legacy-main" });

    await expect(createAgent({ name: "main" })).resolves.toMatchObject({
      status: "error",
      reason: "shared-auth-store-owned-by-main",
      message: expect.stringContaining("openclaw doctor --fix"),
    });
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("creates main when an unarmed scan proves every legacy store clean", async () => {
    mocks.config = { agents: { entries: { robby: { id: "robby" } } } };
    mocks.migrateLegacyMainSessionKeys.mockResolvedValueOnce({
      armed: false,
      changes: [],
      complete: true,
      ledgerComplete: false,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [{ kind: "no-legacy-rows", detail: "no configured owner" }],
      warnings: [],
    });

    await expect(createAgent({ name: "main" })).resolves.toMatchObject({
      status: "created",
      agentId: "main",
    });
    expect(mocks.resolveSharedAuthStoreOwnership).toHaveBeenCalledOnce();
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
  });

  it("accepts a complete staged entry", async () => {
    const result = await createAgent({
      entry: {
        id: "researcher",
        name: "Researcher",
        workspace: "/tmp/staged-work",
        agentDir: "/tmp/staged-agent",
        model: "openai/gpt-5.5",
        identity: { name: "Researcher", emoji: "🔎" },
      },
    });

    expect(result).toMatchObject({
      status: "created",
      agentId: "researcher",
      workspace: "/tmp/staged-work",
      agentDir: "/tmp/staged-agent",
    });
    expect(mocks.persisted).toMatchObject({
      agents: {
        entries: {
          researcher: expect.objectContaining({ model: "openai/gpt-5.5" }),
        },
      },
    });
    expect(mocks.persisted.agents).not.toHaveProperty("list");
  });

  it("publishes guided staging and its new agent in one conditional transform", async () => {
    const result = await createAgent({
      entry: {
        id: "researcher",
        name: "Researcher",
        workspace: "/tmp/staged-work",
      },
      stagedConfig: {
        writeSnapshot: { snapshot: createTestConfigSnapshot({}), writeOptions: {} },
        config: {
          agents: {
            entries: {
              main: {},
              researcher: { workspace: "/tmp/staged-work" },
            },
          },
          channels: { telegram: { enabled: true } },
        },
      },
    });

    expect(result).toMatchObject({ status: "created", agentId: "researcher" });
    if (result.status === "error") {
      throw new Error(result.message);
    }
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.persisted).toMatchObject({
      agents: { entries: { main: expect.any(Object), researcher: expect.any(Object) } },
      channels: { telegram: { enabled: true } },
    });
    expect(result.config).toEqual(mocks.persisted);
  });

  it("rejects guided staging whose original revision no longer owns creation", async () => {
    await expect(
      createAgent({
        entry: { id: "researcher" },
        stagedConfig: {
          config: { agents: { entries: { researcher: {} } } },
          writeSnapshot: {
            snapshot: { ...createTestConfigSnapshot({}), hash: "stale-revision" },
            writeOptions: {},
          },
        },
      }),
    ).rejects.toThrow("config changed before first-agent creation");
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("replaces only the load-time compatibility roster when creating a named first agent", async () => {
    await createAgent({
      entry: { id: "robby", name: "robby", workspace: "/tmp/robby" },
      bootstrapFirstAgent: true,
    });

    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        writeOptions: expect.objectContaining({ allowedAgentRosterRemovals: ["main"] }),
      }),
    );
    expect(mocks.persisted).toMatchObject({
      agents: { entries: { robby: expect.objectContaining({ workspace: "/tmp/robby" }) } },
    });
    expect(
      (mocks.persisted.agents as { entries?: Record<string, unknown> }).entries,
    ).not.toHaveProperty("main");
  });

  it("preserves the staged model over the explicit parameter when workspace setup normalizes the path", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValue({
      dir: "/normalized/work",
      bootstrapPending: true,
    });

    await createAgent({
      entry: {
        id: "researcher",
        name: "Researcher",
        workspace: "/staged/work",
        model: "openai/staged",
      },
      model: "openai/parameter",
    });

    expect(mocks.persisted).toMatchObject({
      agents: {
        entries: {
          researcher: expect.objectContaining({
            model: "openai/staged",
            workspace: "/normalized/work",
          }),
        },
      },
    });
  });

  it("provisions the injected main roster only through a bootstrap entry", async () => {
    await expect(
      createAgent({
        entry: {
          id: "main",
          name: "main",
          workspace: "/tmp/main-work",
        },
        bootstrapMain: true,
      }),
    ).resolves.toMatchObject({ status: "existing", agentId: "main" });
    expect(mocks.ensureAgentWorkspace).toHaveBeenCalledOnce();
    expect(mocks.persisted).toMatchObject({
      agents: { entries: { main: expect.objectContaining({ workspace: "/tmp/main-work" }) } },
    });
  });

  it("does not materialize a minimal main entry from a persisted snapshot", async () => {
    mocks.resolveAgentWorkspaceDir.mockReturnValueOnce("/tmp/persisted");
    mocks.transformConfigFileWithRetry.mockImplementationOnce(async ({ transform }) => {
      const transformed = await transform(structuredClone(mocks.config), {
        snapshot: { exists: true },
      });
      return { ...transformed, result: transformed.result };
    });

    await expect(
      createAgent({
        entry: { id: "main", workspace: "/tmp/replacement" },
        bootstrapMain: true,
      }),
    ).resolves.toMatchObject({ status: "existing", workspace: "/tmp/persisted" });
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("prepares staged config effects after setup and immediately before publication", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValue({
      dir: "/tmp/default-researcher",
      bootstrapPending: false,
    });
    const commit = vi.fn();
    const prepareConfigCommit = vi.fn(async () => {
      expect(mocks.ensureAgentWorkspace).toHaveBeenCalledOnce();
      expect(mocks.mkdir).toHaveBeenCalledOnce();
      expect(mocks.rootWrite).toHaveBeenCalledOnce();
      expect(mocks.persisted).not.toHaveProperty("agents");
      return { commit, rollback: vi.fn() };
    });

    await createAgent({ name: "researcher", prepareConfigCommit });

    expect(prepareConfigCommit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(mocks.persisted).toHaveProperty("agents.entries.researcher");
  });

  it("rolls staged config effects back once when config publication fails", async () => {
    const rollback = vi.fn();
    const commit = vi.fn();
    const prepareConfigCommit = vi.fn(async () => ({ commit, rollback }));
    mocks.transformConfigFileWithRetry.mockImplementationOnce(async ({ transform }) => {
      await transform(structuredClone(mocks.config), {
        snapshot: { exists: false },
        previousHash: null,
      });
      throw new Error("injected config commit failure");
    });

    await expect(createAgent({ name: "researcher", prepareConfigCommit })).rejects.toThrow(
      "injected config commit failure",
    );

    expect(prepareConfigCommit).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("does not publish config when identity setup is unsafe", async () => {
    mocks.ensureAgentWorkspace.mockImplementation(async ({ dir }: { dir: string }) => ({
      dir,
      bootstrapPending: false,
    }));
    mocks.rootRead.mockRejectedValue(new FsSafeError("invalid-path", "unsafe identity path"));

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "error",
      reason: "unsafe-identity-file",
    });
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.persisted).not.toHaveProperty("agents");
  });

  it("rechecks creation authority after reading identity and before writing it", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValue({ dir: "/tmp/work", bootstrapPending: false });
    const closed = new Error("creation authority closed");
    const beforePersistentApply = vi.fn();
    mocks.rootRead.mockImplementationOnce(async () => {
      await Promise.resolve();
      beforePersistentApply.mockImplementation(() => {
        throw closed;
      });
      return { buffer: Buffer.from("# Identity\n") };
    });
    const prepareConfigCommit = vi.fn();

    await expect(
      createAgent({ name: "researcher", beforePersistentApply, prepareConfigCommit }),
    ).rejects.toThrow(closed);
    expect(mocks.rootWrite).not.toHaveBeenCalled();
    expect(prepareConfigCommit).not.toHaveBeenCalled();
    expect(mocks.persisted).not.toHaveProperty("agents");
  });

  it("does not recreate an id with pending deletion cleanup", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue({
      operationId: "delete-1",
      cleanupCompleted: false,
    });

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "error",
      reason: "deletion-pending",
    });
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("claims a completed deletion tombstone after recreating the id", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue({
      operationId: "delete-1",
      cleanupCompleted: true,
    });

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "created",
      agentId: "researcher",
    });
    expect(mocks.claimCompletedAgentDeletion).toHaveBeenCalledWith("researcher", "delete-1");
  });

  it("claims a recovered completed tombstone only once for an existing roster entry", async () => {
    mocks.config = {
      agents: { entries: { main: {}, researcher: {} } },
    };
    mocks.readAgentDeletionJournal.mockReturnValue({
      operationId: "delete-1",
      cleanupCompleted: true,
    });

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "error",
      reason: "already-exists",
    });
    expect(mocks.claimCompletedAgentDeletion).toHaveBeenCalledTimes(1);
  });

  it("parses binding specs from the locked winning snapshot", async () => {
    mocks.parseBindingSpecs.mockReturnValue({
      bindings: [],
      errors: ['Unknown channel "removed".'],
    });
    const transformConfig = vi.fn(async ({ maxAttempts, transform }) => {
      expect(maxAttempts).toBe(1);
      return await transform({ agents: { entries: { main: {} } } });
    });

    await expect(
      createAgent({
        name: "researcher",
        bindingSpecs: ["removed"],
        transformConfig: transformConfig as never,
      }),
    ).resolves.toMatchObject({ status: "error", reason: "invalid-bindings" });
    expect(mocks.parseBindingSpecs).toHaveBeenCalledOnce();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });
});
