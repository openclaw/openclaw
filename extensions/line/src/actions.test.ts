import { describe, expect, it } from "vitest";
import { messageAction, postbackAction, uriAction } from "./actions.js";

describe("messageAction", () => {
  it("creates message actions with explicit or default text", () => {
    const cases = [
      { name: "explicit text", label: "Help", text: "/help", expectedText: "/help" },
      { name: "defaults to label", label: "Click", text: undefined, expectedText: "Click" },
    ] as const;
    for (const testCase of cases) {
      const action = testCase.text
        ? messageAction(testCase.label, testCase.text)
        : messageAction(testCase.label);
      expect(action.type, testCase.name).toBe("message");
      expect(action.label, testCase.name).toBe(testCase.label);
      expect((action as { text: string }).text, testCase.name).toBe(testCase.expectedText);
    }
  });
});

describe("uriAction", () => {
  it("creates a URI action", () => {
    const action = uriAction("Open", "https://example.com");

    expect(action.type).toBe("uri");
    expect(action.label).toBe("Open");
    expect((action as { uri: string }).uri).toBe("https://example.com");
  });
});

describe("action label truncation", () => {
  it.each([
    {
      createAction: () => messageAction("This is a very long label text"),
      expectedLabel: "This is a very long ",
    },
    {
      createAction: () => uriAction("Click here to visit our website", "https://example.com"),
      expectedLabel: "Click here to visit ",
    },
  ])("truncates labels to 20 characters", ({ createAction, expectedLabel }) => {
    const action = createAction();
    expect(action.label).toBe(expectedLabel);
    expect((action.label ?? "").length).toBe(20);
  });
});

describe("postbackAction", () => {
  it("creates a postback action", () => {
    const action = postbackAction("Select", "action=select&item=1", "Selected item 1");

    expect(action.type).toBe("postback");
    expect(action.label).toBe("Select");
    expect((action as { data: string }).data).toBe("action=select&item=1");
    expect((action as { displayText: string }).displayText).toBe("Selected item 1");
  });

  it("visibly disables overlong postback data and truncates displayText", () => {
    const unavailable = postbackAction("Test", "x".repeat(400));
    expect(unavailable).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: callback data exceeds LINE's limit.",
    });

    const truncatedDisplay = postbackAction("Test", "data", "y".repeat(400));
    expect((truncatedDisplay as { displayText: string }).displayText?.length).toBe(300);

    const noDisplayText = postbackAction("Test", "data");
    expect((noDisplayText as { displayText?: string }).displayText).toBeUndefined();
  });
});
