import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type {
  PluginDoctorCronJob,
  PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { expect, it, vi } from "vitest";
import { dreamingCronMigration } from "./doctor-dreaming-cron.js";

type MigrationInput = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
type Fields = Record<string, unknown>;
type Row = Partial<Pick<PluginDoctorCronJob, "storeKey" | "sortOrder" | "invalidReason">>;
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
const AUTHORED_JOB = { name: "Daily standup", description: "Operator job" };
const deleted = (job: PluginDoctorCronJob) => ({ job, definition: null });

function adopted(job: PluginDoctorCronJob, fields: Fields = {}) {
  return { job, definition: { ...job.definition, ...CANONICAL_FIELDS, ...fields } };
}

function makeJob(id: string, fields: Fields = {}, row: Row = {}): PluginDoctorCronJob {
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

function makePhase(id: string, phase: "light" | "rem", fields: Fields = {}, sortOrder = 4) {
  const text = `__openclaw_memory_core_${phase}_sleep__`;
  const definition = {
    name: phase === "light" ? "Memory Light Dreaming" : "Memory REM Dreaming",
    description: `[managed-by=memory-core.dreaming.${phase}] authored suffix`,
    payload: { kind: "systemEvent", text, timeoutSeconds: 90 },
    delivery: { mode: "announce", channel: "telegram", to: "operator" },
    ...fields,
  };
  return makeJob(id, definition, { storeKey: "/phase-only/cron/jobs.json", sortOrder });
}

function createInput(jobs: PluginDoctorCronJob[], enabled = true) {
  const inventory = { jobs };
  const repairCronJobs = vi.fn<NonNullable<MigrationInput["context"]["repairCronJobs"]>>(
    async () => ({ changed: 0 }),
  );
  const input: MigrationInput = {
    config: { plugins: { entries: { "memory-core": { config: { dreaming: { enabled } } } } } },
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

async function checkMigration(
  fixture: ReturnType<typeof createInput>,
  changes: ReturnType<typeof adopted | typeof deleted>[],
  warnings: string[] = [],
) {
  const { input, inventory, repairCronJobs } = fixture;
  const before = structuredClone(inventory);
  const detection = await dreamingCronMigration.detectLegacyState(input);
  expect(repairCronJobs).not.toHaveBeenCalled();
  expect(inventory).toEqual(before);
  const result = await dreamingCronMigration.migrateLegacyState(input);
  expect(inventory).toEqual(before);
  expect(result).toMatchObject({ changes: [], warnings });
  const preview = [...(changes.length ? [expect.any(String)] : []), ...warnings];
  expect(detection).toEqual(preview.length ? { preview } : null);
  expect(repairCronJobs.mock.calls).toEqual(
    changes.length ? [[inventory, expect.arrayContaining(changes)]] : [],
  );
  expect(repairCronJobs.mock.calls[0]?.[1] ?? []).toHaveLength(changes.length);
}

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
  await checkMigration({ input, inventory, repairCronJobs }, [adopted(job)]);
});

it.each([true, false])("plans historical inventory repairs when enabled=%s", async (enabled) => {
  const declared = makeJob("declared", AUTHORED_FIELDS);
  const legacy = makeJob("legacy", { createdAtMs: 1 });
  const light = makePhase("a-light", "light", { enabled: true, createdAtMs: 5 }, 99);
  const tied = makePhase("z-rem", "rem", { description: undefined, createdAtMs: 5 }, 0);
  const newer = makePhase("0-newer", "rem", { description: undefined }, 1);
  const untagged = makeJob("untagged", { description: "authored" }, { storeKey: "/legacy" });
  const older = { ...makePhase("older", "rem", { createdAtMs: 1 }), storeKey: "/legacy" };
  const renamed = makeJob(
    "renamed",
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
  const payload = { ...MODEL_PAYLOAD, lightContext: false };
  const partial = makeJob("partial", { payload }, { storeKey: "/partial" });
  const ambiguous = [DREAMING_TAG, `${DREAMING_TAG} [managed-by=memory-core.dreaming.rem]`].map(
    (description, index) =>
      makeJob(`authored-${index}`, {
        ...AUTHORED_FIELDS,
        declarationKey: undefined,
        description,
      }),
  );
  const managed = [declared, legacy, tied, newer, light, renamed, untagged, older, partial];
  const test = createInput(
    [
      ...managed,
      ...ambiguous,
      makeJob("invalid", CANONICAL_FIELDS, { invalidReason: "invalid-state" }),
      { ...makeJob("malformed"), definitionJson: "{malformed", definition: null },
      makeJob("foreign", { declarationKey: "other-plugin:dreaming" }),
      makeJob("authored", AUTHORED_JOB),
    ],
    enabled,
  );
  const expectedChanges = enabled
    ? [
        deleted(legacy),
        adopted(light, {
          name: "Memory Dreaming Promotion",
          description: `${DREAMING_TAG} authored suffix`,
          payload: { ...CANONICAL_PAYLOAD, timeoutSeconds: 90 },
          delivery: { mode: "none", channel: "telegram", to: "operator" },
        }),
        deleted(tied),
        deleted(newer),
        adopted(renamed, {
          description: `${DREAMING_TAG} authored suffix`,
          payload: MODEL_PAYLOAD,
        }),
        adopted(untagged),
        deleted(older),
        adopted(partial, { payload: MODEL_PAYLOAD }),
      ]
    : managed.map(deleted);
  await checkMigration(test, expectedChanges, [
    ...ambiguous.map(({ id }) => expect.stringMatching(`${id}.*review its ownership manually`)),
    expect.stringContaining("invalid"),
    expect.stringContaining("malformed"),
  ]);
});

it("plans no edits for an authored declared job", async () => {
  await checkMigration(createInput([makeJob("declared", AUTHORED_FIELDS)]), []);
});
