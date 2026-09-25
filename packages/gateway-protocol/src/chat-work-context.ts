/** Bounded, untrusted send-time reference data; never routing or authorization. */
export const CHAT_WORK_CONTEXT_LIMITS = {
  page: 64,
  title: 96,
  sessionKey: 192,
  sessionId: 64,
  agentId: 64,
  workspace: 224,
  file: 224,
  selection: 640,
} as const;

export type ChatWorkContext = { page: string } & Partial<
  Record<Exclude<keyof typeof CHAT_WORK_CONTEXT_LIMITS, "page">, string>
>;
