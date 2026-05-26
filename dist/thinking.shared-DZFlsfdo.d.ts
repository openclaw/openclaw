//#region src/auto-reply/thinking.shared.d.ts
type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
type VerboseLevel = "off" | "on" | "full";
type TraceLevel = "off" | "on" | "raw";
type ElevatedLevel = "off" | "on" | "ask" | "full";
type ReasoningLevel = "off" | "on" | "stream";
type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
  compat?: {
    supportedReasoningEfforts?: readonly string[] | null;
  } | null;
};
//#endregion
export { TraceLevel as a, ThinkingCatalogEntry as i, ReasoningLevel as n, VerboseLevel as o, ThinkLevel as r, ElevatedLevel as t };