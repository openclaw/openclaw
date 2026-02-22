export type TuituiAccountConfig = {
  name?: string;
  enabled?: boolean;
  /** 推推机器人 appid（开发者账号） */
  appId?: string;
  /** 推推机器人 secret（开发者密钥） */
  secret?: string;
  /** 存 secret 的文件路径，与 secret 二选一 */
  secretFile?: string;
  /** 收消息回调 path，默认 /tuitui-webhook */
  webhookPath?: string;
  /** 网关公网 base URL；配置后启动时自动调用推推「改收消息回调url」，无需在推推后台手动配置。例：https://gateway.example.com */
  webhookBaseUrl?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  responsePrefix?: string;
};

export type TuituiConfig = {
  accounts?: Record<string, TuituiAccountConfig>;
  defaultAccount?: string;
} & TuituiAccountConfig;

export type TuituiCredentialsSource = "env" | "config" | "configFile" | "none";

export type ResolvedTuituiAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  secret: string;
  credentialsSource: TuituiCredentialsSource;
  config: TuituiAccountConfig;
};
