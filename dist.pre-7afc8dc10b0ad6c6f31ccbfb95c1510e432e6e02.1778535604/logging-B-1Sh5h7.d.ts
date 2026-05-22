//#region src/channels/logging.d.ts
type LogFn = (message: string) => void;
declare function logInboundDrop(params: {
  log: LogFn;
  channel: string;
  reason: string;
  target?: string;
}): void;
declare function logTypingFailure(params: {
  log: LogFn;
  channel: string;
  target?: string;
  action?: "start" | "stop";
  error: unknown;
}): void;
declare function logAckFailure(params: {
  log: LogFn;
  channel: string;
  target?: string;
  error: unknown;
}): void;
//#endregion
export { logTypingFailure as i, logAckFailure as n, logInboundDrop as r, LogFn as t };