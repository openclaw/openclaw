declare module "@copilotkit/aimock" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export class LLMock {
    constructor(options: {
      host: string;
      port: number;
      strict?: boolean;
      logLevel?: string;
    });
    getRequests(): JournalEntry[];
    mount(path: string, mountable: Mountable): void;
    onMessage(pattern: RegExp | string, response: unknown): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    baseUrl: string;
  }

  export interface JournalEntry {
    body?: unknown;
    path: string;
    response: {
      fixture?: {
        response: unknown;
      };
    };
  }

  export interface ChatCompletionRequest {
    messages?: unknown[];
    model?: string;
  }

  export interface Mountable {
    handleRequest(
      req: IncomingMessage,
      res: ServerResponse,
      pathname: string,
    ): Promise<boolean>;
  }
}
