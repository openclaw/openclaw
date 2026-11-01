// Msteams tests cover mentions plugin behavior.
import { describe, expect, it } from "vitest";
import { buildMSTeamsMessageActivity } from "./message-activity.js";

function requireMentionEntity(result: ReturnType<typeof buildMSTeamsMessageActivity>) {
  expect(result.entities).toHaveLength(2);
  const entity = result.entities[0];
  if (!entity) {
    throw new Error("expected message activity to include a mention entity");
  }
  return entity;
}

describe("MSTeams message mentions", () => {
  it.each([
    {
      label: "escaped brackets and backslash",
      source: String.raw`DOMAIN\\Alice \[Ops\]`,
      name: String.raw`DOMAIN\Alice [Ops]`,
    },
  ])("handles a mention name with $label", ({ source, name }) => {
    const result = buildMSTeamsMessageActivity(`@[${source}](28:a1b2c3)`);

    expect(result.text).toBe(`<at>${name}</at>`);
    expect(requireMentionEntity(result)).toMatchObject({ mentioned: { name } });
  });

  it("skips mention-like patterns with non-Teams IDs (e.g. in code blocks)", () => {
    // This reproduces the actual failing payload: the message contains a real mention
    // plus `@[表示名](ユーザーID)` as documentation text inside backticks.
    const input =
      "@[タナカ タロウ](a1b2c3d4-e5f6-7890-abcd-ef1234567890) スキル化完了しました！📋\n\n" +
      "**作成したスキル:** `teams-mention`\n" +
      "- 機能: Teamsでのメンション形式 `@[表示名](ユーザーID)`\n\n" +
      "**追加対応:**\n" +
      "- ユーザーのID `a1b2c3d4-e5f6-7890-abcd-ef1234567890` を登録済み";
    const result = buildMSTeamsMessageActivity(input);

    // Only the real mention should be parsed; the documentation example should be left as-is
    const firstEntity = requireMentionEntity(result);
    expect(firstEntity).toMatchObject({
      mentioned: { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
    });
    expect(firstEntity).toMatchObject({ mentioned: { name: "タナカ タロウ" } });

    // The documentation pattern must remain untouched in the text
    expect(result.text).toContain("`@[表示名](ユーザーID)`");
  });

  it("accepts Bot Framework IDs with non-hex payloads (29:xxx)", () => {
    const result = buildMSTeamsMessageActivity("@[Bot](29:08q2j2o3jc09au90eucae)");
    expect(requireMentionEntity(result)).toMatchObject({
      mentioned: { id: "29:08q2j2o3jc09au90eucae" },
    });
  });

  it("accepts org-scoped IDs with extra segments (8:orgid:...)", () => {
    const result = buildMSTeamsMessageActivity(
      "@[User](8:orgid:2d8c2d2c-1111-2222-3333-444444444444)",
    );
    expect(requireMentionEntity(result)).toMatchObject({
      mentioned: { id: "8:orgid:2d8c2d2c-1111-2222-3333-444444444444" },
    });
  });
});
