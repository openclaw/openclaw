import { observeSqliteWorkerAdmission } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WarmProfileRecord } from "./crabbox-worker-warm-image-store.js";

export function observeWarmComparisonAdmission(options: {
  key: string;
  matches?: (record: WarmProfileRecord) => boolean;
  beforeAdmit?: Parameters<typeof observeSqliteWorkerAdmission>[0]["beforeAdmit"];
  afterAdmit?: Parameters<typeof observeSqliteWorkerAdmission>[0]["afterAdmit"];
}) {
  return observeSqliteWorkerAdmission({
    selectSubmission: (command) => {
      if (!isRecord(command) || command.type !== "pluginState.compareUpdate") {
        return undefined;
      }
      const input = command.input;
      if (
        !isRecord(input) ||
        input.pluginId !== "crabbox" ||
        input.namespace !== "warm-images" ||
        input.key !== options.key ||
        input.action !== "set"
      ) {
        return undefined;
      }
      if (options.matches) {
        if (typeof input.valueJson !== "string") {
          return undefined;
        }
        // These are this fixture's canonical namespace bytes, not an untrusted API input.
        const candidate = JSON.parse(input.valueJson) as WarmProfileRecord;
        if (!options.matches(candidate)) {
          return undefined;
        }
      }
      return input;
    },
    beforeAdmit: options.beforeAdmit,
    afterAdmit: options.afterAdmit,
  });
}
