import { t as BaseProbeResult } from "./types.core-1gFCH89g.js";
//#region extensions/slack/src/probe.d.ts
type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: {
    id?: string;
    name?: string;
  };
  team?: {
    id?: string;
    name?: string;
  };
};
declare function probeSlack(token: string, timeoutMs?: number): Promise<SlackProbe>;
//#endregion
export { probeSlack as n, SlackProbe as t };