// Stored message row from SQLite
export type StoredMessage = {
  id: number;
  conversation_id: string;
  sender: string;
  sender_name: string | null;
  content: string;
  timestamp: number; // ms epoch
  direction: "inbound" | "outbound";
  channel_id: string;
};

// Minimal logger type — compatible with PluginLogger from openclaw/plugin-sdk
export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

// Plugin configuration with defaults
export type PluginConfig = {
  ollamaUrl: string;
  debounceMs: number;
  dbPath: string;
  outputDir: string;
};

// Classification result from a single model
export type MeetingClassification = {
  has_agreed_to_meet: boolean;
  has_agreed_date: boolean;
  reason: string;
};

// Consensus escalation action
export type EscalationAction = "add_calendar_event" | "confirm_with_customer" | "none";
