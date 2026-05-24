import { describe, expect, it } from "vitest";
import { splitEvenniaOutboundText } from "./channel.js";

describe("splitEvenniaOutboundText", () => {
  it("converts literal evennia_command speech into command parts", () => {
    expect(splitEvenniaOutboundText('evennia_command(command="pose wags tail excitedly")')).toEqual(
      [{ kind: "command", text: "pose wags tail excitedly" }],
    );
  });

  it("keeps surrounding speech while removing literal tool syntax from room output", () => {
    expect(
      splitEvenniaOutboundText('One sec. `evennia_command(command="look")` Okay, I checked.'),
    ).toEqual([
      { kind: "say", text: "One sec." },
      { kind: "command", text: "look" },
      { kind: "say", text: "Okay, I checked." },
    ]);
  });
});
