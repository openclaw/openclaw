type ThreadIdParams = {
  threadId: string;
};

type BackgroundTerminal = {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
};

export type RequestMap = {
  "thread/backgroundTerminals/list": ThreadIdParams & {
    cursor?: string | null;
    limit?: number | null;
  };
  "thread/backgroundTerminals/terminate": ThreadIdParams & { processId: string };
};

export type ResultMap = {
  "thread/backgroundTerminals/list": {
    data: BackgroundTerminal[];
    nextCursor: string | null;
  };
  "thread/backgroundTerminals/terminate": {
    terminated: boolean;
  };
};
