/** Host-owned accepted input; serializing or copying the carrier grants no admission. */
export type ForegroundUserRequest = Readonly<{ kind: "foreground-user-request" }>;
// Claims compare the admitted owner's exact identity without importing its admission lifecycle.
type Source = { assertCurrent: () => void; owner?: object };
const sources = new WeakMap<ForegroundUserRequest, readonly Source[]>();
const requestKey = Symbol("accepted foreground user input");
type RequestOwner = { [requestKey]?: ForegroundUserRequest };

function createRequest(value: readonly Source[]): ForegroundUserRequest {
  const request = Object.freeze({ kind: "foreground-user-request" as const });
  sources.set(request, value);
  return request;
}

/** Called only after the Gateway or channel ingress owner accepts authenticated user input. */
export function bindForegroundUserRequest(owner: object, assertCurrent: () => void): void {
  assertCurrent();
  Object.defineProperty(owner, requestKey, {
    value: createRequest([{ assertCurrent }]),
    enumerable: true,
    configurable: true,
  });
}

export function getForegroundUserRequest(
  owner: object | undefined,
): ForegroundUserRequest | undefined {
  // SAFETY: The private symbol retrieves a candidate; WeakMap identity grants admission.
  const request = (owner as RequestOwner | undefined)?.[requestKey];
  return request && sources.has(request) ? request : undefined;
}

/** Collection can join real user inputs, but cannot promote an autonomous queue item. */
export function combineForegroundUserRequests(
  values: readonly (ForegroundUserRequest | undefined)[],
): ForegroundUserRequest | undefined {
  const batches = values.map((value) => value && sources.get(value));
  return batches.length > 0 && batches.every((batch) => batch !== undefined)
    ? createRequest([...new Set(batches.flatMap((batch) => batch ?? []))])
    : undefined;
}

/** Claim only when foreground policy is required; ordinary queued work keeps its existing lifetime. */
export function prepareForegroundUserRequestClaim(
  request: ForegroundUserRequest | undefined,
  owner: object,
): (() => void) | undefined {
  const batch = request && sources.get(request);
  if (!batch) {
    return undefined;
  }
  return () => {
    for (const source of batch) {
      if (source.owner && source.owner !== owner) {
        throw new Error("User input already belongs to another foreground request.");
      }
      source.assertCurrent();
    }
    // Validate every collected source before atomically claiming the batch.
    // A retry may keep its incarnation; another restricted run cannot reuse it.
    for (const source of batch) {
      source.owner = owner;
    }
  };
}
