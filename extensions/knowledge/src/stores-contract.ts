import { Type, type Static } from "typebox";
/** Agent IDs Knowledge can bind; host agents outside this shape are reported unsupported. */
export const AGENT_ID = "^[a-z][a-z0-9_-]{0,63}$";
/** Stable named-store keys. Keys are identities, never paths or display text. */
export const STORE_KEY = "^[a-z][a-z0-9-]{0,47}$";
/** A grantable conversation: an agent-scoped session key below the agent's root. */
export const GRANT_SESSION_KEY = "^agent:[a-z][a-z0-9_-]{0,63}:\\S{1,440}$";

const agent = Type.String({ pattern: AGENT_ID });
const storeKey = Type.String({ pattern: STORE_KEY });
const revision = Type.String({ pattern: "^[a-f0-9]{64}$" });
const requestId = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
const message = Type.String({ maxLength: 1000 });

/** Lifecycle of a logical store as the registry knows it (spec §5.2). */
export const StoreState = Type.Union([
  Type.Literal("unprovisioned"),
  Type.Literal("initializing"),
  Type.Literal("ready"),
  Type.Literal("unavailable"),
  Type.Literal("recovery-required"),
]);
export type StoreState = Static<typeof StoreState>;

/** One logical store: a named store, or an agent's isolated default. */
export const StoreEntry = Type.Object(
  {
    binding: Type.String({ maxLength: 120 }),
    kind: Type.Union([Type.Literal("named"), Type.Literal("isolated")]),
    key: Type.Optional(storeKey),
    owner: Type.Optional(agent),
    label: Type.String({ maxLength: 120 }),
    members: Type.Array(agent, { maxItems: 100 }),
    /** Retained: provisioned but no longer authored in configuration. */
    retained: Type.Boolean(),
    state: StoreState,
    /** Authorized private-partition record count; null when not known without opening storage. */
    records: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type StoreEntry = Static<typeof StoreEntry>;

const AgentEntry = Type.Object(
  {
    id: Type.String({ maxLength: 120 }),
    name: Type.String({ maxLength: 120 }),
    supported: Type.Boolean(),
    /** Effective store binding; absent when membership is invalid or the agent is unsupported. */
    binding: Type.Optional(Type.String({ maxLength: 120 })),
    issue: Type.Optional(message),
  },
  { additionalProperties: false },
);
type AgentEntry = Static<typeof AgentEntry>;

const grantAccess = Type.Union([Type.Literal("read"), Type.Literal("read-write")]);
/** What an owner grant lets a conversation do with its agent's private knowledge. */
export type GrantAccess = Static<typeof grantAccess>;
const grantSessionKey = Type.String({ pattern: GRANT_SESSION_KEY, maxLength: 512 });
/** One owner grant: a conversation's access to its agent's private knowledge. */
const GrantEntry = Type.Object(
  { sessionKey: grantSessionKey, agent: Type.String({ maxLength: 120 }), access: grantAccess },
  { additionalProperties: false },
);
export type GrantEntry = Static<typeof GrantEntry>;

export const StoresSnapshot = Type.Object(
  {
    revision,
    /** Owner conversation grants and the revision grant changes are made against. */
    grants: Type.Object(
      { revision, entries: Type.Array(GrantEntry, { maxItems: 500 }) },
      { additionalProperties: false },
    ),
    /** Absent when several agents are configured without a default. */
    defaultAgent: Type.Optional(Type.String({ maxLength: 120 })),
    agents: Type.Array(AgentEntry, { maxItems: 200 }),
    stores: Type.Array(StoreEntry, { maxItems: 500 }),
    /** Whether this caller may change assignments, and why not. */
    canChange: Type.Boolean(),
    changeUnavailable: Type.Optional(message),
    issues: Type.Array(message, { maxItems: 50 }),
  },
  { additionalProperties: false },
);
export type StoresSnapshot = Static<typeof StoresSnapshot>;

export const StoreChange = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("share_existing"),
      label: Type.String({ minLength: 1, maxLength: 80 }),
      agents: Type.Array(agent, { minItems: 1, maxItems: 99 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("use_named"), store: storeKey },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("use_own") }, { additionalProperties: false }),
]);
export type StoreChange = Static<typeof StoreChange>;

export const StoresChangeInput = Type.Object(
  {
    requestId,
    expectedRevision: revision,
    agent,
    change: StoreChange,
  },
  { additionalProperties: false },
);
export type StoresChangeInput = Static<typeof StoresChangeInput>;

/** Grant, change or revoke ("none") one conversation's access to its agent's
 * private knowledge. Thread and other child sessions of the conversation inherit it. */
export const GrantChangeInput = Type.Object(
  {
    expectedRevision: revision,
    sessionKey: grantSessionKey,
    access: Type.Union([grantAccess, Type.Literal("none")]),
  },
  { additionalProperties: false },
);
export type GrantChangeInput = Static<typeof GrantChangeInput>;

/** Typed outcomes; a rejected change never partially applies. */
const ChangeOutcome = Type.Union([
  Type.Literal("applied"),
  Type.Literal("not-applied"),
  Type.Literal("conflict"),
  Type.Literal("forbidden"),
  Type.Literal("invalid"),
  Type.Literal("pending"),
  Type.Literal("unknown"),
]);
export const StoresChangeOutput = Type.Object(
  {
    outcome: ChangeOutcome,
    message,
    snapshot: Type.Optional(StoresSnapshot),
  },
  { additionalProperties: false },
);
export type StoresChangeOutput = Static<typeof StoresChangeOutput>;

/** Operator-only proxy that reads or writes as a selected agent's effective
 * store. The host forwards no selector for session actions without a session,
 * and native tools must never carry one, so selection is an explicit
 * tool-less operation. */
export const AgentProxyInput = Type.Object(
  {
    agent,
    operation: Type.String({ pattern: "^[a-z][a-z_]{0,40}$" }),
    input: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type AgentProxyInput = Static<typeof AgentProxyInput>;
