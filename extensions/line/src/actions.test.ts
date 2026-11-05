import { expect, it } from "vitest";
import { messageAction, postbackAction, uriAction } from "./actions.js";

it("defaults message text to the full label while truncating its button", () => {
  expect(messageAction("This is a very long label text")).toEqual({
    type: "message",
    label: "This is a very long ",
    text: "This is a very long label text",
  });
});

it("truncates a URI label without changing its destination", () => {
  expect(uriAction("Click here to visit our website", "https://example.com")).toEqual({
    type: "uri",
    label: "Click here to visit ",
    uri: "https://example.com",
  });
});

it("preserves postback data and display text", () => {
  expect(postbackAction("Select", "action=select&item=1", "Selected item 1")).toMatchObject({
    type: "postback",
    label: "Select",
    data: "action=select&item=1",
    displayText: "Selected item 1",
  });
});
