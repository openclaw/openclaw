import { AsyncLocalStorage } from "node:async_hooks";

// The adapter owns the invocation scope; REST requests retain its assertion
// individually so shared queues cannot inherit another action's authority.
export const discordConversationReadAuthority = new AsyncLocalStorage<(() => void) | undefined>();
