import { describe, expect, it } from "vitest";
import {
  buildEvenniaInboundHistory,
  clearEvenniaHistoryForTests,
  evenniaHistoryKey,
  recordEvenniaHistoryEvent,
  splitEvenniaOutboundText,
} from "./channel.js";

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

  it("converts movement commands appended after emoji narration into command parts", () => {
    expect(
      splitEvenniaOutboundText("I'm on my way. Tell Scoob the elder arrives. 🧙‍♂️war room"),
    ).toEqual([
      { kind: "say", text: "I'm on my way. Tell Scoob the elder arrives." },
      { kind: "command", text: "war room" },
    ]);
  });

  it("does not treat normal emoji reactions as movement commands", () => {
    expect(splitEvenniaOutboundText("Nice work 👍 good job")).toEqual([
      { kind: "say", text: "Nice work 👍 good job" },
    ]);
  });
});

describe("Evennia history window", () => {
  const account = {
    channelId: "evennia",
    accountId: "scoob",
    historyLimit: 20,
  };

  it("keys room and direct histories separately", () => {
    expect(
      evenniaHistoryKey(account, {
        kind: "room",
        room: "Server Room",
        sender: "Bee",
        text: "hey scoob",
      }),
    ).toBe("evennia:scoob:room:Server Room");
    expect(
      evenniaHistoryKey(account, {
        kind: "tell",
        room: "Server Room",
        sender: "Bee",
        text: "secret",
      }),
    ).toBe("evennia:scoob:direct:Bee");
  });

  it("returns at least the previous 20 room messages for the next turn", () => {
    clearEvenniaHistoryForTests();
    for (let i = 1; i <= 25; i += 1) {
      recordEvenniaHistoryEvent(account, {
        id: `m-${i}`,
        kind: "room",
        room: "Server Room",
        sender: `User${i}`,
        text: `message ${i}`,
        timestamp: i,
      });
    }

    const history = buildEvenniaInboundHistory(account, {
      kind: "room",
      room: "Server Room",
      sender: "Bee",
      text: "scoob what happened",
      timestamp: 26,
    });

    expect(history).toHaveLength(20);
    expect(history?.[0]).toMatchObject({ sender: "User6", body: "message 6" });
    expect(history?.[19]).toMatchObject({ sender: "User25", body: "message 25" });
  });
});
