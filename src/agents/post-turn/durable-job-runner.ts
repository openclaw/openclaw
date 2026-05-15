import { formatErrorMessage } from "../../infra/errors.js";
import {
  createPostTurnJob,
  isPostTurnCircuitBreakerOpen,
  markPostTurnJobCompleted,
  markPostTurnJobCrashed,
  markPostTurnJobFailed,
  markPostTurnJobRunning,
  markPostTurnJobSkipped,
  type PostTurnJobCreateParams,
} from "./durable-job-state.js";
import { isPostTurnWorkerNativeCrash } from "./worker-process.js";

export type DurablePostTurnJobRunResult<TResult = unknown> =
  | { status: "completed"; result: TResult }
  | { status: "skipped"; reason: string };

type DurablePostTurnJobRunOptions = {
  now?: number;
  bootId?: string;
  processId?: number;
};

export async function runDurablePostTurnJob<TResult>(
  params: PostTurnJobCreateParams & {
    work: () => Promise<TResult> | TResult;
  },
  options?: DurablePostTurnJobRunOptions,
): Promise<DurablePostTurnJobRunResult<TResult>> {
  const job = await createPostTurnJob(params, options);
  if (await isPostTurnCircuitBreakerOpen(params)) {
    const reason = `post-turn circuit breaker is open for ${params.kind}`;
    await markPostTurnJobSkipped(job.id, { reason, now: options?.now });
    return { status: "skipped", reason };
  }

  await markPostTurnJobRunning(job.id, options);
  try {
    const result = await params.work();
    await markPostTurnJobCompleted(job.id, { now: options?.now });
    return { status: "completed", result };
  } catch (error) {
    const reason = formatErrorMessage(error);
    if (isPostTurnWorkerNativeCrash(error)) {
      await markPostTurnJobCrashed(job.id, { reason, now: options?.now });
    } else {
      await markPostTurnJobFailed(job.id, { reason, now: options?.now });
    }
    throw error;
  }
}

export function scheduleDurablePostTurnJob<TResult>(
  params: PostTurnJobCreateParams & {
    work: () => Promise<TResult> | TResult;
    onError?: (error: unknown) => void;
  },
  options?: DurablePostTurnJobRunOptions,
): void {
  void runDurablePostTurnJob(params, options).catch((error) => {
    params.onError?.(error);
  });
}
