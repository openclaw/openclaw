// Whatsapp plugin module implements dependency-light auth state inspection.
import { getChildLogger } from "openclaw/plugin-sdk/logging-core";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { readWebCredsJsonRaw, resolveWebCredsPath } from "./creds-files.js";
import {
  waitForCredsSaveQueueWithTimeout,
  type CredsQueueWaitResult,
} from "./creds-persistence.js";

const authStateLogger = getChildLogger({ module: "web-auth-store" });

export type WhatsAppWebAuthState = "linked" | "not-linked" | "unstable";

export async function waitForWebAuthBarrier(
  authDir: string,
  context: string,
): Promise<CredsQueueWaitResult> {
  const result = await waitForCredsSaveQueueWithTimeout(authDir);
  if (result === "timed_out") {
    authStateLogger.warn(
      {
        authDir,
        context,
      },
      "timed out waiting for queued WhatsApp creds save before auth read",
    );
  }
  return result;
}

export async function webAuthExistsAt(authDir: string): Promise<boolean> {
  const resolvedAuthDir = resolveUserPath(authDir);
  const raw = await readWebCredsJsonRaw(resolveWebCredsPath(resolvedAuthDir));
  if (!raw) {
    return false;
  }
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

function resolveWebAuthState(params: {
  linked: boolean;
  barrierResult: CredsQueueWaitResult;
}): WhatsAppWebAuthState {
  if (params.barrierResult === "timed_out") {
    return "unstable";
  }
  return params.linked ? "linked" : "not-linked";
}

export async function readWebAuthStateDetails(
  authDir: string,
  context: string,
): Promise<{ authDir: string; linked: boolean; state: WhatsAppWebAuthState }> {
  const resolvedAuthDir = resolveUserPath(authDir);
  const barrierResult = await waitForWebAuthBarrier(resolvedAuthDir, context);
  const linked = await webAuthExistsAt(resolvedAuthDir);
  return {
    authDir: resolvedAuthDir,
    linked,
    state: resolveWebAuthState({ linked, barrierResult }),
  };
}

export function formatWhatsAppWebAuthStatusState(state: WhatsAppWebAuthState): string {
  switch (state) {
    case "linked":
      return "linked";
    case "not-linked":
      return "not linked";
    case "unstable":
      return "auth stabilizing";
  }
  const exhaustive: never = state;
  return exhaustive;
}

export async function readWebAuthState(authDir: string): Promise<WhatsAppWebAuthState> {
  return (await readWebAuthStateDetails(authDir, "readWebAuthState")).state;
}
