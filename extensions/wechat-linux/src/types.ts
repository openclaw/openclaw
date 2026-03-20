import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export type DmPolicy = "disabled" | "allowlist" | "open" | "pairing";
export type GroupPolicy = "disabled" | "allowlist" | "open";
export type WechatLinuxWindowMode = "auto" | "standalone" | "main";

export type WechatLinuxAccountConfig = {
  name?: string;
  enabled?: boolean;
  pyWxDumpRoot?: string;
  pythonPath?: string;
  keyFile?: string;
  dbDir?: string;
  outputDir?: string;
  display?: string;
  xauthority?: string;
  windowClass?: string;
  windowMode?: WechatLinuxWindowMode;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: string[];
  mentionPatterns?: string[];
  textChunkLimit?: number;
  blockStreaming?: boolean;
  mediaMaxMb?: number;
  imageAnalysis?: boolean;
  videoAnalysis?: boolean;
  voiceAsr?: boolean;
  linkDocs?: boolean;
  visionBaseUrl?: string;
  visionModel?: string;
  visionApiKeyEnv?: string;
  summaryBaseUrl?: string;
  summaryModel?: string;
  summaryApiKeyEnv?: string;
  asrUrl?: string;
  linkHookCmd?: string;
  linkDocRoot?: string;
  linkDomains?: string[];
  linkHookTimeoutSec?: number;
};

export type WechatLinuxConfig = WechatLinuxAccountConfig & {
  accounts?: Record<string, WechatLinuxAccountConfig>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    "wechat-linux"?: WechatLinuxConfig;
  };
};

export type ResolvedWechatLinuxAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  pyWxDumpRoot: string;
  pythonPath: string;
  keyFile: string;
  dbDir?: string;
  outputDir: string;
  display?: string;
  xauthority?: string;
  windowClass: string;
  windowMode: WechatLinuxWindowMode;
  config: WechatLinuxAccountConfig;
};

export type BridgeMediaArtifact = {
  path: string;
  contentType?: string;
};

export type BridgeMessage = {
  local_id: number;
  server_id?: string;
  timestamp: number;
  time?: string;
  base_type?: number;
  sub_type?: number;
  chat_id: string;
  chat_name: string;
  chat_type: "direct" | "group";
  sender_id: string;
  sender_username?: string;
  sender_display: string;
  content: string;
  analysis_text?: string;
  normalized_kind: string;
  type_label?: string;
  details: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  document?: Record<string, unknown>;
  raw_xml?: string;
  url_list?: string[];
  media_paths?: string[];
  media_types?: string[];
  is_self?: boolean;
};

export type BridgeReadyEvent = {
  type: "ready";
  chat_count?: number;
};

export type BridgeMessageEvent = {
  type: "message";
  message: BridgeMessage;
};

export type BridgeEnvelope = BridgeReadyEvent | BridgeMessageEvent;

export type BridgeResolveTargetResult = {
  ok: boolean;
  input: string;
  chat_id?: string;
  chat_name?: string;
  chat_type?: "direct" | "group";
  note?: string;
};

export type BridgeProbe = {
  ok: boolean;
  python_path: string;
  pywxdump_root: string;
  pywxdump_exists: boolean;
  bridge_path: string;
  key_file: string;
  key_file_exists: boolean;
  db_dir?: string;
  db_dir_exists: boolean;
  output_dir: string;
  output_dir_exists: boolean;
  display?: string;
  xauthority?: string;
  xdotool_exists: boolean;
  wechat_process_count: number;
  window_class: string;
  window_mode: WechatLinuxWindowMode;
  image_analysis?: boolean;
  video_analysis?: boolean;
  voice_asr?: boolean;
  silk_python_available?: boolean | null;
  link_docs?: boolean;
  error?: string;
};

export type BridgeSendResult = {
  status: "ok" | "error";
  target: string;
  chat_id?: string;
  matched_local_id?: number | null;
  send_kind: "text" | "image" | "file";
  path?: string;
  text?: string;
  error?: string;
};

export type BridgeSearchKind = "message" | "file" | "image";

export type BridgeSearchResult = {
  ok: boolean;
  search_kind: BridgeSearchKind;
  query?: string;
  chat_id?: string;
  chat_name?: string;
  scanned: number;
  total: number;
  matches: BridgeMessage[];
  note?: string;
};
