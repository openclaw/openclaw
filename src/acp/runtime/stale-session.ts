import fs from "node:fs";

export const ACP_STALE_BINDING_UNBIND_REASON = "acp-session-init-failed";

const STALE_ACP_SESSION_MESSAGE_RE =
  /(ACP (session )?metadata is missing|missing ACP metadata|Session is not ACP-enabled|Resource not found|working directory does not exist)/i;

export function isAcpStaleSessionError(params: { code: string; message: string }): boolean {
  return (
    params.code === "ACP_SESSION_INIT_FAILED" && STALE_ACP_SESSION_MESSAGE_RE.test(params.message)
  );
}

export function isMissingAcpSessionCwd(cwd: string | undefined): boolean {
  if (!cwd?.trim()) {
    return false;
  }
  try {
    return !fs.statSync(cwd).isDirectory();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function unbindStaleAcpSessionBindings(params: {
  targetSessionKey: string;
  unbind: (input: {
    targetSessionKey: string;
    reason: typeof ACP_STALE_BINDING_UNBIND_REASON;
  }) => Promise<unknown[]>;
}): Promise<{ ok: true; removedCount: number } | { ok: false; error: unknown }> {
  try {
    const removed = await params.unbind({
      targetSessionKey: params.targetSessionKey,
      reason: ACP_STALE_BINDING_UNBIND_REASON,
    });
    return { ok: true, removedCount: removed.length };
  } catch (error) {
    return { ok: false, error };
  }
}
