import { pruneStaleCommandPolls as pruneStaleCommandPollsImpl } from "./command-poll-backoff.js";

type PruneStaleCommandPolls =
	typeof import("./command-poll-backoff.js").pruneStaleCommandPolls;

export function pruneStaleCommandPolls(
	...args: Parameters<PruneStaleCommandPolls>
): ReturnType<PruneStaleCommandPolls> {
	return pruneStaleCommandPollsImpl(...args);
}
