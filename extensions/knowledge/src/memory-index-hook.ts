import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { memoryPrincipal } from "./access.js";
import type { MemoryCallerContext } from "./memory-provider-types.js";
import type { Stores } from "./stores.js";

type SessionAuthority = Extract<MemoryCallerContext["authority"], { kind: "session" }>;
/** The before_prompt_build context fields the index reads. */
type HookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  sandboxed?: boolean;
  memoryAudience?: SessionAuthority["audience"];
  assertMemoryAudienceCurrent?: () => void;
  hookInvocation?: Readonly<{ assertActive(): void }>;
};

/** The index cutoff: the first retained message's timestamp. It is the session's
 * first turn until compaction, then the compaction summary, so the rendered index
 * stays byte-stable between those points. A first turn with no history uses now;
 * its next turn moves the cutoff back to that turn's own message (accepted: a
 * record saved in that gap changes the index once). */
export function memoryIndexCutoff(messages: readonly unknown[], now: number): number {
  const first = messages.find(
    (m): m is { timestamp: unknown } => typeof m === "object" && m !== null && "timestamp" in m,
  );
  const at =
    typeof first?.timestamp === "number"
      ? first.timestamp
      : typeof first?.timestamp === "string"
        ? Date.parse(first.timestamp)
        : Number.NaN;
  return Number.isFinite(at) ? Math.min(at, now) : now;
}

// Rendered indexes pinned per session incarnation, store binding and cutoff.
// Edits keep a record's recorded_at, so re-rendering current records could
// change the system prompt between turns; the pin keeps it byte-stable until
// compaction or a new session moves the cutoff. Authority is still checked live
// on every turn before a pinned text is reused. A Gateway restart re-renders
// once (accepted: one prefix change per restart).
const MAX_PINNED_INDEXES = 512;
const pinnedIndexes = new Map<string, string>();

function pinIndex(key: string, text: string): void {
  pinnedIndexes.set(key, text);
  if (pinnedIndexes.size > MAX_PINNED_INDEXES) {
    pinnedIndexes.delete(pinnedIndexes.keys().next().value!);
  }
}

// Builds the provider-style caller context from the host-resolved hook audience.
function callerContext(ctx: HookContext): MemoryCallerContext | undefined {
  const audience = ctx.memoryAudience;
  if (!ctx.sessionKey || ctx.sandboxed || audience?.kind !== "owner-private") {
    return undefined;
  }
  return {
    authority: {
      kind: "session",
      sessionKey: ctx.sessionKey,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      sandboxed: false,
      audience,
    },
    assertCurrent() {
      ctx.hookInvocation?.assertActive();
      ctx.assertMemoryAudienceCurrent?.();
    },
  };
}

/** Reads the rendered standing index for an owner-private session, or "" when the
 * session has no owner-private audience or the agent has no provisioned store. */
export async function readMemoryIndex(
  stores: Stores,
  ctx: HookContext,
  asOf: number,
): Promise<string> {
  const context = callerContext(ctx);
  if (!context || !ctx.agentId) {
    return "";
  }
  const principal = memoryPrincipal(context, ctx.agentId, false, "default");
  // Reading never provisions: an agent without a store has nothing to index.
  const opened = await stores.open(principal, { provision: false });
  if (opened.kind !== "ready") {
    return "";
  }
  const { runtime, access, binding } = opened;
  // A binding can move to a different physical store (share, then use own), so the
  // vault identity keys the pin too.
  const key = JSON.stringify([
    ctx.agentId,
    ctx.sessionKey,
    ctx.sessionId ?? null,
    binding,
    runtime.vaultId,
    asOf,
  ]);
  const pinned = pinnedIndexes.get(key);
  if (pinned !== undefined) {
    access.assertCurrent();
    return pinned;
  }
  const result = await runtime.enqueue(access.assertCurrent, () =>
    runtime.client.call("memoryIndex", access, { asOf }),
  );
  access.assertCurrent();
  pinIndex(key, result.text);
  return result.text;
}

/** Appends the standing Knowledge index to owner-private sessions' system prompt.
 * Failures omit the index; they never block the turn. */
export function registerMemoryIndexHook(api: OpenClawPluginApi, stores: Stores): void {
  api.on("before_prompt_build", async (event, ctx) => {
    try {
      const text = await readMemoryIndex(
        stores,
        ctx,
        memoryIndexCutoff(event.messages, Date.now()),
      );
      return text ? { appendSystemContext: text } : undefined;
    } catch (error) {
      api.logger?.debug?.(`knowledge index omitted: ${String(error)}`);
      return undefined;
    }
  });
}
