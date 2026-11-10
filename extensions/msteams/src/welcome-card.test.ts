import { describe, expect, it } from "vitest";
import { buildMSTeamsPresentationCard } from "./presentation.js";

const presentationCard = (
  block: Parameters<typeof buildMSTeamsPresentationCard>[0]["presentation"]["blocks"][number],
) => buildMSTeamsPresentationCard({ presentation: { blocks: [block] } });

describe("buildMSTeamsPresentationCard", () => {
  it("submits command actions as command text", () => {
    expect(
      presentationCard({
        type: "buttons",
        buttons: [
          { label: "Plugins", action: { type: "command", command: "/codex plugins menu" } },
        ],
      }),
    ).toMatchObject({
      actions: [{ type: "Action.Submit", title: "Plugins", data: "/codex plugins menu" }],
    });
  });

  it("keeps unavailable select commands visible in the Adaptive Card", () => {
    expect(
      presentationCard({
        type: "select",
        placeholder: "Environment",
        options: [
          { label: "Production", action: { type: "command", command: "/deploy production" } },
          { label: "Opaque", action: { type: "callback", value: "private-callback-token" } },
        ],
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
      presentationCard({
        type: "buttons",
        buttons: [
          { label: "Open app", webApp: { url: "https://example.com/app" } },
          { label: "Legacy app", web_app: { url: "https://example.com/legacy" } },
        ],
      }),
    ).toMatchObject({
      actions: [
        { type: "Action.OpenUrl", title: "Open app", url: "https://example.com/app" },
        { type: "Action.OpenUrl", title: "Legacy app", url: "https://example.com/legacy" },
      ],
    });
  });
});
