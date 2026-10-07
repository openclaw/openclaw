import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type {
  PluginDoctorCronInventory,
  PluginDoctorCronJob,
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { describe, expect, it, vi } from "vitest";
import { dreamingCronMigration } from "./doctor-dreaming-cron.js";

const DECLARATION_KEY = "memory-core:memory-dreaming-promotion";
const DREAMING_TOKEN = "__openclaw_memory_core_short_term_promotion_dream__";
const DREAMING_TAG = "[managed-by=memory-core.short-term-promotion]";
const ACTIVE_STORE = "/state/cron/jobs.json";
const INACTIVE_STORE = "/old-state/cron/jobs.json";
const CANONICAL_PAYLOAD = {
  kind: "agentTurn",
  message: DREAMING_TOKEN,
  lightContext: true,
};
const CANONICAL_FIELDS = {
  declarationKey: DECLARATION_KEY,
  sessionTarget: "isolated",
  payload: CANONICAL_PAYLOAD,
  delivery: { mode: "none" },
};
const REM_PHASE_FIELDS = {
  name: "Memory REM Dreaming",
  description: undefined,
  payload: { kind: "systemEvent", text: "__openclaw_memory_core_rem_sleep__" },
};

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
    storeKey: ACTIVE_STORE,
    id,
    sortOrder: 4,
    definition,
    definitionJson: JSON.stringify(definition),
    ...row,
  };
}

function createInput(
  jobs: PluginDoctorCronJob[],
  config: Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0]["config"] = {},
) {
  const inventory: PluginDoctorCronInventory = { jobs };
  const repairCronJobs = vi.fn<NonNullable<PluginDoctorStateMigrationContext["repairCronJobs"]>>(
    async () => ({ changed: 0 }),
  );
  const input: Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0] = {
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

describe("dreaming cron Doctor selection", () => {
  it.each([
    {
      label: "owner tag with an edited name",
      fields: {
        name: "My weekly memory maintenance",
        payload: { kind: "systemEvent", text: DREAMING_TOKEN, timeoutSeconds: 90 },
        delivery: { mode: "announce", channel: "telegram", to: "operator" },
      },
      payload: { ...CANONICAL_PAYLOAD, timeoutSeconds: 90 },
      delivery: { mode: "none", channel: "telegram", to: "operator" },
    },
    {
      label: "name and event token without an owner tag",
      fields: { description: "An authored description without the tag" },
      payload: CANONICAL_PAYLOAD,
      delivery: { mode: "none" },
    },
    {
      label: "partially migrated agent turn with an authored model",
      fields: {
        sessionTarget: "isolated",
        payload: {
          ...CANONICAL_PAYLOAD,
          lightContext: false,
          model: "operator-model",
        },
        delivery: { mode: "none" },
      },
      payload: { ...CANONICAL_PAYLOAD, model: "operator-model" },
      delivery: { mode: "none" },
    },
  ])("adopts $label without replacing authored survivor fields", async (fixture) => {
    const job = makeJob("survivor", fixture.fields);
    const { input, inventory, repairCronJobs } = createInput([job]);
    const before = structuredClone(inventory);

    expect(await dreamingCronMigration.detectLegacyState(input)).not.toBeNull();
    expect(repairCronJobs).not.toHaveBeenCalled();
    await dreamingCronMigration.migrateLegacyState(input);

    expect(repairCronJobs).toHaveBeenCalledExactlyOnceWith(inventory, [
      adopted(job, { payload: fixture.payload, delivery: fixture.delivery }),
    ]);
    expect(inventory).toEqual(before);
  });

  it("prefers declared over legacy and legacy over phase within each partition", async () => {
    const legacy = makeJob("legacy-oldest", { createdAtMs: 1 });
    const declared = makeJob("declared-survivor", CANONICAL_FIELDS);
    const phase = makeJob(
      "rem-phase",
      { ...REM_PHASE_FIELDS, createdAtMs: 1 },
      { storeKey: INACTIVE_STORE },
    );
    const inactive = makeJob("inactive-survivor", {}, { storeKey: INACTIVE_STORE });
    const { input, inventory, repairCronJobs } = createInput([legacy, declared, phase, inactive]);

    await dreamingCronMigration.migrateLegacyState(input);

    expect(repairCronJobs).toHaveBeenCalledExactlyOnceWith(
      inventory,
      expect.arrayContaining([
        { job: legacy, definition: null },
        adopted(inactive),
        { job: phase, definition: null },
      ]),
    );
    expect(repairCronJobs.mock.calls[0]?.[1]).toHaveLength(3);
  });

  it.each([true, false])(
    "repairs phase-only partitions in place when enabled=%s",
    async (enabled) => {
      const phaseOnlyStore = "/phase-only/cron/jobs.json";
      const declared = makeJob("declared", CANONICAL_FIELDS);
      const legacy = makeJob("legacy-unified");
      const phase = makeJob(
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
        { storeKey: phaseOnlyStore, sortOrder: 99 },
      );
      const tiedPhase = makeJob(
        "z-rem-phase",
        { ...REM_PHASE_FIELDS, createdAtMs: 5 },
        { storeKey: phaseOnlyStore, sortOrder: 0 },
      );
      const newerPhase = makeJob("0-newer-phase", REM_PHASE_FIELDS, {
        storeKey: phaseOnlyStore,
        sortOrder: 1,
      });
      const renamedPhase = makeJob(
        "renamed-phase",
        {
          name: "My authored phase name",
          description: "[managed-by=memory-core.dreaming.rem] authored suffix",
          payload: {
            kind: "agentTurn",
            message: "__openclaw_memory_core_rem_sleep__",
            model: "operator-model",
          },
        },
        { storeKey: INACTIVE_STORE },
      );
      const invalid = makeJob("invalid-unified", CANONICAL_FIELDS, {
        storeKey: INACTIVE_STORE,
        invalidReason: "invalid-state",
      });
      const malformed = {
        ...makeJob("malformed"),
        definitionJson: "{malformed",
        definition: null,
      };
      const foreign = makeJob("foreign", { declarationKey: "other-plugin:dreaming" });
      const authored = makeJob("authored", {
        description: "Operator job",
        payload: { kind: "systemEvent", text: "authored event" },
      });
      const jobs = [
        declared,
        legacy,
        tiedPhase,
        newerPhase,
        phase,
        renamedPhase,
        invalid,
        malformed,
        foreign,
        authored,
      ];
      const { input, inventory, repairCronJobs } = createInput(jobs, {
        plugins: { entries: { "memory-core": { config: { dreaming: { enabled } } } } },
      });
      const before = structuredClone(inventory);

      const detection = await dreamingCronMigration.detectLegacyState(input);
      expect(detection).not.toBeNull();
      expect(repairCronJobs).not.toHaveBeenCalled();
      const result = await dreamingCronMigration.migrateLegacyState(input);

      const expectedChanges = enabled
        ? [
            { job: legacy, definition: null },
            adopted(phase, {
              name: "Memory Dreaming Promotion",
              description: `${DREAMING_TAG} authored phase description`,
              payload: { ...CANONICAL_PAYLOAD, timeoutSeconds: 90 },
              delivery: { mode: "none", channel: "telegram", to: "operator" },
            }),
            { job: tiedPhase, definition: null },
            { job: newerPhase, definition: null },
            adopted(renamedPhase, {
              description: `${DREAMING_TAG} authored suffix`,
              payload: { ...CANONICAL_PAYLOAD, model: "operator-model" },
            }),
          ]
        : [declared, legacy, tiedPhase, newerPhase, phase, renamedPhase].map((job) => ({
            job,
            definition: null,
          }));
      expect(repairCronJobs).toHaveBeenCalledOnce();
      expect(repairCronJobs.mock.calls[0]?.[0]).toBe(inventory);
      expect(repairCronJobs.mock.calls[0]?.[1]).toHaveLength(expectedChanges.length);
      expect(repairCronJobs.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(expectedChanges));
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("invalid-unified"),
          expect.stringContaining("malformed"),
        ]),
      );
      expect(inventory).toEqual(before);
    },
  );

  it.each([
    { label: "unified", tags: DREAMING_TAG, enabled: true },
    {
      label: "mixed",
      tags: `${DREAMING_TAG} [managed-by=memory-core.dreaming.rem]`,
      enabled: false,
    },
  ])(
    "retains an authored prompt with $label tags when enabled=$enabled",
    async ({ enabled, tags }) => {
      const { input, inventory, repairCronJobs } = createInput(
        [
          makeJob("authored-tagged", {
            name: "My memory maintenance",
            description: `${tags} authored description`,
            sessionTarget: "isolated",
            payload: {
              kind: "agentTurn",
              message: "Preserve my authored prompt",
              lightContext: true,
            },
            delivery: { mode: "none" },
          }),
        ],
        { plugins: { entries: { "memory-core": { config: { dreaming: { enabled } } } } } },
      );
      const before = structuredClone(inventory);

      const detection = await dreamingCronMigration.detectLegacyState(input);
      const result = await dreamingCronMigration.migrateLegacyState(input);

      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([expect.stringContaining("authored-tagged")]);
      expect(result.warnings[0]).toContain("review its ownership manually");
      expect(detection?.preview).toEqual(result.warnings);
      expect(repairCronJobs).not.toHaveBeenCalled();
      expect(inventory).toEqual(before);
    },
  );

  it.each([
    {
      label: "unrelated authored job",
      fields: { name: "Daily standup", description: "Operator job" },
    },
    {
      label: "canonical declaration with authored fields",
      fields: {
        ...CANONICAL_FIELDS,
        name: "Authored name",
        description: "Authored description",
        payload: { ...CANONICAL_PAYLOAD, message: "Authored prompt", model: "operator-model" },
      },
    },
  ])("plans no edits for $label", async ({ fields }) => {
    const { input, repairCronJobs } = createInput([makeJob("unchanged", fields)]);

    expect(await dreamingCronMigration.detectLegacyState(input)).toBeNull();
    expect(await dreamingCronMigration.migrateLegacyState(input)).toMatchObject({
      changes: [],
      warnings: [],
    });
    expect(repairCronJobs).not.toHaveBeenCalled();
  });
});
