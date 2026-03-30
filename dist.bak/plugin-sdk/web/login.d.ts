import { type RuntimeEnv } from "../runtime.js";
import { waitForWaConnection } from "./session.js";
export declare function loginWeb(verbose: boolean, waitForConnection?: typeof waitForWaConnection, runtime?: RuntimeEnv, accountId?: string): Promise<void>;
