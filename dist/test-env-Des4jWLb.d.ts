import { IncomingMessage, RequestListener } from "node:http";

//#region src/plugin-sdk/test-helpers/http-test-server.d.ts
declare function withServer(handler: RequestListener, fn: (baseUrl: string) => Promise<void>): Promise<void>;
//#endregion
//#region src/plugin-sdk/test-helpers/mock-incoming-request.d.ts
declare function createMockIncomingRequest(chunks: string[]): IncomingMessage;
//#endregion
//#region src/plugin-sdk/test-helpers/temp-home.d.ts
type EnvValue = string | undefined | ((home: string) => string | undefined);
declare function withTempHome<T>(fn: (home: string) => Promise<T>, opts?: {
  env?: Record<string, EnvValue>;
  prefix?: string;
  skipHomeCleanup?: boolean;
  skipSessionCleanup?: boolean;
}): Promise<T>;
//#endregion
export { createMockIncomingRequest as n, withServer as r, withTempHome as t };