import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { LegacyMainSessionMigrationResult } from "../config/sessions/legacy-main-session-migration.contract.js";
import { FsSafeError, type ReadResult } from "../infra/fs-safe.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";

const identityStat = statSync(new URL(import.meta.url));

function identityReadResult(content: string): ReadResult {
  return {
    buffer: Buffer.from(content),
    containment: "best-effort",
    realPath: "/tmp/work/IDENTITY.md",
    exactIdentity: { dev: 1n, ino: 1n },
    stat: identityStat,
  };
}

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  postgresAgent: false,
  configuredTargets: vi.fn(),
  inspectRetainedStore: vi.fn(),
  persisted: {} as Record<string, unknown>,
  transformConfigFileWithRetry: vi.fn(),
  withConfigMutationExclusive: vi.fn(),
  parseBindingSpecs: vi.fn(),
  ensureAgentWorkspace: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveAgentDir: vi.fn(),
  rootRead: vi.fn<() => Promise<ReadResult>>(),
  rootWrite: vi.fn(),
  mkdir: vi.fn(),
  recordAgentProvenance: vi.fn(),
  readAgentDeletionJournal: vi.fn(() => undefined as Record<string, unknown> | undefined),
  claimCompletedAgentDeletion: vi.fn(() => true),
  migrateLegacyMainSessionKeys: vi.fn(),
  prepareSharedAuthStoreOwnership: vi.fn(),
  provisionDefaultProactiveJob: vi.fn(async () => undefined),
}));

vi.mock("node:fs/promises", () => ({ default: { mkdir: mocks.mkdir } }));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
  withConfigMutationExclusive: mocks.withConfigMutationExclusive,
}));

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

// mock-isolation: Creation/config unit cases leave real provisioning to Cron integration coverage.
vi.mock("../cron/default-proactive-job.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cron/default-proactive-job.js")>()),
  provisionDefaultProactiveJob: mocks.provisionDefaultProactiveJob,
}));

// mock-isolation: Workspace/config unit cases do not own a real SQLite worker or creation store.
vi.mock("../state/openclaw-agent-execution.js", () => ({
  prepareOpenClawAgentDatabaseExecution: async () => {},
}));

vi.mock("../infra/database-engine/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/database-engine/context.js")>()),
  getDatabaseEngineInput: () => (mocks.postgresAgent ? { schemaPrefix: "fixture" } : undefined),
}));
vi.mock("../config/sessions/targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/targets.js")>()),
  resolveConfiguredAgentDatabaseTargets: mocks.configuredTargets,
}));
// mock-isolation: Store facts are external I/O; this suite proves creation's effect boundary.
vi.mock("../state/openclaw-agent-schema-inspection-worker.js", () => ({
  createAgentSchemaInspectionWorker: () => ({
    inspect: mocks.inspectRetainedStore,
    [Symbol.asyncDispose]: async () => {},
  }),
}));

vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: mocks.migrateLegacyMainSessionKeys,
}));

vi.mock("./auth-profiles/path-resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-profiles/path-resolve.js")>()),
  prepareSharedAuthStoreOwnership: mocks.prepareSharedAuthStoreOwnership,
}));

vi.mock("./workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace.js")>()),
  ensureAgentWorkspace: mocks.ensureAgentWorkspace,
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: (agentId: string) => `/tmp/transcripts-${agentId}`,
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  root: vi.fn(async () => ({ read: mocks.rootRead, write: mocks.rootWrite })),
}));

import { assertRetainedPostgresAgentStores } from "./agent-create-retained-postgres.js";
import { checkAgentCreationGate, createAgent } from "./agent-create.js";

function migration(overrides: Partial<LegacyMainSessionMigrationResult> = {}) {
  return {
    armed: true,
    changes: [],
    complete: true,
    ledgerComplete: true,
    legacyAgentId: "main",
    mainKey: "main",
    warnings: [],
    outcomes: [{ kind: "no-legacy-rows", detail: "matching completed ledger" }],
    ...overrides,
  };
}

function roster(entries: Record<string, object> = { main: {} }) {
  return { agents: { entries } };
}

function expectCreation(params: Parameters<typeof createAgent>[0], expected: object) {
  return expect(createAgent(params)).resolves.toMatchObject(expected);
}

function expectError(reason: string, name = "researcher", doctor = false) {
  return expectCreation(
    { name },
    {
      status: "error",
      reason,
      ...(doctor ? { message: expect.stringContaining("openclaw doctor --fix") } : {}),
    },
  );
}

function workspace(dir = "/tmp/default-researcher", bootstrapPending = false) {
  mocks.ensureAgentWorkspace.mockResolvedValue({ dir, bootstrapPending });
}

function deletion(cleanupCompleted: boolean) {
  mocks.readAgentDeletionJournal.mockReturnValue({ operationId: "delete-1", cleanupCompleted });
}

type Transform = (
  config: Record<string, unknown>,
  context: unknown,
) => Promise<{
  nextConfig: Record<string, unknown>;
  result: unknown;
}>;
const transformCurrent = (transform: Transform) =>
  transform(structuredClone(mocks.config), { snapshot: { exists: false }, previousHash: null });

describe("createAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config = roster();
    mocks.postgresAgent = false;
    mocks.configuredTargets.mockReturnValue([]);
    mocks.inspectRetainedStore.mockResolvedValue(null);
    mocks.persisted = {};
    mocks.readAgentDeletionJournal.mockReturnValue(undefined);
    mocks.claimCompletedAgentDeletion.mockReturnValue(true);
    mocks.migrateLegacyMainSessionKeys.mockResolvedValue(migration({ ownerAgentId: "researcher" }));
    mocks.prepareSharedAuthStoreOwnership.mockResolvedValue({ location: "state-db" });
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/default-researcher");
    mocks.resolveAgentDir.mockReturnValue("/tmp/agent-researcher");
    mocks.ensureAgentWorkspace.mockImplementation(async ({ dir }: { dir: string }) => ({
      dir,
      bootstrapPending: true,
    }));
    mocks.rootRead.mockResolvedValue(identityReadResult(""));
    mocks.rootWrite.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.parseBindingSpecs.mockReturnValue({ bindings: [], errors: [] });
    mocks.withConfigMutationExclusive.mockImplementation(
      async (fn: (config: Record<string, unknown>) => Promise<unknown>) => await fn(mocks.config),
    );
    mocks.transformConfigFileWithRetry.mockImplementation(
      async ({ transform }: { transform: Transform }) => {
        const transformed = await transformCurrent(transform);
        mocks.persisted = transformed.nextConfig;
        mocks.config = transformed.nextConfig;
        return { path: "/tmp/created-config.json", ...transformed };
      },
    );
  });

  it.each(["missing", "empty", "mismatched"])(
    "refuses a %s retained PostgreSQL store before creation effects",
    async (kind) => {
      mocks.postgresAgent = true;
      const anchor = fileURLToPath(import.meta.url);
      mocks.configuredTargets.mockReturnValue([{ agentId: "researcher", path: anchor }]);
      if (kind === "missing") {
        mocks.inspectRetainedStore.mockResolvedValue({ version: 0 });
      } else {
        mocks.inspectRetainedStore.mockResolvedValue({
          version: OPENCLAW_AGENT_SCHEMA_VERSION,
          agentSchemaMeta:
            kind === "empty"
              ? null
              : {
                  agentId: "another-agent",
                  role: "agent",
                  schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
                },
        });
      }
      const result = await createAgent({ name: "researcher" });
      expect(result).toMatchObject({ status: "error", reason: "already-exists" });
      expect("message" in result && result.message).toEqual(expect.stringContaining(anchor));
      expect("message" in result && result.message).toEqual(
        expect.stringContaining("openclaw backup restore"),
      );
      expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
      expect(mocks.mkdir).not.toHaveBeenCalled();
      expect(mocks.persisted).toEqual({});
      expect(await checkAgentCreationGate("researcher")).toMatchObject({ status: "error" });
    },
  );

  it.each(["throw", "reason", "failure"] as const)(
    "reports an unverifiable PostgreSQL store (%s) without discard advice",
    async (kind) => {
      mocks.postgresAgent = true;
      const anchor = fileURLToPath(import.meta.url);
      const cause = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      mocks.configuredTargets.mockReturnValue([{ agentId: "researcher", path: anchor }]);
      if (kind === "throw") {
        mocks.inspectRetainedStore.mockRejectedValue(cause);
      } else {
        mocks.inspectRetainedStore.mockResolvedValue({
          version: OPENCLAW_AGENT_SCHEMA_VERSION,
          ...(kind === "reason" ? { reason: cause.message } : { failure: cause }),
        });
      }
      const result = await createAgent({ name: "researcher" });
      expect(result).toMatchObject({ status: "error", reason: "already-exists" });
      const message = "message" in result ? result.message : "";
      expect(message).toContain(`could not verify retained PostgreSQL store "${anchor}"`);
      expect(message).toContain(cause.message);
      expect(message).toContain("database.postgres.connection");
      expect(message).toContain(
        "If the server is correct and this store's namespace is gone, see https://docs.openclaw.ai/gateway/postgresql#recover-a-retained-agent-store.",
      );
      expect(message).not.toMatch(/backup restore|move this anchor|sidecars/);
      expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
      expect(mocks.mkdir).not.toHaveBeenCalled();
      expect(mocks.persisted).toEqual({});
      if (kind !== "reason") {
        await expect(
          assertRetainedPostgresAgentStores({ config: roster(), agentId: "researcher" }),
        ).rejects.toHaveProperty("cause", cause);
      }
    },
  );

  it.each(["unanchored", "retained"])("creates with a %s PostgreSQL store", async (kind) => {
    mocks.postgresAgent = true;
    mocks.configuredTargets.mockReturnValue([
      { agentId: "researcher", path: fileURLToPath(import.meta.url) },
    ]);
    if (kind === "retained") {
      mocks.inspectRetainedStore.mockResolvedValue({
        version: OPENCLAW_AGENT_SCHEMA_VERSION,
        agentSchemaMeta: {
          agentId: "researcher",
          role: "agent",
          schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      });
    }
    await expectCreation({ name: "researcher" }, { status: "created", agentId: "researcher" });
  });

  it("returns validation errors before mutation", async () => {
    await expectError("invalid-name", "  ");
    await expectError("invalid-name", "###");
    for (const name of ["OpenClaw", "crestodian"]) {
      await expectError("reserved-id", name);
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
    mocks.config = roster({ robby: { id: "robby" } });
    mocks.migrateLegacyMainSessionKeys.mockResolvedValueOnce(
      migration({
        armed: outcome.armed,
        complete: false,
        ledgerComplete: false,
        outcomes: [
          {
            ...outcome,
            paths:
              "paths" in outcome && outcome.paths
                ? [...outcome.paths]
                : ["/tmp/legacy.sqlite", "/tmp/owner.sqlite"],
            sourceKeys: ["agent:main:main", "agent:robby:main"],
          },
        ],
      }),
    );

    await expectError("legacy-session-migration-required", "main", true);
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("rejects main while its agent database still owns shared auth", async () => {
    mocks.config = roster({ robby: { id: "robby" } });
    mocks.prepareSharedAuthStoreOwnership.mockResolvedValueOnce({ location: "legacy-main" });

    await expectError("shared-auth-store-owned-by-main", "main", true);
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("creates main when an unarmed scan proves every legacy store clean", async () => {
    mocks.config = roster({ robby: { id: "robby" } });
    mocks.migrateLegacyMainSessionKeys.mockResolvedValueOnce(
      migration({
        armed: false,
        ledgerComplete: false,
        outcomes: [{ kind: "no-legacy-rows", detail: "no configured owner" }],
      }),
    );

    await expectCreation({ name: "main" }, { status: "created", agentId: "main" });
    expect(mocks.prepareSharedAuthStoreOwnership).toHaveBeenCalledOnce();
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
  });

  it("rejects guided staging whose original revision no longer owns creation", async () => {
    await expect(
      createAgent({
        entry: { id: "researcher" },
        stagedConfig: {
          config: roster({ researcher: {} }),
          writeSnapshot: {
            snapshot: { ...createTestConfigSnapshot({}), hash: "stale-revision" },
            writeOptions: {},
          },
        },
      }),
    ).rejects.toThrow("config changed before agent creation or restoration");
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
    expect(mocks.persisted).toHaveProperty("agents.entries.robby.workspace", "/tmp/robby");
    expect(mocks.persisted).not.toHaveProperty("agents.entries.main");
  });

  it("preserves the staged model over the explicit parameter when workspace setup normalizes the path", async () => {
    workspace("/normalized/work", true);

    await createAgent({
      entry: {
        id: "researcher",
        name: "Researcher",
        workspace: "/staged/work",
        model: "openai/staged",
      },
      model: "openai/parameter",
    });

    expect(mocks.persisted).toMatchObject(
      roster({
        researcher: { model: "openai/staged", workspace: "/normalized/work" },
      }),
    );
  });

  it("provisions the injected main roster only through a bootstrap entry", async () => {
    await expectCreation(
      {
        entry: { id: "main", name: "main", workspace: "/tmp/main-work" },
        bootstrapMain: true,
      },
      { status: "existing", agentId: "main" },
    );
    expect(mocks.ensureAgentWorkspace).toHaveBeenCalledOnce();
    expect(mocks.persisted).toHaveProperty("agents.entries.main.workspace", "/tmp/main-work");
  });

  it("does not materialize a minimal main entry from a persisted snapshot", async () => {
    mocks.resolveAgentWorkspaceDir.mockReturnValueOnce("/tmp/persisted");
    mocks.transformConfigFileWithRetry.mockImplementationOnce(async ({ transform }) => {
      const transformed = await transform(structuredClone(mocks.config), {
        snapshot: { exists: true },
      });
      return { ...transformed, result: transformed.result };
    });

    await expectCreation(
      {
        entry: { id: "main", workspace: "/tmp/replacement" },
        bootstrapMain: true,
      },
      { status: "existing", workspace: "/tmp/persisted" },
    );
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("prepares staged config effects after setup and immediately before publication", async () => {
    workspace();
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
      await transformCurrent(transform);
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

    await expectError("unsafe-identity-file");
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.persisted).not.toHaveProperty("agents");
  });

  it("rechecks creation authority after reading identity and before writing it", async () => {
    workspace("/tmp/work");
    const closed = new Error("creation authority closed");
    const beforePersistentApply = vi.fn();
    mocks.rootRead.mockImplementationOnce(async () => {
      await Promise.resolve();
      beforePersistentApply.mockImplementation(() => {
        throw closed;
      });
      return identityReadResult("# Identity\n");
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
    deletion(false);

    await expectError("deletion-pending");
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("claims a recovered completed tombstone only once for an existing roster entry", async () => {
    mocks.config = roster({ main: {}, researcher: {} });
    deletion(true);

    await expectError("already-exists");
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

    await expectCreation(
      {
        name: "researcher",
        bindingSpecs: ["removed"],
        transformConfig: transformConfig as never,
      },
      { status: "error", reason: "invalid-bindings" },
    );
    expect(mocks.parseBindingSpecs).toHaveBeenCalledOnce();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });
});
