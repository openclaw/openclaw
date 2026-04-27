import { pruneStaleCommandPolls as pruneStaleCommandPollsImpl } from "./command-poll-backoff.js";
export function pruneStaleCommandPolls(...args) {
    return pruneStaleCommandPollsImpl(...args);
}
