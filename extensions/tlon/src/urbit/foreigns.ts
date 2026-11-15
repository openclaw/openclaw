// Only the invitation fields consumed by discovery and admission belong to this transport view.
export type Foreigns = Record<
  string,
  {
    invites: Array<{ from: string; valid: boolean }>;
    progress: "ask" | "join" | "watch" | "done" | "error" | null;
  }
>;

export type DmInvite = { ship: string };
