declare module "imap" {
  import { EventEmitter } from "events";

  interface ImapConfig {
    user: string;
    password: string;
    host: string;
    port: number;
    tls?: boolean;
    tlsOptions?: any;
    connTimeout?: number;
    authTimeout?: number;
    keepalive?: any;
  }

  interface Message {
    headers?: any;
    body?: string;
  }

  interface ImapMessage {
    on(event: "body", listener: (stream: NodeJS.ReadableStream, info: any) => void): this;
    on(event: "attributes", listener: (attrs: any) => void): this;
    on(event: "end", listener: () => void): this;
  }

  interface ImapFetch {
    on(event: "message", listener: (msg: ImapMessage, seqno: number) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "end", listener: () => void): this;
  }

  export default class Imap extends EventEmitter {
    constructor(config: ImapConfig);
    connect(): void;
    end(): void;
    openBox(boxName: string, callback?: (err: Error, box: any) => void): void;
    search(criteria: any[], callback?: (err: Error, results: number[]) => void): void;
    fetch(range: any, options?: any): ImapFetch;
    addFlags(range: any, flags: string[], callback?: (err: Error) => void): void;
    on(event: "ready", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "mail", listener: (numNewMail: number) => void): this;
  }
}
