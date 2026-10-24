import { describe, expect, it } from "vitest";
import { selectMainSessionRecoveryCheckpoint } from "./main-session-recovery-checkpoint.js";

describe.each(["cron", "cron_execution"])(
  "selectMainSessionRecoveryCheckpoint (%s)",
  (sourceTool) => {
    it.each([
      { label: "external", provenance: { kind: "external_user" }, source: "external_user" },
      {
        label: "external with cron tag",
        provenance: { kind: "external_user", sourceTool },
        source: "external_user",
      },
      { label: "unverified", provenance: undefined, source: undefined },
    ])(
      "keeps cron through confirmed $label steering until a new turn",
      ({ provenance, source }) => {
        const messages: unknown[] = [
          { role: "user", provenance: { kind: "internal_system", sourceTool } },
          { role: "user", provenance, __openclaw: { steerTargetRunId: "cron-run" } },
        ];
        const checkpoint = () =>
          selectMainSessionRecoveryCheckpoint((read) => {
            for (const message of messages) {
              read(message);
            }
          });

        expect(checkpoint()).toEqual({ replaySafe: false, source: "cron" });
        messages.push({ role: "user", provenance });
        expect(checkpoint()).toEqual({ replaySafe: false, source });
      },
    );
  },
);
