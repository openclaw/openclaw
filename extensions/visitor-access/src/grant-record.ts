import { z } from "zod";
import { visitorTargetKey, type VisitorTarget } from "./cloudflare.js";

/** Human profile that ran visitor_invite, from trusted requester context, never tool input. */
export type VisitorInviter = { profileId: string; label?: string };

export type VisitorInvitationContext = {
  invitedVia?: string;
  invitedBy?: VisitorInviter;
  /** Trusted Gateway sign-in address for the invitation text; absent when not configured. */
  signInUrl?: string;
  assertCurrent: () => void;
};

export type VisitorOnboardingState = "pending" | "ready" | "failed";

/** Welcome-session setup progress; advanced only through compareAndSetOnboarding. */
export type VisitorOnboarding = {
  state: VisitorOnboardingState;
  welcomeSessionKey?: string;
  welcomeSessionId?: string;
  error?: string;
  updatedAt: number;
};

// Onboarding fields are absent on grants recorded before onboarding metadata existed.
export type VisitorGrant = ({ email: string } | { githubAccountId: number }) & {
  grantId?: string;
  githubLogin?: string;
  invitedVia?: string;
  invitedBy?: VisitorInviter;
  note?: string;
  onboarding?: VisitorOnboarding;
  createdAt: number;
  expiresAt: number | null;
};

/** Snapshot of a current grant; changes to it never reach the store. */
export type ActiveVisitorInvitation = VisitorGrant & { grantId: string };

export type VisitorOnboardingUpdate =
  | { applied: true; onboarding: VisitorOnboarding }
  | { applied: false; reason: "inactive" }
  | { applied: false; reason: "conflict"; onboarding?: VisitorOnboarding };

export type VisitorOnboardingCompareAndSet = {
  grantId: string;
  /** Matched by state and updatedAt; null matches a grant without onboarding progress. */
  expected: Pick<VisitorOnboarding, "state" | "updatedAt"> | null;
  next: Omit<VisitorOnboarding, "updatedAt">;
  assertCurrent?: () => void;
};

export const VISITOR_NOTE_MAX_CHARS = 1000;
const INVITER_LABEL_MAX_CHARS = 200;
const ONBOARDING_ERROR_MAX_CHARS = 500;

// No trimming: an explicitly supplied note replaces the previous note verbatim.
export const visitorNoteSchema = z.string().max(VISITOR_NOTE_MAX_CHARS);

/** A signed-in person's verified emails and GitHub account IDs. */
export type VisitorIdentity = { emails: readonly string[]; githubAccountIds?: readonly number[] };

/** Grant keys for an identity, checking emails before GitHub accounts. */
export function visitorIdentityKeys({ emails, githubAccountIds = [] }: VisitorIdentity): string[] {
  return [
    ...emails.map((email) => email.trim().toLowerCase()),
    ...githubAccountIds.map(visitorTargetKey),
  ];
}

export function visitorGrantTarget(grant: VisitorGrant): VisitorTarget {
  return "email" in grant ? grant.email : grant.githubAccountId;
}

/**
 * Renewal keeps the recorded inviter, note, and onboarding progress unless replaced; grants
 * recorded before onboarding metadata keep their absent progress. New invitations start pending.
 */
export function invitationMetadata(
  previous: VisitorGrant | undefined,
  supplied: { invitedBy?: VisitorInviter; note?: string },
  now: number,
): Pick<VisitorGrant, "invitedBy" | "note" | "onboarding"> {
  const { invitedBy } = supplied;
  const inviter = invitedBy
    ? {
        profileId: invitedBy.profileId,
        ...(invitedBy.label ? { label: invitedBy.label.slice(0, INVITER_LABEL_MAX_CHARS) } : {}),
      }
    : previous?.invitedBy;
  const note = supplied.note ?? previous?.note;
  const onboarding = previous ? previous.onboarding : { state: "pending" as const, updatedAt: now };
  return {
    ...(inviter ? { invitedBy: inviter } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(onboarding ? { onboarding } : {}),
  };
}

/** Decide one compare-and-set against the current durable record of an active grant. */
export function compareAndSetGrantOnboarding(
  current: VisitorGrant,
  { expected, next }: Pick<VisitorOnboardingCompareAndSet, "expected" | "next">,
  now: number,
): VisitorOnboardingUpdate {
  const recorded = current.onboarding;
  if (
    expected === null
      ? recorded !== undefined
      : recorded?.state !== expected.state || recorded.updatedAt !== expected.updatedAt
  ) {
    return { applied: false, reason: "conflict", ...(recorded ? { onboarding: recorded } : {}) };
  }
  const { state, welcomeSessionKey, welcomeSessionId, error } = next;
  return {
    applied: true,
    onboarding: {
      state,
      ...(welcomeSessionKey ? { welcomeSessionKey } : {}),
      ...(welcomeSessionId ? { welcomeSessionId } : {}),
      ...(error ? { error: error.slice(0, ONBOARDING_ERROR_MAX_CHARS) } : {}),
      // pending-to-pending reserves the session before setup; it must change the CAS token
      // even when two sign-ins arrive in the same millisecond or the clock moves backward.
      updatedAt: Math.max(now, (recorded?.updatedAt ?? -1) + 1),
    },
  };
}
