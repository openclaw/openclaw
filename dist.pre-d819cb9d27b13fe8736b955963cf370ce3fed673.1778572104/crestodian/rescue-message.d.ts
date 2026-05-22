import { i as OpenClawConfig } from "../types.openclaw-BlE9q7jU.js";
import { t as CommandContext } from "../commands-types-V6iBf9gf.js";
import { t as CrestodianCommandDeps } from "../operations-B5g6clqW.js";

//#region src/crestodian/rescue-message.d.ts
type CrestodianRescueMessageInput = {
  cfg: OpenClawConfig;
  command: CommandContext;
  commandBody: string;
  agentId?: string;
  isGroup: boolean;
  env?: NodeJS.ProcessEnv;
  deps?: CrestodianCommandDeps;
};
declare function extractCrestodianRescueMessage(commandBody: string): string | null;
declare function runCrestodianRescueMessage(input: CrestodianRescueMessageInput): Promise<string | null>;
//#endregion
export { CrestodianRescueMessageInput, extractCrestodianRescueMessage, runCrestodianRescueMessage };