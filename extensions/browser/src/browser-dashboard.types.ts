import type { PlaywrightOwnedPage } from "./browser/pw-session-page.types.js";
import type { GatewayRequestHandlers } from "./sdk-node-runtime.js";

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

export type SessionBrowserAuthority = NonNullable<
  Parameters<GatewayRequestHandlers[string]>[0]["sessionAccessAuthority"]
>;
/** One isolated context belongs to one exact session incarnation and board instance. */
export type SessionBrowserDashboard = {
  definition: BrowserDashboardDefinition;
  session: SessionBrowserAuthority["target"];
  paused: boolean;
  page?: PlaywrightOwnedPage;
  signal: AbortSignal;
  assertCurrent: () => void;
  assertDefinitionCurrent: () => Promise<void>;
  definitionChanged: () => void;
  close: () => Promise<void>;
};
