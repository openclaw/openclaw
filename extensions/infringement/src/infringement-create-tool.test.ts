import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { createInfringementCreateToolFactory, parseLinks } from "./infringement-create-tool.js";
import type { TaskWorkerPublisher } from "./rabbitmq-publisher.js";

describe("parseLinks", () => {
  it("splits a newline string, trims, drops blanks and dupes", () => {
    expect(parseLinks("https://a.com\n  https://b.com  \n\nhttps://a.com\n")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("accepts an array of strings", () => {
    expect(parseLinks(["https://a.com", "", "https://b.com"])).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("caps at 100 links", () => {
    const many = Array.from({ length: 250 }, (_, i) => `https://x.com/${i}`);
    expect(parseLinks(many)).toHaveLength(100);
  });

  it("returns [] for non-string/array input", () => {
    expect(parseLinks(undefined)).toEqual([]);
    expect(parseLinks(42)).toEqual([]);
  });
});

const fakeApi = {
  pluginConfig: {},
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

const fakePublisher = {} as TaskWorkerPublisher;

describe("createInfringementCreateToolFactory gating", () => {
  const factory = createInfringementCreateToolFactory(fakeApi, fakePublisher);

  it("hides the tool from non-rabbitmq agents", () => {
    expect(factory({ agentId: "telegram-1" })).toBeNull();
    expect(factory({ agentId: undefined })).toBeNull();
  });

  it("hides the tool when the userId is not a positive integer", () => {
    expect(factory({ agentId: "rabbitmq-abc" })).toBeNull();
  });

  it("exposes the tool to rabbitmq-<numericUserId> agents", () => {
    const tool = factory({ agentId: "rabbitmq-1749" });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("infringement_create_task");
  });
});
