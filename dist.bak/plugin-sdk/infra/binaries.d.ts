import { runExec } from "../process/exec.js";
import { type RuntimeEnv } from "../runtime.js";
export declare function ensureBinary(name: string, exec?: typeof runExec, runtime?: RuntimeEnv): Promise<void>;
