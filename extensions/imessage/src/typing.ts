import { spawn } from "node:child_process";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

export type IMessageTypingTarget =
  | { kind: "to"; to: string }
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "chat_guid"; chatGuid: string };

export type SendIMessageTypingOpts = {
  cliPath?: string;
  dbPath?: string;
  runtime?: RuntimeEnv;
  active: boolean;
  /** Timeout in ms for the typing subprocess. Defaults to 5000. */
  timeoutMs?: number;
};

/**
 * Send a typing start or stop indicator via `imsg typing`.
 * Requires imsg >= 0.5.0. Errors are soft — logged but not thrown.
 */
export async function sendIMessageTyping(
  target: IMessageTypingTarget,
  opts: SendIMessageTypingOpts,
): Promise<void> {
  const cliPath = opts.cliPath?.trim() || "imsg";
  const args: string[] = ["typing"];

  if (opts.dbPath?.trim()) {
    args.push("--db", opts.dbPath.trim());
  }

  switch (target.kind) {
    case "to":
      args.push("--to", target.to);
      break;
    case "chat_id":
      args.push("--chat-id", String(target.chatId));
      break;
    case "chat_identifier":
      args.push("--chat-identifier", target.chatIdentifier);
      break;
    case "chat_guid":
      args.push("--chat-guid", target.chatGuid);
      break;
  }

  if (!opts.active) {
    args.push("--stop", "true");
  }

  const timeoutMs = opts.timeoutMs ?? 5000;

  return new Promise((resolve) => {
    let done = false;
    const settle = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cliPath, args, { stdio: "pipe" });
    } catch (err) {
      opts.runtime?.error?.(`[imessage] typing spawn failed: ${String(err)}`);
      return settle();
    }

    const timer = setTimeout(() => {
      if (!done) {
        child.kill();
        opts.runtime?.error?.(`[imessage] typing command timed out`);
        settle();
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        logVerbose(`[imessage] typing command exited with code ${code}`);
      }
      settle();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      opts.runtime?.error?.(`[imessage] typing command error: ${String(err)}`);
      settle();
    });
  });
}

/**
 * Resolve a typing target from available identifiers (prefer chat_id > chat_identifier > chat_guid > to).
 */
export function resolveIMessageTypingTarget(params: {
  chatId?: number | null;
  chatIdentifier?: string | null;
  chatGuid?: string | null;
  to?: string | null;
}): IMessageTypingTarget | null {
  if (typeof params.chatId === "number") {
    return { kind: "chat_id", chatId: params.chatId };
  }
  if (params.chatIdentifier?.trim()) {
    return { kind: "chat_identifier", chatIdentifier: params.chatIdentifier.trim() };
  }
  if (params.chatGuid?.trim()) {
    return { kind: "chat_guid", chatGuid: params.chatGuid.trim() };
  }
  if (params.to?.trim()) {
    return { kind: "to", to: params.to.trim() };
  }
  return null;
}
