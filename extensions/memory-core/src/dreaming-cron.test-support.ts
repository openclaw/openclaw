import { expectDefined } from "@openclaw/normalization-core";

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; lightContext?: boolean };
export type CronAddInput = {
  declarationKey: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "now";
  payload: CronPayload;
  delivery?: { mode: "none" };
};
export type CronPatch = Partial<CronAddInput>;
export type CronJobLike = {
  id: string;
  declarationKey?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind?: string; text?: string; message?: string; lightContext?: boolean };
  delivery?: { mode?: string };
  createdAtMs?: number;
};
type CronParam = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<CronJobLike[]>;
  add: (input: CronAddInput) => Promise<unknown>;
  update: (id: string, patch: CronPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};
export type CronHarnessOptions = {
  listThrowsForFirstCalls?: number;
};
export function createCronHarness(initialJobs: CronJobLike[] = [], opts?: CronHarnessOptions) {
  const jobs: CronJobLike[] = [...initialJobs];
  let listCalls = 0;
  const addCalls: CronAddInput[] = [];
  const updateCalls: Array<{ id: string; patch: CronPatch }> = [];
  const removeCalls: string[] = [];
  const mutationCalls: string[] = [];

  const cron: CronParam = {
    async list() {
      listCalls += 1;
      if (opts?.listThrowsForFirstCalls && listCalls <= opts.listThrowsForFirstCalls) {
        throw new Error(`list failed on call ${listCalls}`);
      }
      return jobs.map((job) => ({
        ...job,
        ...(job.schedule ? { schedule: { ...job.schedule } } : {}),
        ...(job.payload ? { payload: { ...job.payload } } : {}),
        ...(job.delivery ? { delivery: { ...job.delivery } } : {}),
      }));
    },
    async add(input) {
      mutationCalls.push("add");
      addCalls.push(input);
      jobs.push({
        ...input,
        id: `job-${jobs.length + 1}`,
        schedule: { ...input.schedule },
        payload: { ...input.payload },
        ...(input.delivery ? { delivery: { ...input.delivery } } : {}),
        createdAtMs: Date.now(),
      });
      return {};
    },
    async update(id, patch) {
      mutationCalls.push(`update:${id}`);
      updateCalls.push({ id, patch });
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index < 0) {
        return {};
      }
      const current = expectDefined(jobs[index], `managed cron job ${id}`);
      jobs[index] = {
        ...current,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(patch.schedule ? { schedule: { ...patch.schedule } } : {}),
        ...(patch.sessionTarget ? { sessionTarget: patch.sessionTarget } : {}),
        ...(patch.wakeMode ? { wakeMode: patch.wakeMode } : {}),
        ...(patch.payload ? { payload: { ...patch.payload } } : {}),
        ...(patch.delivery ? { delivery: { ...patch.delivery } } : {}),
      };
      return {};
    },
    async remove(id) {
      mutationCalls.push(`remove:${id}`);
      removeCalls.push(id);
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        jobs.splice(index, 1);
      }
      return { removed: index >= 0 };
    },
  };

  return {
    cron,
    jobs,
    addCalls,
    updateCalls,
    removeCalls,
    mutationCalls,
    get listCalls() {
      return listCalls;
    },
  };
}
