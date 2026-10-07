export type ClawHubPublicationState =
  | { state: "published" | "absent" }
  | { state: "pending"; stage: "staging"; attemptId?: never }
  | { state: "pending"; stage: "checks" | "finalization"; attemptId: string }
  | { state: "failed"; attemptId?: string; recoverable: boolean };

export function isClawHubPublishAttemptId(value: unknown): value is string;
export function classifyClawHubPublication(
  body: unknown,
  expected: { name: string; version: string },
): ClawHubPublicationState | null;
