import type { ConnectorConfigInput } from "../interfaces/connectors/presets.js";
import type { RobotInfo } from "../kernel/types.js";
import type { CwPackConfig } from "../pack-loader/index.js";
import type { A2aPeerConfig } from "./a2a-peers.js";
import type { ClaworksNotifyConfig } from "./notify-types.js";

export type ClaworksRobotConfig = {
  api?: {
    api_key?: string;
  };
  a2a?: {
    enabled?: boolean;
    endpoint?: string;
    peers?: A2aPeerConfig[];
  };
  kernel?: {
    event_queue_size?: number;
    playbook_concurrency?: number;
    hitl_timeout_seconds?: number;
    scheduler_timezone?: string;
  };
  robot?: {
    name?: string;
    role?: RobotInfo["role"];
    port?: number;
    host?: string;
    session_key?: string;
  };
  data?: {
    database_url?: string;
    kb_path?: string;
    kb_provider?: "stub" | "memory-core";
    memory_agent_id?: string;
  };
  packs?: CwPackConfig;
  notify?: ClaworksNotifyConfig;
  im_bridge?: {
    auto_on_message_received?: boolean;
  };
  model_router?: {
    default?: string;
    fast?: string;
    embed?: string;
  };
  connectors?: Record<string, ConnectorConfigInput>;
};
