import type { App } from "@slack/bolt";
import { WebAPIPlatformError } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { updateSlackSuggestedPrompts } from "./suggested-prompts.js";

function createSlackClient(setSuggestedPrompts: ReturnType<typeof vi.fn>): App["client"] {
  return { assistant: { threads: { setSuggestedPrompts } } } as unknown as App["client"];
}

const prompts = [{ title: "Draft a reply", message: "Help me draft a reply." }];
const platformError = (error: string) => new WebAPIPlatformError({ ok: false, error });
function update(
  setSuggestedPrompts: ReturnType<typeof vi.fn>,
  retryTransientErrors = false,
  title?: string,
) {
  return updateSlackSuggestedPrompts({
    botToken: "",
    client: createSlackClient(setSuggestedPrompts),
    channelId: "D123",
    title,
    prompts,
    retryTransientErrors,
  });
}

describe("updateSlackSuggestedPrompts", () => {
  it("omits thread_ts for the Agent View capability probe", async () => {
    const setSuggestedPrompts = vi.fn().mockResolvedValue({ ok: true });
    await update(setSuggestedPrompts, false, "Try asking");
    expect(setSuggestedPrompts).toHaveBeenCalledWith({
      token: "",
      channel_id: "D123",
      title: "Try asking",
      prompts,
    });
  });
  it.each([
    ["successful update", undefined, "accepted"],
    ["non-Agent app", platformError("not_agent_app"), "rejected"],
    ["missing scope", platformError("missing_scope"), "rejected"],
    ["internal error", platformError("internal_error"), "internal_error"],
    ["other platform error", platformError("invalid_auth"), "failed"],
    ["unknown error", new Error("internal_error"), "failed"],
  ] as const)("classifies %s", async (_name, error, outcome) => {
    const setSuggestedPrompts = error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue({ ok: true });
    expect(await update(setSuggestedPrompts)).toBe(outcome);
  });
  it.each([
    ["permanent authorization failure", platformError("invalid_auth"), "failed"],
    ["ordinary error", new Error("connection reset"), "failed"],
    [
      "incomplete rate-limit signature",
      new Error("Retry header did not contain a valid timeout"),
      "failed",
    ],
    [
      "extended rate-limit signature",
      new Error(
        "Retry header did not contain a valid timeout (url: https://slack.test/api/test, retry-after header: null) extra",
      ),
      "failed",
    ],
    ["threadless capability response", platformError("internal_error"), "internal_error"],
  ] as const)(
    "preserves the outcome for %s during durable retries",
    async (_name, error, outcome) => {
      await expect(update(vi.fn().mockRejectedValue(error), true)).resolves.toBe(outcome);
    },
  );
});
