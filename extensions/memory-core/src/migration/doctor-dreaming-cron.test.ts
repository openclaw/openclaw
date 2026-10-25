import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type {
  PluginDoctorCronInventory,
  PluginDoctorCronJob,
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { describe, expect, it, vi } from "vitest";
import { dreamingCronMigration } from "./doctor-dreaming-cron.js";

type MigrationInput = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
const DREAMING_TOKEN = "__openclaw_memory_core_short_term_promotion_dream__";
const DREAMING_TAG = "[managed-by=memory-core.short-term-promotion]";
const INACTIVE_STORE = "/old-state/cron/jobs.json";
const CANONICAL_PAYLOAD = { kind: "agentTurn", message: DREAMING_TOKEN, lightContext: true };
const MODEL_PAYLOAD = { ...CANONICAL_PAYLOAD, model: "operator-model" };
const CANONICAL_FIELDS = {
  declarationKey: "memory-core:memory-dreaming-promotion",
  sessionTarget: "isolated",
  payload: CANONICAL_PAYLOAD,
  delivery: { mode: "none" },
};
const AUTHORED_FIELDS = {
  ...CANONICAL_FIELDS,
  name: "Authored name",
  description: "Authored description",
  payload: { ...CANONICAL_PAYLOAD, message: "Authored prompt", model: "operator-model" },
};
const REM_PHASE_FIELDS = {
  name: "Memory REM Dreaming",
  description: undefined,
  payload: { kind: "systemEvent", text: "__openclaw_memory_core_rem_sleep__" },
};
const AUTHORED_JOB = { name: "Daily standup", description: "Operator job" };
const dreamingConfig = (enabled: boolean) => ({
  plugins: { entries: { "memory-core": { config: { dreaming: { enabled } } } } },
});
const deleted = (job: PluginDoctorCronJob) => ({ job, definition: null });

function adopted(job: PluginDoctorCronJob, fields: Record<string, unknown> = {}) {
  return { job, definition: { ...job.definition, ...CANONICAL_FIELDS, ...fields } };
}

function makeJob(
  id: string,
  fields: Record<string, unknown> = {},
  row: Partial<Pick<PluginDoctorCronJob, "storeKey" | "sortOrder" | "invalidReason">> = {},
): PluginDoctorCronJob {
  const definition = {
    id,
    name: "Memory Dreaming Promotion",
    description: `${DREAMING_TAG} authored description`,
    enabled: false,
    createdAtMs: 10,
    updatedAtMs: 20,
    schedule: { kind: "cron", expr: "17 8 * * 1", tz: "Europe/Vienna" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: DREAMING_TOKEN },
    ...fields,
  };
  return {
    storeKey: "/state/cron/jobs.json",
    id,
    sortOrder: 4,
    definition,
    definitionJson: JSON.stringify(definition),
    ...row,
  };
}

function storedJob(storeKey: string) {
  return (id: string, fields: Record<string, unknown> = {}, sortOrder = 4) =>
    makeJob(id, fields, { storeKey, sortOrder });
}
const inactiveJob = storedJob(INACTIVE_STORE);

function createInput(jobs: PluginDoctorCronJob[], config: MigrationInput["config"] = {}) {
  const inventory: PluginDoctorCronInventory = { jobs };
  const repairCronJobs = vi.fn<NonNullable<PluginDoctorStateMigrationContext["repairCronJobs"]>>(
    async () => ({ changed: 0 }),
  );
  const input: MigrationInput = {
    config,
    env: {},
    stateDir: "/state",
    oauthDir: "/state/credentials",
    context: {
      openPluginStateKeyedStore() {
        throw new Error("Cron migration must use its host cron operations");
      },
      inspectCronJobs: async () => inventory,
      repairCronJobs,
    },
  };
  return { input, inventory, repairCronJobs };
}

async function inspectAndMigrate(fixture: ReturnType<typeof createInput>) {
  const { input, inventory, repairCronJobs } = fixture;
  const before = structuredClone(inventory);
  const detection = await dreamingCronMigration.detectLegacyState(input);
  expect(repairCronJobs).not.toHaveBeenCalled();
  expect(inventory).toEqual(before);
  const result = await dreamingCronMigration.migrateLegacyState(input);
  expect(inventory).toEqual(before);
  return { detection, result };
}

function expectRepairs(
  { inventory, repairCronJobs: repair }: ReturnType<typeof createInput>,
  changes: ReturnType<typeof adopted | typeof deleted>[],
) {
  expect(repair).toHaveBeenCalledExactlyOnceWith(inventory, expect.arrayContaining(changes));
  expect(repair.mock.calls[0]?.[0]).toBe(inventory);
  expect(repair.mock.calls[0]?.[1]).toHaveLength(changes.length);
}

describe("dreaming cron Doctor selection", () => {
  it("defers unavailable cron inspection without changing rows, then repairs on retry", async () => {
    const job = makeJob("pending", { name: "My weekly memory maintenance" });
    const { input, inventory, repairCronJobs } = createInput([job]);
    const before = structuredClone(inventory);
    input.context.inspectCronJobs = async () => {
      throw new Error("SQLite snapshot allocation and cleanup failed");
    };
    expect(await dreamingCronMigration.detectLegacyState(input)).toEqual({
      preview: [expect.stringContaining("Dreaming cron inspection remains pending")],
    });
    expect(await dreamingCronMigration.migrateLegacyState(input)).toEqual({
      changes: [],
      warnings: [expect.stringContaining("openclaw doctor --fix")],
      warningDisposition: "recoverable",
    });
    expect(repairCronJobs).not.toHaveBeenCalled();
    expect(inventory).toEqual(before);
    input.context.inspectCronJobs = async () => inventory;
    await dreamingCronMigration.migrateLegacyState(input);
    expect(repairCronJobs).toHaveBeenCalledExactlyOnceWith(inventory, [adopted(job)]);
  });

  it.each([
    ["untagged name and token", { description: "Authored description without the tag" }, {}],
    [
      "partially migrated agent turn",
      {
        sessionTarget: "isolated",
        payload: { ...MODEL_PAYLOAD, lightContext: false },
        delivery: { mode: "none" },
      },
      { payload: MODEL_PAYLOAD },
    ],
  ] as const)("adopts %s preserving authored fields", async (_label, fields, expected) => {
    const job = makeJob("survivor", fields);
    const test = createInput([job]);
    expect((await inspectAndMigrate(test)).detection).not.toBeNull();
    expectRepairs(test, [adopted(job, expected)]);
  });

  it("prefers declared over legacy and legacy over phase within each partition", async () => {
    const legacy = makeJob("legacy-oldest", { createdAtMs: 1 });
    const declared = makeJob("declared-survivor", AUTHORED_FIELDS);
    const phase = inactiveJob("rem-phase", { ...REM_PHASE_FIELDS, createdAtMs: 1 });
    const inactive = inactiveJob("inactive-survivor");
    const test = createInput([legacy, declared, phase, inactive]);
    await inspectAndMigrate(test);
    expectRepairs(test, [deleted(legacy), adopted(inactive), deleted(phase)]);
  });

  it.each([true, false])("repairs phase partitions when enabled=%s", async (enabled) => {
    const phaseJob = storedJob("/phase-only/cron/jobs.json");
    const declared = makeJob("declared", CANONICAL_FIELDS);
    const legacy = makeJob("legacy-unified");
    const phase = phaseJob(
      "a-light-phase",
      {
        name: "Memory Light Dreaming",
        description: "[managed-by=memory-core.dreaming.light] authored phase description",
        enabled: true,
        createdAtMs: 5,
        payload: {
          kind: "systemEvent",
          text: "__openclaw_memory_core_light_sleep__",
          timeoutSeconds: 90,
        },
        delivery: { mode: "announce", channel: "telegram", to: "operator" },
      },
      99,
    );
    const tiedPhase = phaseJob("z-rem-phase", { ...REM_PHASE_FIELDS, createdAtMs: 5 }, 0);
    const newerPhase = phaseJob("0-newer-phase", REM_PHASE_FIELDS, 1);
    const renamedPhase = inactiveJob("renamed-phase", {
      name: "My authored phase name",
      description: "[managed-by=memory-core.dreaming.rem] authored suffix",
      payload: {
        kind: "agentTurn",
        message: "__openclaw_memory_core_rem_sleep__",
        model: "operator-model",
      },
    });
    const managed = [declared, legacy, tiedPhase, newerPhase, phase, renamedPhase];
    const test = createInput(
      [
        ...managed,
        makeJob("invalid-unified", CANONICAL_FIELDS, {
          storeKey: INACTIVE_STORE,
          invalidReason: "invalid-state",
        }),
        { ...makeJob("malformed"), definitionJson: "{malformed", definition: null },
        makeJob("foreign", { declarationKey: "other-plugin:dreaming" }),
        makeJob("authored", AUTHORED_JOB),
      ],
      dreamingConfig(enabled),
    );
    const { detection, result } = await inspectAndMigrate(test);
    expect(detection).not.toBeNull();
    const expectedChanges = enabled
      ? [
          deleted(legacy),
          adopted(phase, {
            name: "Memory Dreaming Promotion",
            description: `${DREAMING_TAG} authored phase description`,
            payload: { ...CANONICAL_PAYLOAD, timeoutSeconds: 90 },
            delivery: { mode: "none", channel: "telegram", to: "operator" },
          }),
          deleted(tiedPhase),
          deleted(newerPhase),
          adopted(renamedPhase, {
            description: `${DREAMING_TAG} authored suffix`,
            payload: MODEL_PAYLOAD,
          }),
        ]
      : managed.map(deleted);
    expectRepairs(test, expectedChanges);
    expect(result.warnings).toEqual([
      expect.stringContaining("invalid-unified"),
      expect.stringContaining("malformed"),
    ]);
  });

  it.each([
    ["unified", DREAMING_TAG, true],
    ["mixed", `${DREAMING_TAG} [managed-by=memory-core.dreaming.rem]`, false],
  ] as const)("retains authored prompts with %s tags", async (_label, tags, enabled) => {
    const job = makeJob("authored-tagged", {
      ...CANONICAL_FIELDS,
      declarationKey: undefined,
      name: "My memory maintenance",
      description: `${tags} authored description`,
      payload: { ...CANONICAL_PAYLOAD, message: "Preserve my authored prompt" },
    });
    const test = createInput([job], dreamingConfig(enabled));
    const { detection, result } = await inspectAndMigrate(test);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("authored-tagged")]);
    expect(result.warnings[0]).toContain("review its ownership manually");
    expect(detection?.preview).toEqual(result.warnings);
    expect(test.repairCronJobs).not.toHaveBeenCalled();
  });

  it.each([
    ["unrelated", AUTHORED_JOB],
    ["declared", AUTHORED_FIELDS],
  ] as const)("plans no edits for an authored %s job", async (_label, fields) => {
    const test = createInput([makeJob("unchanged", fields)]);
    const { detection, result } = await inspectAndMigrate(test);
    expect(detection).toBeNull();
    expect(result).toMatchObject({ changes: [], warnings: [] });
    expect(test.repairCronJobs).not.toHaveBeenCalled();
  });
});
