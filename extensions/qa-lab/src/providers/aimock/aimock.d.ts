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
    onMessage(pattern: RegExp | string, response: any): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    baseUrl: string;
  }

  export interface JournalEntry {
    body?: any;
    path: string;
    response: {
      fixture?: {
        response: any;
      };
    };
  }

  export interface ChatCompletionRequest {
    messages?: any[];
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
