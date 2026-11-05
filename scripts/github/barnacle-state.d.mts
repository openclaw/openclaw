export const BARNACLE: Map<number, number>;
export function time(value?: string): number;
export function trustedBarnacle(comment: unknown): boolean;
export function verifiedComment(
  comment: unknown,
  body: string,
  expectedAppId: number,
  existing?: boolean,
): boolean;
export function labelsOf(item: unknown): string[];
export function cheapProtection(item: unknown): string | null;
export function admissionKey(item: unknown): string;
export function freshTarget(
  github: unknown,
  context: unknown,
  number: number,
): Promise<Record<string, unknown>>;
export function ownershipProtection(io: unknown, item: unknown): Promise<string | null>;
export function securityProtection(comments: unknown[], item: unknown): string | null;
export function humanActivityAt(snapshot: unknown, ignoredComment?: number): number;
export function reader(
  github: unknown,
  checksGithub: unknown,
  context: unknown,
  budget: number,
): unknown;
export function snapshotOf(
  github: unknown,
  checksGithub: unknown,
  io: unknown,
  number: number,
  kind?: "issue" | "pull-request",
  inspectChecks?: boolean,
): Promise<Record<string, unknown>>;
