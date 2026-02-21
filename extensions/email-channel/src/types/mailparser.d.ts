declare module "mailparser" {
  import { EventEmitter } from "events";

  interface ParsedMail {
    headers: Map<string, string>;
    subject?: string;
    from?: { value: Array<{ address: string; name: string }> };
    to?: { value: Array<{ address: string; name: string }> };
    text?: string;
    textAsHtml?: string;
    html?: string;
    attachments?: Array<{
      filename?: string;
      contentType: string;
      content: Buffer;
    }>;
    messageId?: string;
    date?: Date;
  }

  export class MailParser extends EventEmitter {
    on(event: "data", listener: (data: ParsedMail) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    write(chunk: Buffer | string): boolean;
    end(): void;
  }

  export function simpleParser(
    source: Buffer | string | NodeJS.ReadableStream,
    callback: (err: Error | null, parsed: ParsedMail) => void,
  ): void;
  export function simpleParser(
    source: Buffer | string | NodeJS.ReadableStream,
  ): Promise<ParsedMail>;
}
