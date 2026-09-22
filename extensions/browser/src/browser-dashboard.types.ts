export type BrowserDashboardRequest = {
  sessionKey: string;
  agentId?: string;
  name: string;
  instanceId?: string;
};

export type BrowserDashboardIdentity = {
  sessionKey: string;
  agentId: string;
  name: string;
  instanceId: string;
  url: string;
  profile: string;
};

export type BrowserDashboardDefinition = BrowserDashboardIdentity & {
  revision: number;
  title?: string;
};

export type BrowserDashboardResponse = {
  sessionKey: string;
  name: string;
  instanceId: string;
  revision: number;
  paused: boolean;
  stopping: boolean;
  url: string;
  title?: string;
  browserTab?: { target: "host"; profile: string; targetId: string };
};
