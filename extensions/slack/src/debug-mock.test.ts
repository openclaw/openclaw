import { vi, it, expect } from "vitest";
vi.mock("@slack/bolt", () => {
  class App {
    client = {};
    event() {}
    command() {}
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
  }
  class HTTPReceiver {
    requestListener = vi.fn();
  }
  return { App, HTTPReceiver, default: { App, HTTPReceiver } };
});

import SlackBolt from "@slack/bolt";

it("debug mock", () => {
  console.log("SlackBolt:", SlackBolt);
  console.log("type:", typeof SlackBolt);
  const m = SlackBolt as any;
  console.log("m.App:", typeof m.App);
  console.log("m.default:", typeof m.default);

  const slackBolt = (m.App ? m : m.default) ?? m;
  console.log("resolved.App:", typeof slackBolt.App);
  const { App } = slackBolt;
  console.log("App:", typeof App, App);
  expect(typeof App).toBe("function");
});
