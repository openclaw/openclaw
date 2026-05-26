import { n as RuntimeEnv } from "../runtime-Bxifh4bY.js";
import { n as CrestodianOverview, r as loadCrestodianOverview, t as CrestodianCommandDeps } from "../operations-B-_DyYPv.js";
import { ImageContent } from "@earendil-works/pi-ai";

//#region src/crestodian/assistant-prompts.d.ts
type CrestodianAssistantPlan = {
  command: string;
  reply?: string;
  modelLabel?: string;
};
//#endregion
//#region src/crestodian/assistant.d.ts
type CrestodianAssistantPlanner = (params: {
  input: string;
  overview: CrestodianOverview;
}) => Promise<CrestodianAssistantPlan | null>;
//#endregion
//#region src/crestodian/crestodian.d.ts
type CrestodianInteractiveRunner = (opts: RunCrestodianOptions, runtime: RuntimeEnv) => Promise<void>;
type RunCrestodianOptions = {
  message?: string;
  yes?: boolean;
  json?: boolean;
  interactive?: boolean;
  onReady?: () => void;
  deps?: CrestodianCommandDeps;
  formatOverview?: (overview: CrestodianOverview) => string;
  loadOverview?: typeof loadCrestodianOverview;
  planWithAssistant?: CrestodianAssistantPlanner;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  runInteractiveTui?: CrestodianInteractiveRunner;
};
declare function runCrestodian(opts?: RunCrestodianOptions, runtime?: RuntimeEnv): Promise<void>;
//#endregion
export { RunCrestodianOptions, runCrestodian };