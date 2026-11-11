import { expectDefined } from "@openclaw/normalization-core";
import type { CronServiceLike } from "./dreaming-cron.js";

type ManagedInput = Parameters<CronServiceLike["add"]>[0];
type ListedJob = Awaited<ReturnType<CronServiceLike["list"]>>[number];
export type CronAddInput = Omit<ManagedInput, "payload"> & {
  payload: ManagedInput["payload"] | { kind: "systemEvent"; text: string };
};
export type CronPatch = Partial<CronAddInput>;
export type CronJobLike = Omit<ListedJob, "payload"> & {
  payload?: ListedJob["payload"] & { text?: string };
  createdAtMs?: number;
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

  const cron = {
    async list() {
      listCalls += 1;
      if (opts?.listThrowsForFirstCalls && listCalls <= opts.listThrowsForFirstCalls) {
        throw new Error(`list failed on call ${listCalls}`);
      }
      return structuredClone(jobs);
    },
    async add(input: CronAddInput) {
      mutationCalls.push("add");
      addCalls.push(input);
      jobs.push({
        ...structuredClone(input),
        id: `job-${jobs.length + 1}`,
        createdAtMs: Date.now(),
      });
      return {};
    },
    async update(id: string, patch: CronPatch) {
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
    async remove(id: string) {
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
