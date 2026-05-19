export type UserMode = "chat" | "code" | "workflow" | "idle";

export type RecentAction = {
  label: string;
  callbackData: string;
  timestamp: number;
};

export type UserState = {
  mode: UserMode;
  recentActions: RecentAction[];
  pinnedWorkflows: string[];
  lastActiveAgent: string;
  lastModelId?: string;
};

const userStates = new Map<number, UserState>();

const MAX_RECENT = 5;

export function getUserState(userId: number): UserState {
  let state = userStates.get(userId);
  if (!state) {
    state = {
      mode: "idle",
      recentActions: [],
      pinnedWorkflows: [],
      lastActiveAgent: "main",
    };
    userStates.set(userId, state);
  }
  return state;
}

export function setUserMode(userId: number, mode: UserMode) {
  getUserState(userId).mode = mode;
}

export function trackAction(userId: number, label: string, callbackData: string) {
  const state = getUserState(userId);
  state.recentActions = [
    { label, callbackData, timestamp: Date.now() },
    ...state.recentActions.filter((a) => a.callbackData !== callbackData),
  ].slice(0, MAX_RECENT);
}

export function getQuickActions(userId: number): RecentAction[] {
  return getUserState(userId).recentActions.slice(0, 3);
}

export function getContextualGreeting(userId: number): string {
  const state = getUserState(userId);
  const hour = new Date().getHours();
  const timeGreeting =
    hour < 6 ? "🌙 深夜了" : hour < 12 ? "☀️ 早安" : hour < 18 ? "🌤 午安" : "🌆 晚安";

  switch (state.mode) {
    case "code":
      return `${timeGreeting}，目前在寫碼模式 💻`;
    case "chat":
      return `${timeGreeting}，對話中 💬`;
    case "workflow":
      return `${timeGreeting}，工作流執行中 🔄`;
    default:
      return `${timeGreeting}`;
  }
}
