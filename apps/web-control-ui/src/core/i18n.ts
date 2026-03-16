export type Language = "zh" | "en";

export const translations = {
  zh: {
    // Control Mode - Main sections
    workspace: "工作区",
    rollbackFirst: "Rollback First",
    chat: "对话",
    sessions: "会话",

    // Workspace section
    workspaceStatus: "工作区状态",
    currentBranch: "当前分支",
    workingDirectory: "工作目录",
    lastSync: "最后同步",
    refresh: "刷新",
    loading: "加载中...",

    // Rollback section
    checkpointRef: "Checkpoint 引用",
    checkpointRefPlaceholder: "例如：checkpoint/web-control-ui-20260315-143022-feature-name",
    restoreCheckpoint: "恢复 checkpoint",
    executing: "执行中...",
    recentVersions: "最近版本",
    noCheckpointHistory: "暂无 checkpoint 历史",
    queryViaChat: "通过对话查询",
    checkpointHistoryUnavailableHint: "当前网关不支持直接读取版本历史，请用右上角按钮通过对话链路查询最近版本。",
    restoreToThisVersion: "恢复到此版本",

    // Time formatting
    justNow: "刚刚",
    minutesAgo: "分钟前",
    hoursAgo: "小时前",
    yesterday: "昨天",
    daysAgo: "天前",

    // Chat section
    chatPlaceholder: "输入消息...",
    send: "发送",
    filterAll: "全部",
    filterReply: "回复",
    filterStatus: "状态",
    filterBuild: "构建",
    filterCommand: "命令",

    // Sessions section
    loadSessions: "加载会话",
    sessionKey: "会话 Key",
    lastActivity: "最后活动",
    messageCount: "消息数",
    switchTo: "切换到",
    noSessions: "暂无会话",

    // Preferences
    preferences: "偏好设置",
    visualStyle: "视觉风格",
    layout: "布局",
    modules: "模块",
    dislikes: "不喜欢",
    currentGoal: "当前目标",
    savePreferences: "保存偏好",

    // Connection
    connecting: "连接中...",
    connected: "已连接",
    disconnected: "已断开",
    connectionError: "连接错误",

    // Errors
    loadCheckpointError: "加载 checkpoint 历史失败",

    // Language
    language: "语言",
    chinese: "中文",
    english: "English",

    // App Shell
    modeUse: "USE",
    modeControl: "CONTROL",
    usageLabel: "usage",

    // Error messages
    loadStatusError: "加载状态失败",
    loadChatHistoryError: "加载聊天记录失败",
    connectionClosed: "连接关闭",
    eventSequenceGap: "事件序列出现缺口：期望 {expected}，收到 {received}",
    sendError: "发送失败",
    checkpointRefRequired: "请先填写要恢复的 checkpoint ref",
  },
  en: {
    // Control Mode - Main sections
    workspace: "Workspace",
    rollbackFirst: "Rollback First",
    chat: "Chat",
    sessions: "Sessions",

    // Workspace section
    workspaceStatus: "Workspace Status",
    currentBranch: "Current Branch",
    workingDirectory: "Working Directory",
    lastSync: "Last Sync",
    refresh: "Refresh",
    loading: "Loading...",

    // Rollback section
    checkpointRef: "Checkpoint Reference",
    checkpointRefPlaceholder: "e.g., checkpoint/web-control-ui-20260315-143022-feature-name",
    restoreCheckpoint: "Restore Checkpoint",
    executing: "Executing...",
    recentVersions: "Recent Versions",
    noCheckpointHistory: "No checkpoint history",
    queryViaChat: "Query via chat",
    checkpointHistoryUnavailableHint: "The current gateway does not support reading checkpoint history directly. Use the button in the top-right to query recent versions through the chat flow.",
    restoreToThisVersion: "Restore to this version",

    // Time formatting
    justNow: "just now",
    minutesAgo: "minutes ago",
    hoursAgo: "hours ago",
    yesterday: "yesterday",
    daysAgo: "days ago",

    // Chat section
    chatPlaceholder: "Type a message...",
    send: "Send",
    filterAll: "All",
    filterReply: "Reply",
    filterStatus: "Status",
    filterBuild: "Build",
    filterCommand: "Command",

    // Sessions section
    loadSessions: "Load Sessions",
    sessionKey: "Session Key",
    lastActivity: "Last Activity",
    messageCount: "Message Count",
    switchTo: "Switch to",
    noSessions: "No sessions",

    // Preferences
    preferences: "Preferences",
    visualStyle: "Visual Style",
    layout: "Layout",
    modules: "Modules",
    dislikes: "Dislikes",
    currentGoal: "Current Goal",
    savePreferences: "Save Preferences",

    // Connection
    connecting: "Connecting...",
    connected: "Connected",
    disconnected: "Disconnected",
    connectionError: "Connection Error",

    // Errors
    loadCheckpointError: "Failed to load checkpoint history",

    // Language
    language: "Language",
    chinese: "中文",
    english: "English",

    // App Shell
    modeUse: "USE",
    modeControl: "CONTROL",
    usageLabel: "usage",

    // Error messages
    loadStatusError: "Failed to load status",
    loadChatHistoryError: "Failed to load chat history",
    connectionClosed: "Connection closed",
    eventSequenceGap: "Event sequence gap: expected {expected}, received {received}",
    sendError: "Send failed",
    checkpointRefRequired: "Please enter a checkpoint ref to restore",
  },
} as const;

export type TranslationKey = keyof typeof translations.zh;

export function getTranslation(lang: Language, key: TranslationKey, params?: Record<string, string | number>): string {
  let text = translations[lang][key];
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      text = text.replace(`{${k}}`, String(v));
    });
  }
  return text;
}

export function detectBrowserLanguage(): Language {
  const browserLang = navigator.language.toLowerCase();
  if (browserLang.startsWith("zh")) {
    return "zh";
  }
  return "en";
}
