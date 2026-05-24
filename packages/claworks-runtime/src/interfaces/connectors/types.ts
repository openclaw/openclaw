/** NDJSON stdio protocol between ClaWorks and connector child processes. */

export type ConnectorOutboundMessage =
  | { type: "invoke"; id: string; method: string; params?: Record<string, unknown> }
  | { type: "shutdown" };

export type ConnectorInboundMessage =
  | { type: "ready"; connectorId?: string }
  | { type: "log"; level?: string; message: string }
  | {
      type: "event";
      event_type: string;
      source: string;
      payload: Record<string, unknown>;
      correlation_id?: string;
    }
  | { type: "result"; id: string; ok: boolean; result?: unknown; error?: string };

export type ConnectorAutoStart =
  | boolean
  | {
      method?: string;
      params?: Record<string, unknown>;
    };

export type ConnectorConfig = {
  enabled?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  auto_start?: ConnectorAutoStart;
  /**
   * 进程崩溃后是否自动重启。
   *   false / 不设置  — 不重启（默认）
   *   true            — 等同于 { maxRestarts: 5 }
   *   { maxRestarts } — 最多重启 maxRestarts 次，指数退避（初始 1 s，上限 60 s）
   */
  restart_on_exit?: boolean | { maxRestarts?: number };
};

export type ConnectorStatus = {
  id: string;
  running: boolean;
  pid?: number;
  ready: boolean;
  lastError?: string;
};
