import { describe, expect, it } from "vitest";
import { buildMSTeamsPresentationCard } from "./presentation.js";
import { buildGroupWelcomeText, buildWelcomeCard } from "./welcome-card.js";

describe("buildMSTeamsPresentationCard", () => {
  it("submits command actions as command text", () => {
    expect(
      buildMSTeamsPresentationCard({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Plugins",
                  action: { type: "command", command: "/codex plugins menu" },
                },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({
      actions: [{ type: "Action.Submit", title: "Plugins", data: "/codex plugins menu" }],
    });
  });

  it("keeps unavailable select commands visible in the Adaptive Card", () => {
    expect(
      buildMSTeamsPresentationCard({
        presentation: {
          blocks: [
            {
              type: "select",
              placeholder: "Environment",
              options: [
                { label: "Production", action: { type: "command", command: "/deploy production" } },
                { label: "Opaque", action: { type: "callback", value: "private-callback-token" } },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({
      body: [
        {
          type: "TextBlock",
          text: "Environment:\n- Production: `/deploy production`\n- Opaque",
        },
      ],
    });
  });

  it("renders web app button links as open-url actions", () => {
    expect(
      buildMSTeamsPresentationCard({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Open app", webApp: { url: "https://example.com/app" } },
                { label: "Legacy app", web_app: { url: "https://example.com/legacy" } },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({
      actions: [
        { type: "Action.OpenUrl", title: "Open app", url: "https://example.com/app" },
        { type: "Action.OpenUrl", title: "Legacy app", url: "https://example.com/legacy" },
      ],
    });
  });
});

describe("buildWelcomeCard", () => {
  it("uses custom prompt starters", () => {
    const card = buildWelcomeCard({
      promptStarters: ["Do X", "Do Y"],
    });
    const actions = card.actions as Array<{ title: string; data: unknown }>;
    expect(actions.length).toBe(2);
    expect(actions[0]?.title).toBe("Do X");
    expect(actions[1]?.title).toBe("Do Y");

    // Verify imBack data
    const data = actions[0]?.data as { msteams: { type: string; value: string } };
    expect(data.msteams.type).toBe("imBack");
    expect(data.msteams.value).toBe("Do X");
  });

  it("falls back to defaults when promptStarters is empty", () => {
    const card = buildWelcomeCard({ promptStarters: [] });
    const heading = (card.body as Array<{ weight?: string; size?: string }>)[0];
    expect(heading?.weight).toBe("Bolder");
    expect(heading?.size).toBe("Medium");
    const actions = card.actions as Array<{ title: string }>;
    expect(actions.length).toBe(3);
  });
});

describe("buildGroupWelcomeText", () => {
  it("defaults to OpenClaw", () => {
    const text = buildGroupWelcomeText();
    expect(text).toContain("OpenClaw");
  });
});
