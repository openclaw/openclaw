import { describe, expect, it } from "vitest";
import { validatePullRequestDraft } from "./pr-preflight-policy.mjs";

describe("validatePullRequestDraft", () => {
  it("passes for a merge-ready PR body", () => {
    const result = validatePullRequestDraft({
      title: "fix(telegram): disable link previews in draft stream",
      body: `Closes #111525

## What Problem This Solves
Fixes an issue where Telegram draft previews could ignore the disabled link preview setting.

## Why This Change Was Made
This keeps the draft stream aligned with the configured Telegram account behavior.

## User Impact
Users who disable link previews now get consistent behavior in draft send/edit updates.

## Evidence
- \`node scripts/run-vitest.mjs extensions/telegram/src/draft-stream.test.ts extensions/telegram/src/bot-message-dispatch.test.ts\`
- \`git diff --check\`

AI-assisted`,
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects a title that does not match the required shape", () => {
    const result = validatePullRequestDraft({
      title: "disable previews",
      body: `## What Problem This Solves
Fixes the Telegram preview regression.

## Why This Change Was Made
It threads the account flag into the draft stream.

## User Impact
Users see the configured behavior consistently.

## Evidence
- test output`,
    });

    expect(result.errors).toContain("Title must use `type: user-facing description`.");
  });

  it("rejects PR bodies that still contain template placeholders", () => {
    const result = validatePullRequestDraft({
      title: "fix(telegram): disable link previews in draft stream",
      body: `<!-- template -->

## What Problem This Solves
Describe the concrete user, product, or operational problem.

## Why This Change Was Made
In one or two sentences, explain the complete shipped solution.

## User Impact
State what users can now do.

## Evidence
Show the most useful proof.`,
    });

    expect(result.errors).toContain(
      "PR body still contains template placeholder text or HTML comments.",
    );
  });

  it("warns when the PR is missing an issue link or AI-assisted marker", () => {
    const result = validatePullRequestDraft({
      title: "fix(telegram): disable link previews in draft stream",
      body: `## What Problem This Solves
Fixes the Telegram preview regression.

## Why This Change Was Made
It threads the account flag into the draft stream.

## User Impact
Users get consistent behavior.

## Evidence
- test output`,
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain(
      "Add a `Closes #<issue>` or `Related: #<issue>` line when the work maps to an issue.",
    );
    expect(result.warnings).toContain(
      "Mark the PR as AI-assisted in the title or body so reviewers know what to expect.",
    );
  });
});
