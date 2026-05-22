import { t as BaseProbeResult } from "./types.core-gexONR-2.js";
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