import { type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { waitForWaConnection } from "./session.js";
export declare function loginWeb(verbose: boolean, waitForConnection?: typeof waitForWaConnection, runtime?: RuntimeEnv, accountId?: string): Promise<void>;
