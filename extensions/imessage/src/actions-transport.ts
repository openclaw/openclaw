import { runIMessageCliJsonCommand } from "./cli-output.js";
import { createIMessageRpcClient } from "./client.js";

export type IMessageActionTransportOptions = {
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
  timeoutMs?: number;
};

class IMessageRemoteUnsupportedError extends Error {
  readonly code = "IMESSAGE_REMOTE_UNSUPPORTED";

  constructor(message: string) {
    super(message);
    this.name = "IMessageRemoteUnsupportedError";
  }
}

export function throwIMessageRemoteUnsupported(message: string): never {
  throw new IMessageRemoteUnsupportedError(`iMessage Remote Mac limitation: ${message}`);
}

export async function runIMessageAction(
  options: IMessageActionTransportOptions,
  method: string,
  params: Record<string, unknown>,
  args: readonly string[],
): Promise<Record<string, unknown>> {
  if (!options.remoteHost) {
    return await runIMessageCliJsonCommand({
      args,
      cliPath: options.cliPath,
      dbPath: options.dbPath,
      timeoutMs: options.timeoutMs,
    });
  }
  const client = await createIMessageRpcClient({
    cliPath: options.cliPath,
    dbPath: options.dbPath,
    remoteHost: options.remoteHost,
  });
  try {
    return await client.request<Record<string, unknown>>(method, params, {
      timeoutMs: options.timeoutMs,
    });
  } finally {
    await client.stop();
  }
}
