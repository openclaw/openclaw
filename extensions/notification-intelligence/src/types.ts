export type CapturedNotification = {
  id: string;
  /** System key from StatusBarNotification.getKey(), used for cancelNotification(). */
  key: string;
  packageName: string;
  appLabel: string;
  title: string | null;
  text: string | null;
  timestamp: number;
  priority: number;
  category: string | null;
  groupKey: string | null;
  isOngoing: boolean;
  isGroupSummary: boolean;
};

export type NotificationBatch = {
  batchId: string;
  nodeId: string;
  notifications: CapturedNotification[];
  batchedAtMs: number;
  windowMs: number;
};

export type TriageLevel = "critical" | "important" | "informational" | "noise";

export type TriagedNotification = CapturedNotification & {
  triageLevel: TriageLevel;
};

export type NotificationDigest = {
  generatedAtMs: number;
  totalCount: number;
  critical: TriagedNotification[];
  important: TriagedNotification[];
  informational: TriagedNotification[];
  noise: TriagedNotification[];
};
