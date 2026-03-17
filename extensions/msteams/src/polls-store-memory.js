import {
  normalizeMSTeamsPollSelections
} from "./polls.js";
function createMSTeamsPollStoreMemory(initial = []) {
  const polls = /* @__PURE__ */ new Map();
  for (const poll of initial) {
    polls.set(poll.id, { ...poll });
  }
  const createPoll = async (poll) => {
    polls.set(poll.id, { ...poll });
  };
  const getPoll = async (pollId) => polls.get(pollId) ?? null;
  const recordVote = async (params) => {
    const poll = polls.get(params.pollId);
    if (!poll) {
      return null;
    }
    const normalized = normalizeMSTeamsPollSelections(poll, params.selections);
    poll.votes[params.voterId] = normalized;
    poll.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    polls.set(poll.id, poll);
    return poll;
  };
  return { createPoll, getPoll, recordVote };
}
export {
  createMSTeamsPollStoreMemory
};
