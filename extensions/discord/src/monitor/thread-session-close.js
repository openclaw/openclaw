import { resolveStorePath, updateSessionStore } from "../../../../src/config/sessions.js";
async function closeDiscordThreadSessions(params) {
  const { cfg, accountId, threadId } = params;
  const normalizedThreadId = threadId.trim().toLowerCase();
  if (!normalizedThreadId) {
    return 0;
  }
  const segmentRe = new RegExp(`:${normalizedThreadId}(?::|$)`, "i");
  function sessionKeyContainsThreadId(key) {
    return segmentRe.test(key);
  }
  const storePath = resolveStorePath(cfg.session?.store, { agentId: accountId });
  let resetCount = 0;
  await updateSessionStore(storePath, (store) => {
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || !sessionKeyContainsThreadId(key)) {
        continue;
      }
      entry.updatedAt = 0;
      resetCount += 1;
    }
    return resetCount;
  });
  return resetCount;
}
export {
  closeDiscordThreadSessions
};
