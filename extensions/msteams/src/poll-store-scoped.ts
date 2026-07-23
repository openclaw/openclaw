import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { MSTeamsPoll, MSTeamsPollStore } from "./polls.js";

export function createAccountScopedMSTeamsPollStore(
  store: MSTeamsPollStore,
  accountId: string,
): MSTeamsPollStore {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return store;
  }
  const prefix = `${accountId}:`;
  const scopedId = (pollId: string) => `${prefix}${pollId}`;
  const unscopedPoll = (poll: MSTeamsPoll | null): MSTeamsPoll | null => {
    if (!poll) {
      return null;
    }
    return {
      ...poll,
      id: poll.id.startsWith(prefix) ? poll.id.slice(prefix.length) : poll.id,
    };
  };
  return {
    createPoll: async (poll) => await store.createPoll({ ...poll, id: scopedId(poll.id) }),
    getPoll: async (pollId) => unscopedPoll(await store.getPoll(scopedId(pollId))),
    recordVote: async (params) =>
      unscopedPoll(await store.recordVote({ ...params, pollId: scopedId(params.pollId) })),
  };
}
