export type LogsTailParams = {
  cursor?: number;
  limit?: number;
  maxBytes?: number;
};

export type LogsTailResponse = {
  file?: string;
  cursor?: number;
  size?: number;
  lines?: string[];
  truncated?: boolean;
  reset?: boolean;
};

export type ExtractResult = {
  source: "logs.tail" | "file.tail";
  file: string;
  lines: string[];
  truncated: boolean;
  reset: boolean;
  cursor: number;
  size: number;
};

export type ParsedCommandArgs = Required<Pick<LogsTailParams, "limit">> & {
  uploadCos: boolean;
  logId?: string;
  cosTokenEndpoint?: string;
  uin?: string;
  recentDays?: number;
  recentHours?: number;
  startTime?: number;
  endTime?: number;
  description?: string;
  all?: boolean;
  appKey?: string;
  appSecret?: string;
  apiDomain?: string;
  routeEnv?: string;
};

export type CosUploadResult = {
  enabled: boolean;
  cosPath?: string;
  cosUrl?: string;
  logId?: string;
  recordLogOk?: boolean;
};
