export type CodexAppServerTransport = {
  stdin: { write: (data: string) => unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  killed?: boolean;
  kill?: () => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
};
