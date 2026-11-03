import { NativeGitHubPublicationFailureError } from "openclaw/plugin-sdk/native-github-publication-host";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubPublicationKnownFailure,
  rejectGitHubPublicationSelection,
} from "./publication-failure-api.js";

describe("publication selection rejection", () => {
  it.each(["fresh", "existing", "lookup-failed", "unprepared"] as const)(
    "records a rejection fact only when the %s owner proves no accepted request",
    (mode) => {
      const idempotencyKey = "publication-selection";
      const hasRequest = vi.fn(() => {
        if (mode === "lookup-failed") {
          throw new Error("Receipt lookup unavailable.");
        }
        return mode === "existing";
      });
      let failure: unknown;
      try {
        rejectGitHubPublicationSelection(
          "GitHub publication identity changed.",
          mode === "unprepared" ? undefined : { idempotencyKey, hasRequest },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(NativeGitHubPublicationFailureError);
      if (!(failure instanceof GitHubPublicationKnownFailure)) {
        throw new Error("Expected the plugin's definitive selection failure", { cause: failure });
      }
      expect(failure.message).toBe("GitHub publication identity changed.");
      expect(failure.failure).toEqual({
        code: "identity_changed",
        nextAction: expect.stringContaining("Reconnect My GitHub or System GitHub"),
      });
      expect(failure.rejection).toEqual(
        mode === "fresh"
          ? { code: "GITHUB_PUBLICATION_SELECTION_REJECTED", idempotencyKey }
          : undefined,
      );
      expect(hasRequest).toHaveBeenCalledTimes(mode === "unprepared" ? 0 : 1);
    },
  );
});
