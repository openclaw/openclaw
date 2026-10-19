import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcpxRuntime as UpstreamRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
} from "acpx/runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { AcpxRuntime } from "./runtime.js";
import { acpxSessionOwnerMigration } from "./session-owner-migration.js";
import { resolveAcpxSessionResource } from "./session-resource.js";

type Claim = Awaited<
  ReturnType<NonNullable<PluginDoctorStateMigrationContext["inspectAcpSessionClaims"]>>
>["claims"][number];
const directories = useAutoCleanupTempDirTracker(afterEach);
const target = {
  agentId: "work",
  sessionKey: "global",
  agent: "fixture",
  mode: "persistent" as const,
};
afterEach(() => resetPluginStateStoreForTests());

async function expectNoMigrationStaging(sourcePath: string) {
  const files = await fs.readdir(path.dirname(sourcePath));
  expect(files.filter((name) => name.startsWith(".openclaw-owner-"))).toEqual([]);
}

async function runAndClose(
  runtime: UpstreamRuntime | AcpxRuntime,
  handle: Parameters<UpstreamRuntime["runTurn"]>[0]["handle"],
  text: string,
  requestId: string,
  reason = "test-complete",
) {
  const chunks: string[] = [];
  try {
    for await (const event of runtime.runTurn({ handle, text, requestId, mode: "prompt" })) {
      if (event.type === "text_delta") {
        chunks.push(event.text);
      }
    }
    return chunks.join("");
  } finally {
    await runtime.close({ handle, reason });
  }
}

async function expectOwnerRejection(
  runtime: AcpxRuntime,
  input: Parameters<AcpxRuntime["ensureSession"]>[0],
) {
  let adopted: Awaited<ReturnType<AcpxRuntime["ensureSession"]>> | undefined;
  const rejected = { detailCode: "SESSION_OWNER_MIGRATION_REQUIRED" };
  try {
    await expect(
      runtime.ensureSession(input).then((handle) => (adopted = handle)),
    ).rejects.toMatchObject(rejected);
    await expect(runtime.prepareFreshSession(input)).rejects.toMatchObject(rejected);
  } finally {
    if (adopted) {
      await runtime.close({ handle: adopted, reason: "test-cleanup" });
    }
  }
}

async function fixture(mode: "persistent" | "oneshot" = "persistent", sessionKey = "global") {
  const directory = directories.make("acpx-owner-migration-");
  const stateDir = path.join(directory, "acpx");
  const peer = path.join(directory, "peer");
  await fs.mkdir(peer);
  const store = createFileSessionStore({ stateDir });
  const runtimeOptions = {
    cwd: directory,
    sessionStore: store,
    agentRegistry: createAgentRegistry({
      overrides: {
        fixture: [
          process.execPath,
          fileURLToPath(new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url)),
          peer,
        ].join(" "),
      },
    }),
    permissionMode: "deny-all" as const,
    timeoutMs: 5_000,
  };
  const legacy = new UpstreamRuntime(runtimeOptions);
  const handle = await legacy.ensureSession({ sessionKey, agent: "fixture", mode });
  await runAndClose(legacy, handle, "retained history", "before-migration", "offline-migration");
  const file = (id: string) => path.join(stateDir, "sessions", `${encodeURIComponent(id)}.json`);
  const sourcePath = file(handle.acpxRecordId!);
  const read = (recordPath = sourcePath) => fs.readFile(recordPath, "utf8");
  const raw = JSON.parse(await read());
  raw.future_field = { opaque: ["preserve", 42] };
  await fs.writeFile(sourcePath, JSON.stringify(raw));
  const claims: Claim[] = [
    {
      agentId: "work",
      sessionKey: "global",
      binding: { sessionId: "openclaw-session", lifecycleRevision: "revision" },
      meta: {
        backend: "acpx",
        agent: "fixture",
        runtimeSessionName: handle.runtimeSessionName,
        mode,
        state: "idle",
        lastActivityAt: 10,
        identity: {
          state: "resolved",
          source: "ensure",
          lastUpdatedAt: 10,
          acpxRecordId: handle.acpxRecordId,
          acpxSessionId: handle.backendSessionId,
        },
      },
    },
  ];
  const interruption = { publication: false, canonical: false };
  let updated = false;
  const context: PluginDoctorStateMigrationContext = {
    openPluginStateKeyedStore: (options) =>
      createPluginStateKeyedStoreForTests("acpx", {
        ...options,
        env: { ...process.env, OPENCLAW_STATE_DIR: directory },
      }),
    inspectAcpSessionClaims: async () => ({
      claims: structuredClone(claims),
      incomplete: interruption.canonical && updated ? ["interrupted after canonical update"] : [],
    }),
    updateAcpSessionIdentity(input) {
      if (interruption.publication) {
        throw new Error("interrupted after publication");
      }
      expect(claims[0]).toEqual(input.claim);
      claims[0]!.meta.runtimeSessionName = input.runtimeSessionName;
      claims[0]!.meta.identity!.acpxRecordId = input.acpxRecordId;
      updated = true;
    },
  };
  const input = {
    config: {},
    env: { ...process.env, OPENCLAW_STATE_DIR: directory },
    stateDir: directory,
    oauthDir: path.join(directory, "oauth"),
    serviceWorkspaceDir: directory,
    context,
  };
  return {
    claims,
    file,
    handle,
    input,
    raw,
    sourcePath,
    runtimeOptions,
    interruption,
    migrate: () => acpxSessionOwnerMigration.migrateLegacyState(input),
    read,
    runtime: (legacyKeys?: string[]) =>
      new AcpxRuntime({
        ...runtimeOptions,
        openclawLegacyBareSessionKeys: new Set(legacyKeys),
      }),
    async expectPublished() {
      const resource = resolveAcpxSessionResource(claims[0]!);
      await expectNoMigrationStaging(sourcePath);
      expect(JSON.parse(await read(file(resource)))).toEqual({
        ...raw,
        name: resource,
        acpx_record_id: resource,
      });
      return resource;
    },
    async expectRetained() {
      await expectNoMigrationStaging(sourcePath);
      expect(JSON.parse(await read())).toEqual(raw);
    },
  };
}

it.each([
  ["publication", "interrupted after publication"],
  ["canonical", "stored metadata verification failed"],
] as const)(
  "preserves raw history and resumes idempotently after interruption=%s",
  async (interrupted, warning) => {
    const f = await fixture();
    f.interruption[interrupted] = true;
    expect((await f.migrate()).warnings).toEqual([expect.stringContaining(warning)]);
    await f.expectRetained();
    f.interruption[interrupted] = false;
    expect((await f.migrate()).warnings).toEqual([]);
    const resource = await f.expectPublished();
    expect(JSON.parse(await f.read(`${f.sourcePath}.migrated`))).toEqual(f.raw);
    expect(decodeAcpxRuntimeHandleState(f.claims[0]!.meta.runtimeSessionName)).toMatchObject({
      name: resource,
      acpxRecordId: resource,
    });
    expect(await f.migrate()).toEqual({ changes: [], warnings: [] });
    const runtime = f.runtime();
    const handle = await runtime.ensureSession({
      ...target,
      persistedHandle: {
        ...f.handle,
        agentId: "work",
        runtimeSessionName: f.claims[0]!.meta.runtimeSessionName,
        acpxRecordId: resource,
      },
    });
    const response = await runAndClose(runtime, handle, "after-migration", "after");
    expect(JSON.parse(response)).toMatchObject({
      history: ["retained history", "after-migration"],
    });
  },
);

it.each(["ambiguous", "missing", "event-log", "conflict", "live"])(
  "leaves %s records intact",
  async (scenario) => {
    const f = await fixture();
    const resource = resolveAcpxSessionResource(f.claims[0]!);
    if (scenario === "ambiguous") {
      f.claims.push({ ...structuredClone(f.claims[0]!), agentId: "main" });
    }
    if (scenario === "missing") {
      f.claims.length = 0;
    }
    if (scenario === "event-log") {
      f.raw.event_log = {};
    }
    if (scenario === "live") {
      f.raw.pid = process.pid;
    }
    if (scenario === "conflict") {
      await fs.writeFile(f.file(resource), '{"conflict":true}');
    }
    await fs.writeFile(f.sourcePath, JSON.stringify(f.raw));
    const before = await f.read();
    const result = await f.migrate();
    expect(result.warnings.length).toBeGreaterThan(0);
    if (scenario === "event-log") {
      expect(result.warnings).toEqual([
        expect.stringContaining("rekey would alter interpreted history/event references"),
      ]);
    }
    expect(result.changes).toEqual([]);
    await expectNoMigrationStaging(f.sourcePath);
    expect(await f.read()).toBe(before);
    if (scenario === "conflict") {
      expect(await f.read(f.file(resource))).toBe('{"conflict":true}');
    }
  },
);

it.each(["runtime", "doctor"])(
  "%s rejects an unclaimed legacy record whose raw key looks owner-qualified",
  async (boundary) => {
    const resource = resolveAcpxSessionResource(target);
    const f = await fixture("persistent", resource);
    f.claims.length = 0;
    const before = await f.read();
    if (boundary === "doctor") {
      expect(await acpxSessionOwnerMigration.detectLegacyState(f.input)).not.toBeNull();
      expect((await f.migrate()).warnings).toEqual([
        expect.stringContaining("exactly one current owner claim is required"),
      ]);
    } else {
      await expectOwnerRejection(f.runtime([resource]), target);
    }
    expect(await f.read()).toBe(before);
  },
);

it.each([false, true])(
  "recreates a deleted bare session with fresh history (new runtime: %s)",
  async (restart) => {
    const resource = resolveAcpxSessionResource(target);
    const f = await fixture("persistent", resource);
    const runtime = f.runtime([resource]);
    await runtime.close({
      handle: { ...f.handle, ...target },
      reason: "session-delete",
      discardPersistentState: true,
    });
    expect(await f.runtimeOptions.sessionStore.load(f.handle.acpxRecordId!)).toMatchObject({
      closed: true,
      closedAt: expect.any(String),
      acpx: { reset_on_next_ensure: true },
    });
    const recreatedRuntime = restart ? f.runtime() : runtime;
    const fresh = await recreatedRuntime.ensureSession(target);
    const response = await runAndClose(recreatedRuntime, fresh, "recreated", "after-delete");
    expect(fresh.backendSessionId).not.toBe(f.handle.backendSessionId);
    expect(JSON.parse(response)).toMatchObject({ history: ["recreated"] });
  },
);

it("keeps oneshot physical IDs and bytes while repairing the canonical locator", async () => {
  const f = await fixture("oneshot");
  const before = await f.read();
  expect(f.handle.acpxRecordId).toMatch(/^global:oneshot:/);
  expect((await f.migrate()).warnings).toEqual([]);
  await expectNoMigrationStaging(f.sourcePath);
  expect(await f.read()).toBe(before);
  expect(f.claims[0]!.meta.identity?.acpxRecordId).toBe(f.handle.acpxRecordId);
  expect(decodeAcpxRuntimeHandleState(f.claims[0]!.meta.runtimeSessionName)?.name).toBe(
    resolveAcpxSessionResource(f.claims[0]!),
  );
  expect(await acpxSessionOwnerMigration.detectLegacyState(f.input)).toBeNull();
});

it("requires repair when a bare backend locator belongs to an agent-qualified canonical key", async () => {
  const f = await fixture("persistent", "shared-project");
  f.claims[0]!.sessionKey = "agent:work:shared-project";
  const repairTarget = {
    ...target,
    sessionKey: f.claims[0]!.sessionKey,
    persistedHandle: f.handle,
  };
  await expectOwnerRejection(f.runtime(), repairTarget);
  expect(JSON.parse(await f.read())).toEqual(f.raw);
  expect((await f.migrate()).warnings).toEqual([]);
  expect(await f.expectPublished()).toBe(repairTarget.sessionKey);
});
