import { describe, expect, it } from "vitest";
import { prepareDiscordCopyTextFallbacks } from "./copy-text-fallback.js";
import { DISCORD_PRESENTATION_TEXT_LIMIT } from "./outbound-components.js";

function extractFencedValue(value: string): string {
  const opener = /\n(`{3,}|~{3,})\n/u.exec(value);
  if (!opener) {
    throw new Error("expected fenced Discord copy fallback");
  }
  const fence = opener[1] ?? "";
  const start = (opener.index ?? 0) + opener[0].length;
  const close = `\n${fence}`;
  expect(value.endsWith(close)).toBe(true);
  return value.slice(start, -close.length);
}

describe("Discord copy-text fallback safety", () => {
  it("keeps every long hostile fragment independently fenced and byte-readable", () => {
    const copyText = `${"x".repeat(2080)} @everyone @here <@123> <@!456> <@&789> ${"`~".repeat(80)}`;
    const source = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            { label: "Copy hostile value", action: { type: "copy-text" as const, text: copyText } },
          ],
        },
      ],
    };

    const prepared = prepareDiscordCopyTextFallbacks({
      presentation: source,
      maxCharacters: DISCORD_PRESENTATION_TEXT_LIMIT,
    });

    expect(prepared.changed).toBe(true);
    expect(prepared.suppressMentions).toBe(true);
    expect(prepared.presentation.blocks.length).toBeGreaterThan(1);
    const fragments = prepared.presentation.blocks.map((block) => {
      expect(block.type).toBe("context");
      if (block.type !== "context") {
        throw new Error("expected context fallback");
      }
      expect(Array.from(block.text).length).toBeLessThanOrEqual(DISCORD_PRESENTATION_TEXT_LIMIT);
      return extractFencedValue(block.text);
    });
    expect(fragments.join("")).toBe(copyText);
  });

  it("does not suppress mentions for disabled copy data that is never rendered", () => {
    const source = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Unavailable",
              action: { type: "copy-text" as const, text: "@everyone" },
              disabled: true,
            },
          ],
        },
      ],
    };

    const prepared = prepareDiscordCopyTextFallbacks({
      presentation: source,
      maxCharacters: DISCORD_PRESENTATION_TEXT_LIMIT,
    });

    expect(prepared.suppressMentions).toBe(false);
    expect(prepared.presentation.blocks).toEqual([
      { type: "context", text: "Actions:\n- Unavailable" },
    ]);
  });

  it.each([false, true])(
    "suppresses every mention class rendered by an enabled=%s copy label",
    (disabled) => {
      const label = "Copy @everyone @here <@123> <@!456> <@&789>";
      const prepared = prepareDiscordCopyTextFallbacks({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label,
                  action: { type: "copy-text", text: "SAFE-TOKEN" },
                  disabled,
                },
              ],
            },
          ],
        },
        maxCharacters: DISCORD_PRESENTATION_TEXT_LIMIT,
      });

      expect(prepared.suppressMentions).toBe(true);
      expect(prepared.presentation.blocks).toHaveLength(1);
      expect(prepared.presentation.blocks[0]).toMatchObject({
        type: "context",
        text: expect.stringContaining(label),
      });
    },
  );
});
