import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";

type IMessageReactionSystemEventDecision = {
  text: string;
  contextKey: string;
  route: Parameters<typeof enqueueRoutedSystemEvent>[1];
  reaction: {
    targetGuid?: string;
    action: "added" | "removed";
    emoji: string;
  };
};

export function enqueueIMessageReactionSystemEvent(params: {
  decision: IMessageReactionSystemEventDecision;
  runtime: RuntimeEnv;
  logVerbose?: (message: string) => void;
}): boolean {
  const { decision, runtime } = params;
  const queued = enqueueRoutedSystemEvent(decision.text, decision.route, {
    contextKey: decision.contextKey,
  });
  runtime.log?.(
    `imessage: reaction system event ${queued ? "queued" : "deduped"} session=${
      decision.route.sessionKey
    } target=${decision.reaction.targetGuid ?? "unknown"} action=${decision.reaction.action} emoji=${
      decision.reaction.emoji
    }`,
  );
  params.logVerbose?.(`imessage: reaction event enqueued: ${decision.text}`);
  return queued;
}
