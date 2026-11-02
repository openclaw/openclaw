import { describe, expect, it } from "vitest";
import { SlackHuddlesInvalidRequestError } from "../errors.js";
import {
  isRecoverableSlackHuddleTab,
  isSameSlackHuddleUrl,
  normalizeSlackHuddleUrl,
  normalizeSlackHuddleUrlForReuse,
} from "./slack-huddles-urls.js";

describe("Slack huddle URLs", () => {
  it.each([
    [
      "https://workspace.slack.com/huddle/E0123ABCD/G0123ABCD/?ref=share#huddle",
      "E0123ABCD/G0123ABCD",
      "slack-huddle:E0123ABCD:G0123ABCD",
    ],
    ["https://workspace.slack.com/huddle/D0123ABCD/", "D0123ABCD", "slack-huddle:D0123ABCD"],
    [" channel:G0123ABCD ", "G0123ABCD", "slack-huddle:G0123ABCD"],
    ["SlAcK:ChAnNeL:D0123ABCD", "D0123ABCD", "slack-huddle:D0123ABCD"],
    ["team:T0123ABCD:channel:C0123ABCD", "T0123ABCD/C0123ABCD", "slack-huddle:T0123ABCD:C0123ABCD"],
    [
      "sLaCk:TeAm:T0123ABCD:ChAnNeL:C0123ABCD",
      "T0123ABCD/C0123ABCD",
      "slack-huddle:T0123ABCD:C0123ABCD",
    ],
  ])("normalizes %s and its reuse identity", (input, path, identity) => {
    expect(normalizeSlackHuddleUrl(input)).toBe(`https://app.slack.com/huddle/${path}`);
    expect(normalizeSlackHuddleUrlForReuse(input)).toBe(identity);
  });

  it.each([
    undefined,
    "",
    "U0123ABCD",
    "https://app.slack.com/huddle/c0123abcd",
    "https://app.slack.com/huddle/t0123abcd/C0123ABCD",
    "team:t0123abcd:channel:C0123ABCD",
    "team:T0123ABCD:channel:c0123abcd",
    "http://app.slack.com/huddle/T0123ABCD/C0123ABCD",
    "https://slack.com.evil.example/huddle/T0123ABCD/C0123ABCD",
    "https://app.slack.com/client/T0123ABCD/C0123ABCD",
    "https://user:secret@app.slack.com/huddle/C0123ABCD",
    "https://app.slack.com:8443/huddle/C0123ABCD",
  ])("rejects non-huddle input %j with the plugin error", (input) => {
    expect(() => normalizeSlackHuddleUrl(input)).toThrow(SlackHuddlesInvalidRequestError);
    expect(() => normalizeSlackHuddleUrl(input)).toThrow(/huddle link.*channel id/i);
  });

  it("keeps workspace scope in reuse identity and never matches across workspaces", () => {
    const qualified = "https://app.slack.com/huddle/T0123ABCD/C0123ABCD";
    const otherWorkspace = "https://app.slack.com/huddle/T9999ABCD/C0123ABCD";
    const bare = "https://app.slack.com/huddle/C0123ABCD";
    expect(normalizeSlackHuddleUrlForReuse(qualified)).toBe("slack-huddle:T0123ABCD:C0123ABCD");
    expect(normalizeSlackHuddleUrlForReuse("channel:C0123ABCD")).toBe("slack-huddle:C0123ABCD");
    expect(isSameSlackHuddleUrl(qualified, "team:T0123ABCD:channel:C0123ABCD")).toBe(true);
    expect(isSameSlackHuddleUrl(qualified, otherWorkspace)).toBe(false);
    expect(isSameSlackHuddleUrl(qualified, bare)).toBe(false);
    expect(isSameSlackHuddleUrl(bare, "channel:C0123ABCD")).toBe(true);
    expect(isRecoverableSlackHuddleTab({ targetId: "tab-1", url: qualified }, otherWorkspace)).toBe(
      false,
    );
    expect(
      isRecoverableSlackHuddleTab(
        { targetId: "tab-1", url: "https://app.slack.com/client/T0123ABCD/C0123ABCD" },
        qualified,
      ),
    ).toBe(false);
  });
});
