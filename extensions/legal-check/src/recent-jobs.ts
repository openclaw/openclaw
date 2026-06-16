/**
 * Per-user memory of the most recent legal-check job, kept server-side so the
 * agent can poll status without ever being handed the raw numeric jobId. The
 * id is an internal backend identifier and must not surface in the chat — see
 * legal_check_status, which defaults to the latest remembered job.
 */
export interface RecentJob {
  jobId: number;
  label: string | null;
  mode: "violation" | "rumor";
}

export class RecentJobStore {
  private readonly byUser = new Map<string, RecentJob>();

  /** Record the job just created for this user (overwrites any prior one). */
  remember(userId: string, job: RecentJob): void {
    this.byUser.set(userId, job);
  }

  /** The most recent job for this user, or undefined if none was created. */
  latest(userId: string): RecentJob | undefined {
    return this.byUser.get(userId);
  }
}
