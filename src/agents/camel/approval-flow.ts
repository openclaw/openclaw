import readline from "node:readline";
import type { ApprovalHandler, ApprovalRequest } from "./types.js";

export function createApprovalPromptHandler(params?: {
  timeoutMs?: number;
  prompt?: (request: ApprovalRequest) => Promise<boolean>;
}): ApprovalHandler {
  const timeoutMs = params?.timeoutMs ?? 30_000;
  if (params?.prompt) {
    return params.prompt;
  }

  return async (request) => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      console.warn(
        `[camel approval] denying ${request.toolName}: non-interactive TTY (stdin/stderr missing).`,
      );
      return false;
    }

    return new Promise((resolve) => {
      let settled = false;
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      const finish = (approved: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        rl.close();
        resolve(approved);
      };

      const timeout = setTimeout(() => finish(false), timeoutMs);
      rl.question(
        `\n[camel approval] Allow ${request.toolName}? ${request.reason} (y/N) `,
        (answer) => {
          finish(answer.trim().toLowerCase() === "y");
        },
      );
    });
  };
}

export async function requestApproval(
  request: ApprovalRequest,
  handler: ApprovalHandler,
): Promise<boolean> {
  return handler(request);
}
