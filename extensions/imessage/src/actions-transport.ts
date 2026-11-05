import {
  captureChannelReadAuthority,
  captureEffectAuthority,
} from "openclaw/plugin-sdk/fetch-runtime";
import { runIMessageCliJsonCommand } from "./cli-output.js";
import { createIMessageRpcClient } from "./client.js";

export type IMessageActionTransportOptions = {
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
  timeoutMs?: number;
};

export function throwIMessageRemoteUnsupported(message: string): never {
  throw Object.assign(new Error(`iMessage Remote Mac limitation: ${message}`), {
    code: "IMESSAGE_REMOTE_UNSUPPORTED",
    name: "IMessageRemoteUnsupportedError",
  });
}

export async function runIMessageAction(
  options: IMessageActionTransportOptions,
  method: string,
  params: Record<string, unknown>,
  args: readonly string[],
): Promise<Record<string, unknown>> {
  if (!options.remoteHost) {
    const assertReadAuthority = captureChannelReadAuthority();
    return await captureEffectAuthority().initiate(() => {
      assertReadAuthority?.();
      return runIMessageCliJsonCommand({
        args,
        cliPath: options.cliPath,
        dbPath: options.dbPath,
        timeoutMs: options.timeoutMs,
      });
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
