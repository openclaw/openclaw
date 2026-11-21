import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

export function createPersistenceFailureReporter(cache: "reply-cache" | "echo-cache") {
  let reported = false;
  return (scope: string, err: unknown): void => {
    if (reported) {
      return;
    }
    reported = true;
    logVerbose(`imessage ${cache}: ${scope} disabled after first failure: ${String(err)}`);
  };
}
