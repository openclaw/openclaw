import { AsyncResource } from "node:async_hooks";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import { captureSessionEntryCurrentCheck } from "openclaw/plugin-sdk/session-binding-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";

export async function resolveFeishuReasoningPreviewEnabled(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  storePath: string;
  sessionKey?: string;
}): Promise<{ enabled: boolean; isCurrent: () => boolean; prepareCurrent?: () => Promise<void> }> {
  const configDefault =
    resolveAgentConfig(params.cfg, params.agentId)?.reasoningDefault ??
    params.cfg.agents?.defaults?.reasoningDefault ??
    "off";

  const { agentId, storePath, sessionKey } = params;
  if (!sessionKey) {
    return { enabled: configDefault === "stream", isCurrent: () => true };
  }

  // Retain the original binding across later presentation callbacks, including actor retirement.
  const readCurrent = AsyncResource.bind(() =>
    captureSessionEntryCurrentCheck({
      agentId,
      storePath,
      sessionKey,
      fields: ["reasoningLevel"],
    }),
  );
  const prepared = await readCurrent();
  const enabled = (level: string | undefined) =>
    level === "on" || level === "stream" || level === "off"
      ? level === "stream"
      : configDefault === "stream";
  let current = prepared.entry ? prepared : undefined;
  let preparation: Promise<void> | undefined;
  return {
    enabled: enabled(prepared.entry?.reasoningLevel),
    isCurrent: () =>
      Boolean(current && enabled(current.entry?.reasoningLevel) && current.isCurrent()),
    ...(!current
      ? {
          prepareCurrent: () =>
            (preparation ??= readCurrent().then((created) => {
              if (!created.entry) {
                throw new Error("Feishu reasoning preview requires its created session");
              }
              current = created;
            })),
        }
      : {}),
  };
}
