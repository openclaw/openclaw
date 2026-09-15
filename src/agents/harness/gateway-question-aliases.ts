import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";

type AliasedQuestion = {
  sessionKey: string;
  answerAuthority?: {
    assertActive: () => void;
    assertCaller: (caller: ReplyToolAuthorityOverlay) => void;
  };
};

export type QuestionAnswerRoute = Readonly<{
  state: AliasedQuestion;
  assertCaller: (caller: ReplyToolAuthorityOverlay) => void;
}>;

/**
 * Answer aliases let another conversation's plain-text replies resolve a pending
 * question, such as the chat that requested a voice consult. They live apart from
 * question ownership: an alias never occupies that chat's own question slot, and
 * an owning registration always wins the lookup.
 */
const aliases = resolveGlobalMap<string, AliasedQuestion>(
  Symbol.for("openclaw.pendingAgentQuestionAliases"),
  (entries) => entries.clear(),
);

function requireAnswerAuthority(state: AliasedQuestion) {
  if (!state.answerAuthority) {
    throw new Error("pending question has no prepared creator authority");
  }
  return state.answerAuthority;
}

export const questionAliases = Object.freeze({
  /** Points each free alias key at the state; a key already aliased elsewhere is left alone. */
  register(state: AliasedQuestion, aliasKeys: readonly string[] | undefined): ReadonlySet<string> {
    const registered = new Set<string>();
    for (const rawKey of aliasKeys ?? []) {
      const aliasKey = rawKey.trim();
      if (aliasKey && aliasKey !== state.sessionKey && !aliases.has(aliasKey)) {
        aliases.set(aliasKey, state);
        registered.add(aliasKey);
      }
    }
    return registered;
  },
  /** Removes only the alias entries that still point at this state. */
  release(state: AliasedQuestion, aliasKeys: ReadonlySet<string>): void {
    for (const aliasKey of aliasKeys) {
      if (aliases.get(aliasKey) === state) {
        aliases.delete(aliasKey);
      }
    }
  },
  /**
   * Resolves the pending question a plain-text reply may answer. An owning-session
   * answer keeps the creator's full policy check. An alias answer is a narrower
   * binding: the creator must still be active, the alias must still be current,
   * and only the owner of that exact conversation may answer. The run that asked
   * gains no trace authority from it.
   */
  resolveAnswerRoute(
    owners: ReadonlyMap<string, AliasedQuestion>,
    sessionKey: string | undefined,
  ): QuestionAnswerRoute | undefined {
    const lookupKey = sessionKey?.trim() ?? "";
    if (!lookupKey) {
      return undefined;
    }
    const owning = owners.get(lookupKey);
    if (owning) {
      return {
        state: owning,
        assertCaller: (caller) => requireAnswerAuthority(owning).assertCaller(caller),
      };
    }
    const aliased = aliases.get(lookupKey);
    if (!aliased) {
      return undefined;
    }
    return {
      state: aliased,
      assertCaller: (caller) => {
        requireAnswerAuthority(aliased).assertActive();
        if (aliases.get(lookupKey) !== aliased) {
          throw new Error("requester answer route is no longer current");
        }
        if (!caller.senderIsOwner) {
          throw new Error("requester answer requires the owner of the requesting conversation");
        }
      },
    };
  },
});
