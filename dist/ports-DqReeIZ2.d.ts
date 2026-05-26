import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";

//#region src/infra/ports.d.ts
declare class PortInUseError extends Error {
  port: number;
  details?: string;
  constructor(port: number, details?: string);
}
declare function describePortOwner(port: number): Promise<string | undefined>;
declare function ensurePortAvailable(port: number): Promise<void>;
declare function handlePortError(err: unknown, port: number, context: string, runtime?: RuntimeEnv): Promise<never>;
//#endregion
export { handlePortError as i, describePortOwner as n, ensurePortAvailable as r, PortInUseError as t };