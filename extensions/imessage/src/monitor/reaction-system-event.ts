import { logVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";

export function enqueueIMessageReactionSystemEvent(params: {
  decision: {
    text: string;
    contextKey: string;
    route: Parameters<typeof enqueueRoutedSystemEvent>[1];
    reaction: {
      targetGuid?: string;
      action: "added" | "removed";
      emoji: string;
    };
  };
  runtime: RuntimeEnv;
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
  logVerbose("imessage: reaction event enqueued");
  return queued;
}
