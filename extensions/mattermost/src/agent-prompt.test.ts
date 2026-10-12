import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { mattermostAgentPrompt } from "./agent-prompt.js";
import { resolveMattermostPresentation } from "./normalize.js";

function hintsFor(cfg: OpenClawConfig, accountId?: string) {
  return mattermostAgentPrompt.messageToolHints!({ cfg, accountId });
}

describe("mattermostAgentPrompt message tool hints", () => {
  it("teaches a button shape that Mattermost renders as a control", () => {
    const cfg = { channels: { mattermost: { capabilities: ["inlineButtons"] } } } as OpenClawConfig;
    const [hint] = hintsFor(cfg);

    const presentation = /presentation=(\{.*\})`/.exec(hint ?? "")?.[1];
    expect(presentation).toBeDefined();
    const { buttons } = resolveMattermostPresentation({
      presentation: JSON.parse(presentation ?? "null"),
    });

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.[0]).toMatchObject({ text: "Yes", callback_data: "yes" });
  });

  it("asks for the array-form capability when buttons are off", () => {
    const [hint] = hintsFor({ channels: { mattermost: {} } } as OpenClawConfig);

    expect(hint).toContain('"inlineButtons" to mattermost.capabilities');
    expect(hint).not.toContain("dm|group");
  });

  it("lets an account turn buttons on", () => {
    const cfg = {
      channels: {
        mattermost: { accounts: { work: { capabilities: ["inlineButtons"] } } },
      },
    } as OpenClawConfig;

    expect(hintsFor(cfg, "work")[0]).toContain("Inline buttons: `send`");
    expect(hintsFor(cfg, "other")[0]).toContain("Inline buttons OFF");
  });
});
