import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { OAuthRefreshFailureError } from "./oauth-refresh-failure.js";
import { isExactOAuthCredential } from "./oauth-refresh-fence.js";
import type { OAuthCredential } from "./types.js";

export type OAuthRefreshCohort = {
  assertNoFailure(authPath: string, credential: OAuthCredential): void;
  fail(authPath: string, credential: OAuthCredential, error: OAuthRefreshFailureError): void;
};

/** Serialize refreshes while sharing a settled transient failure only with waiting admissions. */
export function createOAuthRefreshQueue() {
  type Admission = OAuthRefreshCohort & { pending: number; retire(): void };
  let queue = new KeyedAsyncQueue();
  const cohorts = new Map<string, Admission>();

  return {
    enqueue<T>(
      provider: string,
      profileId: string,
      task: (cohort: OAuthRefreshCohort) => Promise<T>,
    ) {
      const key = `${provider}\u0000${profileId}`;
      let cohort = cohorts.get(key);
      if (!cohort) {
        const failures = new Map<
          string,
          { credential: OAuthCredential; error: OAuthRefreshFailureError }
        >();
        const admitted: Admission = {
          pending: 0,
          assertNoFailure(authPath, credential) {
            const failure = failures.get(authPath);
            if (failure && isExactOAuthCredential(credential, failure.credential)) {
              throw failure.error;
            }
          },
          fail(authPath, credential, error) {
            // Retire immediately so later admissions can retry. Existing waiters
            // retain this exact owner/generation failure until their queue tasks settle.
            failures.set(authPath, { credential, error });
            admitted.retire();
          },
          retire() {
            if (cohorts.get(key) === admitted) {
              cohorts.delete(key);
            }
          },
        };
        cohorts.set(key, admitted);
        cohort = admitted;
      }
      const admitted = cohort;
      admitted.pending++;
      return queue.enqueue(key, () => task(admitted), {
        onSettle() {
          if (--admitted.pending === 0) {
            admitted.retire();
          }
        },
      });
    },
    reset() {
      queue = new KeyedAsyncQueue();
      cohorts.clear();
    },
  };
}
