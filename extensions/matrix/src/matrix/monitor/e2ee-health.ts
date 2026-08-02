import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixRawEvent } from "./types.js";

const FAILURE_WINDOW_MS = 2 * 60_000;
const FAILURE_THRESHOLD = 3;
const FAILURE_SAMPLE_LIMIT = 3;
const ENCRYPTED_EVENT_TRACK_LIMIT = 512;
const COHORT_SUCCESS_TRACK_LIMIT = 512;
export const MATRIX_E2EE_DEGRADED_COHORT_LIMIT = 512;

type FailureObservation = {
  key: string;
  cohortKey: string;
  roomId: string;
  eventId: string;
  sender: string | null;
  eventTs: number;
  arrivalSequence: number;
  error: string;
};

type FailureCohort = {
  latestEventTs: number;
  latestArrivalSequence: number;
};

type EncryptedEventArrival = {
  sequence: number;
  cohortKey: string;
};

type CohortSuccess = {
  arrivalSequence: number;
  eventTs: number;
};

export function formatMatrixE2eeDegradationHint(accountId: string): string {
  return (
    "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. " +
    "This device may still be missing new room keys. " +
    `Check 'openclaw matrix verify status --verbose --account ${accountId}' and 'openclaw matrix devices list --account ${accountId}'.`
  );
}

export function formatMatrixE2eeCohortOverflowHint(): string {
  return (
    "matrix: E2EE degradation exceeded the tracked encrypted sender cohort limit; " +
    "automatic recovery is disabled until the Matrix monitor restarts."
  );
}

function isFreshPostHealthySyncFailure(params: {
  event: MatrixRawEvent;
  healthySyncSinceMs?: number;
  graceMs?: number;
  nowMs: number;
}): boolean {
  const { event, healthySyncSinceMs, graceMs = 0, nowMs } = params;
  if (typeof healthySyncSinceMs !== "number" || !Number.isFinite(healthySyncSinceMs)) {
    return false;
  }
  const eventTs = event.origin_server_ts;
  if (!Number.isFinite(eventTs) || eventTs <= 0) {
    return false;
  }
  if (eventTs < healthySyncSinceMs + graceMs) {
    return false;
  }
  if (eventTs > nowMs + 60_000) {
    return false;
  }
  return true;
}

export function createMatrixE2eeHealthTracker(params: {
  getHealthySyncSinceMs?: () => number | undefined;
  startupGraceMs?: number;
}) {
  let observations: FailureObservation[] = [];
  let warningEmitted = false;
  const degradedCohorts = new Map<string, FailureCohort>();
  let degradedCohortOverflow = false;
  let encryptedEventSequence = 0;
  const encryptedEventArrivals = new Map<string, EncryptedEventArrival>();
  const latestSuccessByCohort = new Map<string, CohortSuccess>();
  let trackedHealthySyncSinceMs: number | undefined;

  const eventKey = (roomId: string, event: MatrixRawEvent) => `${roomId}|${event.event_id}`;
  const cohortKey = (roomId: string, event: MatrixRawEvent) => {
    const deviceId = normalizeOptionalString(event.content?.device_id);
    const senderKey = normalizeOptionalString(event.content?.sender_key);
    return JSON.stringify([roomId, event.sender, deviceId || null, senderKey || null]);
  };

  const takeEncryptedEventArrival = (roomId: string, event: MatrixRawEvent) => {
    const key = eventKey(roomId, event);
    const arrival = encryptedEventArrivals.get(key);
    encryptedEventArrivals.delete(key);
    return arrival;
  };

  const resetFailureWave = () => {
    observations = [];
    warningEmitted = false;
  };

  const clearDegradation = () => {
    resetFailureWave();
    degradedCohorts.clear();
    degradedCohortOverflow = false;
  };

  const recordCohortFailure = (observation: FailureObservation) => {
    const current = degradedCohorts.get(observation.cohortKey);
    if (!current && degradedCohorts.size >= MATRIX_E2EE_DEGRADED_COHORT_LIMIT) {
      const overflowTriggered = !degradedCohortOverflow;
      degradedCohortOverflow = true;
      return overflowTriggered;
    }
    degradedCohorts.set(observation.cohortKey, {
      latestEventTs: Math.max(current?.latestEventTs ?? 0, observation.eventTs),
      latestArrivalSequence: Math.max(
        current?.latestArrivalSequence ?? 0,
        observation.arrivalSequence,
      ),
    });
    return false;
  };

  const recordCohortSuccess = (cohort: string, success: CohortSuccess) => {
    const current = latestSuccessByCohort.get(cohort);
    if (current !== undefined && current.arrivalSequence >= success.arrivalSequence) {
      return;
    }
    latestSuccessByCohort.delete(cohort);
    latestSuccessByCohort.set(cohort, success);
    if (latestSuccessByCohort.size > COHORT_SUCCESS_TRACK_LIMIT) {
      const oldestCohort = latestSuccessByCohort.keys().next().value!;
      latestSuccessByCohort.delete(oldestCohort);
    }
  };

  const pruneObservations = (nowMs: number) => {
    observations = observations.filter((entry) => nowMs - entry.eventTs <= FAILURE_WINDOW_MS);
    if (observations.length === 0) {
      warningEmitted = false;
    }
  };

  return {
    recordEncryptedEvent(roomId: string, event: MatrixRawEvent) {
      encryptedEventSequence += 1;
      const key = eventKey(roomId, event);
      encryptedEventArrivals.delete(key);
      encryptedEventArrivals.set(key, {
        sequence: encryptedEventSequence,
        cohortKey: cohortKey(roomId, event),
      });
      if (encryptedEventArrivals.size > ENCRYPTED_EVENT_TRACK_LIMIT) {
        const oldestKey = encryptedEventArrivals.keys().next().value!;
        encryptedEventArrivals.delete(oldestKey);
      }
    },
    recordSuccess(roomId: string, event: MatrixRawEvent, isInbound: boolean) {
      const arrival = takeEncryptedEventArrival(roomId, event);
      if (!isInbound || !arrival) {
        return false;
      }
      const eventTs = event.origin_server_ts;
      if (!Number.isFinite(eventTs)) {
        return false;
      }
      recordCohortSuccess(arrival.cohortKey, {
        arrivalSequence: arrival.sequence,
        eventTs,
      });
      if (degradedCohorts.size === 0 && !degradedCohortOverflow) {
        return false;
      }
      const cohort = degradedCohorts.get(arrival.cohortKey);
      if (!cohort) {
        return false;
      }
      if (arrival.sequence <= cohort.latestArrivalSequence || eventTs < cohort.latestEventTs) {
        return false;
      }
      degradedCohorts.delete(arrival.cohortKey);
      if (degradedCohorts.size > 0 || degradedCohortOverflow) {
        return false;
      }
      clearDegradation();
      return true;
    },
    recordFailure(roomId: string, event: MatrixRawEvent, error: Error, isInbound: boolean) {
      const nowMs = Date.now();
      const arrival = takeEncryptedEventArrival(roomId, event);
      if (!isInbound || !arrival) {
        return { freshAfterHealthySync: false, failureCount: 0 } as const;
      }
      const latestSuccess = latestSuccessByCohort.get(arrival.cohortKey);
      if (
        latestSuccess !== undefined &&
        latestSuccess.arrivalSequence > arrival.sequence &&
        latestSuccess.eventTs >= event.origin_server_ts
      ) {
        return { freshAfterHealthySync: false, failureCount: 0 } as const;
      }
      const healthySyncSinceMs = params.getHealthySyncSinceMs?.();
      if (healthySyncSinceMs !== trackedHealthySyncSinceMs) {
        trackedHealthySyncSinceMs = healthySyncSinceMs;
        resetFailureWave();
      }
      if (
        !isFreshPostHealthySyncFailure({
          event,
          healthySyncSinceMs,
          graceMs: params.startupGraceMs,
          nowMs,
        })
      ) {
        return { freshAfterHealthySync: false, failureCount: 0 } as const;
      }

      pruneObservations(nowMs);
      const key = eventKey(roomId, event);
      const isNewObservation = !observations.some((entry) => entry.key === key);
      let cohortOverflowed = false;
      if (isNewObservation) {
        observations.push({
          key,
          cohortKey: arrival.cohortKey,
          roomId,
          eventId: event.event_id,
          sender: typeof event.sender === "string" ? event.sender : null,
          eventTs: event.origin_server_ts,
          arrivalSequence: arrival.sequence,
          error: error.message,
        });
        if (degradedCohorts.size > 0 || degradedCohortOverflow) {
          cohortOverflowed = recordCohortFailure(observations.at(-1)!);
        }
      }

      const failureCount = observations.length;
      if (warningEmitted || failureCount < FAILURE_THRESHOLD) {
        return { freshAfterHealthySync: true, failureCount, cohortOverflowed } as const;
      }

      warningEmitted = true;
      for (const observation of observations) {
        cohortOverflowed = recordCohortFailure(observation) || cohortOverflowed;
      }
      const rooms = uniqueStrings(observations.map((entry) => entry.roomId)).slice(
        0,
        FAILURE_SAMPLE_LIMIT,
      );
      const senders = uniqueStrings(
        observations
          .map((entry) => entry.sender)
          .filter((sender): sender is string => Boolean(sender)),
      ).slice(0, FAILURE_SAMPLE_LIMIT);
      const eventIds = observations.slice(-FAILURE_SAMPLE_LIMIT).map((entry) => entry.eventId);
      return {
        freshAfterHealthySync: true,
        failureCount,
        cohortOverflowed,
        warning: {
          rooms,
          roomCount: new Set(observations.map((entry) => entry.roomId)).size,
          senders,
          senderCount: new Set(observations.map((entry) => entry.sender).filter(Boolean)).size,
          eventIds,
          latestError: observations.at(-1)?.error ?? error.message,
          windowMs: FAILURE_WINDOW_MS,
        },
      } as const;
    },
  };
}
