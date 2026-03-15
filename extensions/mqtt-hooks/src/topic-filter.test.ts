import { describe, expect, it } from "vitest";
import { matchesMqttTopicFilter } from "./topic-filter.js";

describe("matchesMqttTopicFilter", () => {
  it("matches wildcard filters for regular topics", () => {
    expect(matchesMqttTopicFilter("home/alerts/#", "home/alerts/kitchen")).toBe(true);
    expect(matchesMqttTopicFilter("home/+/kitchen", "home/alerts/kitchen")).toBe(true);
  });

  it("rejects wildcard root filters for $-prefixed topics", () => {
    expect(matchesMqttTopicFilter("#", "$SYS/broker/uptime")).toBe(false);
    expect(matchesMqttTopicFilter("+/status", "$SYS/status")).toBe(false);
  });

  it("allows explicit $ root filters for $-prefixed topics", () => {
    expect(matchesMqttTopicFilter("$SYS/#", "$SYS/broker/uptime")).toBe(true);
    expect(matchesMqttTopicFilter("$SYS/+", "$SYS/status")).toBe(true);
  });
});
