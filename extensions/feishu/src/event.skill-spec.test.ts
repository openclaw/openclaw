import { describe, expect, it } from "vitest";
import {
  FEISHU_SKILL_SUBSCRIBERS_VERSION,
  parseFeishuSkillSubscriberSpec,
  parseFeishuSkillSubscriberSpecJson,
} from "./event.skill-spec.js";

describe("event.skill-spec", () => {
  it("parses a valid declarative subscriber file and defaults enabled to true", () => {
    const parsed = parseFeishuSkillSubscriberSpec({
      version: FEISHU_SKILL_SUBSCRIBERS_VERSION,
      subscribers: [
        {
          id: "approval-review",
          targetAgentId: "ops",
          match: {
            eventTypes: ["approval.approval.updated_v4"],
            categories: ["approval.instance"],
            route: "publish",
          },
          trigger: {
            mode: "isolated",
            prompt: "handle approval event",
            sessionKey: "approval:{{event.sourceId}}",
          },
          delivery: {
            concurrencyLimit: 1,
          },
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.subscribers).toHaveLength(1);
    expect(parsed.value.subscribers[0]).toMatchObject({
      id: "approval-review",
      enabled: true,
      targetAgentId: "ops",
    });
    expect(parsed.value.subscribers[0].match).toMatchObject({
      eventTypes: ["approval.approval.updated_v4"],
      categories: ["approval.instance"],
      route: "publish",
    });
  });

  it("parses a handler-only subscriber without requiring an agent trigger", () => {
    const parsed = parseFeishuSkillSubscriberSpec({
      version: FEISHU_SKILL_SUBSCRIBERS_VERSION,
      subscribers: [
        {
          id: "bitable-record-log",
          match: {
            eventTypes: ["drive.file.bitable_record_changed_v1"],
            categories: ["bitable.record"],
          },
          handler: {
            file: "./bitable-record-log.handler.mjs",
          },
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.subscribers[0]).toMatchObject({
      id: "bitable-record-log",
      enabled: true,
      handler: {
        file: "./bitable-record-log.handler.mjs",
      },
    });
  });

  it("reports schema errors for invalid files", () => {
    const parsed = parseFeishuSkillSubscriberSpec({
      version: 2,
      subscribers: [
        {
          id: "",
          targetAgentId: "",
          trigger: {
            prompt: "",
            mode: "bad-mode",
          },
          delivery: {
            concurrencyLimit: 0,
          },
        },
      ],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.version" }),
        expect.objectContaining({ path: "$.subscribers[0].id" }),
        expect.objectContaining({ path: "$.subscribers[0].targetAgentId" }),
        expect.objectContaining({ path: "$.subscribers[0].trigger.prompt" }),
        expect.objectContaining({ path: "$.subscribers[0].trigger.mode" }),
        expect.objectContaining({ path: "$.subscribers[0].delivery.concurrencyLimit" }),
      ]),
    );
  });

  it("requires each subscriber to define a trigger or a handler", () => {
    const parsed = parseFeishuSkillSubscriberSpec({
      version: FEISHU_SKILL_SUBSCRIBERS_VERSION,
      subscribers: [
        {
          id: "missing-executor",
        },
      ],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "$.subscribers[0]" })]),
    );
  });

  it("reports invalid json syntax", () => {
    const parsed = parseFeishuSkillSubscriberSpecJson('{"version":1,"subscribers":[');

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors[0]?.path).toBe("$");
  });
});
