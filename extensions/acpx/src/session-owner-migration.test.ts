import fs from "node:fs/promises";
import path from "node:path";
import {
  AcpxRuntime as UpstreamRuntime,
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
import { fixtureSession, ownerRuntimeOptions } from "./runtime-process.test-support.js";
import { AcpxRuntime } from "./runtime.js";
import { acpxSessionOwnerMigration } from "./session-owner-migration.js";
import { resolveAcpxSessionResource } from "./session-resource.js";

type Claim = Awaited<
  ReturnType<NonNullable<PluginDoctorStateMigrationContext["inspectAcpSessionClaims"]>>
>["claims"][number];
const directories = useAutoCleanupTempDirTracker(afterEach);
const target = { ...fixtureSession("global"), agentId: "work" };
const ownerResource = resolveAcpxSessionResource(target);
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
  const rejected = { detailCode: "SESSION_OWNER_MIGRATION_REQUIRED" };
  try {
    await expect(runtime.ensureSession(input)).rejects.toMatchObject(rejected);
    await expect(runtime.prepareFreshSession(input)).rejects.toMatchObject(rejected);
  } finally {
    await runtime.shutdown();
  }
}

async function fixture(mode: "persistent" | "oneshot" = "persistent", sessionKey = "global") {
  const directory = directories.make("acpx-owner-migration-");
  const stateDir = path.join(directory, "acpx");
  await fs.mkdir(path.join(directory, "peer"));
  const store = createFileSessionStore({ stateDir });
  const runtimeOptions = ownerRuntimeOptions(directory, { sessionStore: store });
  const legacy = new UpstreamRuntime(runtimeOptions);
  const handle = await legacy.ensureSession({ sessionKey, agent: "fixture", mode });
  await runAndClose(legacy, handle, "retained history", "before-migration", "offline-migration");
  const file = (id: string) => path.join(stateDir, "sessions", `${encodeURIComponent(id)}.json`);
  const sourcePath = file(handle.acpxRecordId!);
  const read = (recordPath = sourcePath) => fs.readFile(recordPath, "utf8");
  const raw = JSON.parse(await read());
  raw.future_field = { opaque: ["preserve", 42] };
  await fs.writeFile(sourcePath, JSON.stringify(raw));
  const claim: Claim = {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    binding: { sessionId: "openclaw-session", lifecycleRevision: "revision" },
    meta: {
      backend: "acpx",
      agent: target.agent,
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
  };
  const claims = [claim];
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
      claim.meta.runtimeSessionName = input.runtimeSessionName;
      claim.meta.identity!.acpxRecordId = input.acpxRecordId;
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
    claim,
    claims,
    file,
    handle,
    input,
    raw,
    sourcePath,
    store,
    interruption,
    async migrate(warnings: unknown = []) {
      const result = await acpxSessionOwnerMigration.migrateLegacyState(input);
      expect(result.warnings).toEqual(warnings);
      return result;
    },
    read,
    runtime: (legacyKeys?: string[]) =>
      new AcpxRuntime({
        ...runtimeOptions,
        openclawLegacyBareSessionKeys: new Set(legacyKeys),
      }),
    async expectPublished() {
      const resource = resolveAcpxSessionResource(claim);
      await expectNoMigrationStaging(sourcePath);
      expect(JSON.parse(await read(file(resource)))).toEqual({
        ...raw,
        name: resource,
        acpx_record_id: resource,
      });
      return resource;
    },
    async expectRetained(before?: string) {
      await expectNoMigrationStaging(sourcePath);
      const bytes = await read();
      expect(before === undefined ? JSON.parse(bytes) : bytes).toEqual(before ?? raw);
    },
  };
}

it.each([
  ["publication", "interrupted after publication"],
  ["canonical", "stored metadata verification failed"],
  ["qualified", undefined],
] as const)("repairs ownership and preserves history: %s", async (scenario, warning) => {
  const f = await fixture("persistent", scenario === "qualified" ? "shared-project" : "global");
  if (scenario === "qualified") {
    f.claim.sessionKey = "agent:work:shared-project";
    await expectOwnerRejection(f.runtime(), {
      ...target,
      sessionKey: f.claim.sessionKey,
      persistedHandle: f.handle,
    });
    await f.expectRetained();
  } else {
    f.interruption[scenario] = true;
    await f.migrate([expect.stringContaining(warning)]);
    await f.expectRetained();
    f.interruption[scenario] = false;
  }
  await f.migrate();
  const resource = await f.expectPublished();
  if (scenario === "qualified") {
    expect(resource).toBe(f.claim.sessionKey);
  }
  expect(JSON.parse(await f.read(`${f.sourcePath}.migrated`))).toEqual(f.raw);
  expect(decodeAcpxRuntimeHandleState(f.claim.meta.runtimeSessionName)).toMatchObject({
    name: resource,
    acpxRecordId: resource,
  });
  expect(await f.migrate()).toEqual({ changes: [], warnings: [] });
  const runtime = f.runtime();
  const handle = await runtime.ensureSession({
    ...target,
    sessionKey: f.claim.sessionKey,
    persistedHandle: {
      ...f.handle,
      agentId: "work",
      runtimeSessionName: f.claim.meta.runtimeSessionName,
      acpxRecordId: resource,
    },
  });
  const response = await runAndClose(runtime, handle, "after-migration", "after");
  expect(JSON.parse(response).history).toEqual(["retained history", "after-migration"]);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
it.each(["source", "destination"] as const)(
  "retains malformed UTF-8 %s records without changing ownership",
  async (location) => {
    const f = await fixture();
    const resource = resolveAcpxSessionResource(f.claim);
    const claim = structuredClone(f.claim);
    f.raw.future_field = { opaque: ["\ufffd", 42] };
    await fs.writeFile(f.sourcePath, JSON.stringify(f.raw));
    const source = await fs.readFile(f.sourcePath);
    const targetPath = location === "source" ? f.sourcePath : f.file(resource);
    const targetBytes = Buffer.from(
      JSON.stringify(
        location === "source"
          ? f.raw
          : {
              ...f.raw,
              acpx_record_id: resource,
              name: resource,
            },
      ),
    );
    const replacement = targetBytes.indexOf(Buffer.from("\ufffd"));
    const malformed = Buffer.concat([
      targetBytes.subarray(0, replacement),
      Buffer.from([0xff]),
      targetBytes.subarray(replacement + 3),
    ]);
    await fs.writeFile(targetPath, malformed);

    const result = await acpxSessionOwnerMigration.migrateLegacyState(f.input);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(location === "source" ? 1 : 2);
    for (const warning of result.warnings) {
      expect(warning).toContain("UTF-8");
    }
    expect(result.warningDisposition).toBe("recoverable");
    expect(await fs.readFile(targetPath)).toEqual(malformed);
    if (location === "destination") {
      expect(await fs.readFile(f.sourcePath)).toEqual(source);
    }
    expect(f.claim).toEqual(claim);
    await expect(fs.access(`${f.sourcePath}.migrated`)).rejects.toThrow();
    await expectNoMigrationStaging(f.sourcePath);
  },
);

it.each<[string, (f: Fixture, resource: string) => unknown]>([
  ["ambiguous", (f) => f.claims.push({ ...structuredClone(f.claim), agentId: "main" })],
  ["missing", (f) => f.claims.splice(0)],
  ["event-log", (f) => Object.assign(f.raw, { event_log: {} })],
  ["conflict", (f, resource) => fs.writeFile(f.file(resource), '{"conflict":true}')],
  ["live", (f) => Object.assign(f.raw, { pid: process.pid })],
])("leaves %s records intact", async (scenario, prepare) => {
  const f = await fixture();
  const resource = resolveAcpxSessionResource(f.claim);
  await prepare(f, resource);
  await fs.writeFile(f.sourcePath, JSON.stringify(f.raw));
  const before = await f.read();
  const warnings =
    scenario === "event-log"
      ? [expect.stringContaining("rekey would alter interpreted history/event references")]
      : expect.arrayContaining([expect.any(String)]);
  const result = await f.migrate(warnings);
  expect(result.changes).toEqual([]);
  await f.expectRetained(before);
  if (scenario === "conflict") {
    expect(await f.read(f.file(resource))).toBe('{"conflict":true}');
  }
});

it.each(["runtime", "doctor"])("%s refuses unclaimed owner-shaped keys", async (boundary) => {
  const f = await fixture("persistent", ownerResource);
  f.claims.length = 0;
  const before = await f.read();
  if (boundary === "doctor") {
    expect(await acpxSessionOwnerMigration.detectLegacyState(f.input)).not.toBeNull();
    await f.migrate([expect.stringContaining("exactly one current owner claim is required")]);
  } else {
    await expectOwnerRejection(f.runtime([ownerResource]), target);
  }
  expect(await f.read()).toBe(before);
});

it.each([false, true])("recreates fresh history across restart=%s", async (restart) => {
  const f = await fixture("persistent", ownerResource);
  const runtime = f.runtime([ownerResource]);
  await runtime.close({
    handle: { ...f.handle, ...target },
    reason: "session-delete",
    discardPersistentState: true,
  });
  expect(await f.store.load(f.handle.acpxRecordId!)).toMatchObject({
    closed: true,
    closedAt: expect.any(String),
    acpx: { reset_on_next_ensure: true },
  });
  const recreatedRuntime = restart ? f.runtime() : runtime;
  const fresh = await recreatedRuntime.ensureSession(target);
  const response = await runAndClose(recreatedRuntime, fresh, "recreated", "after-delete");
  expect(fresh.backendSessionId).not.toBe(f.handle.backendSessionId);
  expect(JSON.parse(response)).toMatchObject({ history: ["recreated"] });
});

it("keeps oneshot physical IDs and bytes while repairing the canonical locator", async () => {
  const f = await fixture("oneshot");
  const before = await f.read();
  expect(f.handle.acpxRecordId).toMatch(/^global:oneshot:/);
  await f.migrate();
  await f.expectRetained(before);
  expect(f.claim.meta.identity?.acpxRecordId).toBe(f.handle.acpxRecordId);
  expect(decodeAcpxRuntimeHandleState(f.claim.meta.runtimeSessionName)?.name).toBe(
    resolveAcpxSessionResource(f.claim),
  );
  expect(await acpxSessionOwnerMigration.detectLegacyState(f.input)).toBeNull();
});
