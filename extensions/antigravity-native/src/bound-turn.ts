import { resolve } from "node:path";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { AgyCatalog } from "./catalog.js";
import { isAgyConversationId, runAgyTurn, type AgyTurnResult } from "./turn.js";

/** Values supplied by the admitted route, not inferred from environment variables. */
export type AgyRoute = Readonly<{
  backend: "account" | "gemini-key";
  /** Opaque identity of the prepared profile/placement, never key material. */
  profile: string;
  model: string;
}>;

export type AgySessionBinding = {
  version: 1;
  route: AgyRoute;
  workspace: string;
  conversationId: string;
};

type WireOptions = Parameters<typeof runAgyTurn>[0];
type OwnedPlacement = AsyncDisposable & { readonly launch: WireOptions["launch"] };

type BoundAgyTurnOptions = Pick<WireOptions, "prompt" | "signal" | "assertCurrent" | "onDelta"> & {
  /** Core serializes runs and reset for this canonical OpenClaw session. */
  sessionId: string;
  workspace: string;
  route: AgyRoute;
  catalog: Readonly<Pick<AgyRoute, "backend" | "profile"> & { models: AgyCatalog }>;
  store: Pick<PluginStateKeyedStore<AgySessionBinding, 2>, "lookup" | "registerIfAbsent">;
  /** The placement owner admits the selected route without exposing ambient host env.
   * Disposal joins bridge cleanup and any admitted host operations, even if the child never starts.
   */
  preparePlacement: (conversationId: string | undefined) => Promise<OwnedPlacement>;
};

export async function runBoundAgyTurn(options: BoundAgyTurnOptions): Promise<AgyTurnResult> {
  const { route, store, sessionId } = options;
  const workspace = resolve(options.workspace);
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  assertCurrent();
  if (
    options.catalog.backend !== route.backend ||
    options.catalog.profile !== route.profile ||
    !options.catalog.models.some(({ id }) => id === route.model)
  ) {
    throw new Error("The selected Antigravity model is not in this profile's catalog.");
  }
  const previous = await store.lookup(sessionId);
  assertCurrent();
  if (
    previous &&
    (previous.version !== 1 ||
      !isAgyConversationId(previous.conversationId) ||
      previous.workspace !== workspace ||
      previous.route?.backend !== route.backend ||
      previous.route.profile !== route.profile ||
      previous.route.model !== route.model)
  ) {
    throw new Error(
      "The Antigravity session no longer matches its workspace, profile, or model. Start a new session explicitly.",
    );
  }
  await using placement = await options.preparePlacement(previous?.conversationId);
  assertCurrent();
  return await runAgyTurn({
    launch: placement.launch,
    requestedModel: route.model,
    expectedConversationId: previous?.conversationId,
    prompt: options.prompt,
    signal: options.signal,
    assertCurrent,
    onDelta: options.onDelta,
    bindConversation: async ({ conversationId }) => {
      if (!previous) {
        assertCurrent();
        const created = await store.registerIfAbsent(sessionId, {
          version: 1,
          route,
          workspace,
          conversationId,
        });
        if (!created) {
          throw new Error(
            "The Antigravity session was bound by another operation. No prompt was sent.",
          );
        }
        assertCurrent();
      }
    },
  });
}
