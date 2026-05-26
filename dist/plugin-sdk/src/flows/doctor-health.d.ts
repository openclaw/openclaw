import type { DoctorOptions } from "../commands/doctor-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
export declare function doctorCommand(runtime?: RuntimeEnv, options?: DoctorOptions): Promise<void>;
