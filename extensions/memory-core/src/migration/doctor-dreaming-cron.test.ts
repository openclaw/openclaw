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
    {
      label: "name and agent token with missing delivery",
      fields: {
        description: undefined,
        sessionTarget: "isolated",
        payload: CANONICAL_PAYLOAD,
      },
      payload: CANONICAL_PAYLOAD,
      delivery: { mode: "none" },
    },
  ])("adopts $label without replacing authored survivor fields", async (fixture) => {
    const job = makeJob("survivor", fixture.fields);
    const { input, inventory, repairCronJobs } = createInput([job]);
    const before = structuredClone(inventory);

    expect(await dreamingCronMigration.detectLegacyState(input)).not.toBeNull();
    expect(repairCronJobs).not.toHaveBeenCalled();
    await dreamingCronMigration.migrateLegacyState(input);

    expect(repairCronJobs.mock.calls).toEqual([
      [
        inventory,
        [
          {
            job,
            definition: {
              ...job.definition,
              declarationKey: DECLARATION_KEY,
              sessionTarget: "isolated",
              payload: fixture.payload,
              delivery: fixture.delivery,
            },
          },
        ],
      ],
    ]);
    expect(inventory).toEqual(before);
  });

  it("prefers declared survivors, then the oldest valid unified job in each partition", async () => {
    const jobs = [
      makeJob("legacy-oldest", { createdAtMs: 1 }),
      makeJob("declared-newer", { ...CANONICAL_FIELDS, createdAtMs: 40 }),
      makeJob("declared-survivor", { ...CANONICAL_FIELDS, createdAtMs: 20 }),
      makeJob("light-phase", {
        name: "Renamed light phase",
        description: "[managed-by=memory-core.dreaming.light]",
        payload: { kind: "systemEvent", text: "__openclaw_memory_core_light_sleep__" },
      }),
      makeJob("inactive-newer", { createdAtMs: 30 }, { storeKey: INACTIVE_STORE }),
      makeJob("inactive-survivor", { createdAtMs: 10 }, { storeKey: INACTIVE_STORE }),
      makeJob(
        "invalid-declared",
        { ...CANONICAL_FIELDS, createdAtMs: 0 },
        { storeKey: INACTIVE_STORE, invalidReason: "invalid-schedule" },
      ),
      makeJob(
        "rem-phase",
        {
          name: "Memory REM Dreaming",
          description: undefined,
          createdAtMs: 1,
          payload: { kind: "systemEvent", text: "__openclaw_memory_core_rem_sleep__" },
        },
        { storeKey: INACTIVE_STORE },
      ),
    ];
    const { input, inventory, repairCronJobs } = createInput(jobs);

    const result = await dreamingCronMigration.migrateLegacyState(input);

    expect(repairCronJobs).toHaveBeenCalledOnce();
    const changes = repairCronJobs.mock.calls[0]?.[1] ?? [];
    expect(
      changes
        .map(
          ({ job, definition }) => `${job.storeKey}:${job.id}:${definition ? "adopt" : "retire"}`,
        )
        .toSorted(),
    ).toEqual(
      [
        `${ACTIVE_STORE}:legacy-oldest:retire`,
        `${ACTIVE_STORE}:declared-newer:retire`,
        `${ACTIVE_STORE}:light-phase:retire`,
        `${INACTIVE_STORE}:inactive-survivor:adopt`,
        `${INACTIVE_STORE}:inactive-newer:retire`,
        `${INACTIVE_STORE}:rem-phase:retire`,
      ].toSorted(),
    );
    expect(changes.find(({ job }) => job.id === "inactive-survivor")?.definition).toMatchObject({
      id: "inactive-survivor",
      declarationKey: DECLARATION_KEY,
      enabled: false,
      createdAtMs: 10,
    });
    expect(repairCronJobs.mock.calls[0]?.[0]).toBe(inventory);
    expect(result.warnings).toEqual([expect.stringContaining("invalid-declared")]);
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
        {
          name: "Memory REM Dreaming",
          description: undefined,
          createdAtMs: 5,
          payload: { kind: "systemEvent", text: "__openclaw_memory_core_rem_sleep__" },
        },
        { storeKey: phaseOnlyStore, sortOrder: 0 },
      );
      const newerPhase = makeJob(
        "0-newer-phase",
        { ...tiedPhase.definition, id: "0-newer-phase", createdAtMs: 10 },
        { storeKey: phaseOnlyStore, sortOrder: 1 },
      );
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
            {
              job: phase,
              definition: {
                ...phase.definition,
                declarationKey: DECLARATION_KEY,
                name: "Memory Dreaming Promotion",
                description: `${DREAMING_TAG} authored phase description`,
                sessionTarget: "isolated",
                payload: { ...CANONICAL_PAYLOAD, timeoutSeconds: 90 },
                delivery: { mode: "none", channel: "telegram", to: "operator" },
              },
            },
            { job: tiedPhase, definition: null },
            { job: newerPhase, definition: null },
            {
              job: renamedPhase,
              definition: {
                ...renamedPhase.definition,
                declarationKey: DECLARATION_KEY,
                description: `${DREAMING_TAG} authored suffix`,
                sessionTarget: "isolated",
                payload: { ...CANONICAL_PAYLOAD, model: "operator-model" },
                delivery: { mode: "none" },
              },
            },
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

  it.each(
    [
      { label: "unified", tags: DREAMING_TAG },
      { label: "mixed", tags: `${DREAMING_TAG} [managed-by=memory-core.dreaming.rem]` },
      { label: "phase-only", tags: "[managed-by=memory-core.dreaming.rem]" },
    ].flatMap((fixture) =>
      [true, false].map((enabled) => ({ label: fixture.label, tags: fixture.tags, enabled })),
    ),
  )(
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
      label: "name lookalike with a different token",
      fields: {
        description: undefined,
        payload: { kind: "systemEvent", text: "authored event" },
      },
    },
    {
      label: "foreign declaration with a matching owner tag",
      fields: { declarationKey: "other-plugin:dreaming" },
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
