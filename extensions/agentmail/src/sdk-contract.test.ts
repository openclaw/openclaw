import type { AgentMailClient } from "agentmail";
import { describe, expect, expectTypeOf, it } from "vitest";
import { agentMailPlugin } from "./channel.js";

describe("agentmail@0.5.16 SDK positional contract", () => {
  it("declares one atomic payload send for ordinary outbound attachments", () => {
    expect(agentMailPlugin.message?.send?.mediaPayloadMode).toBe("atomic");
    expect(agentMailPlugin.message?.send?.payload).toEqual(expect.any(Function));
    expect(agentMailPlugin.outbound?.extractMarkdownImages).toBe(true);
  });

  it("keeps message and attachment identifiers positional", () => {
    type Messages = AgentMailClient["inboxes"]["messages"];
    type Attachment = Awaited<ReturnType<Messages["getAttachment"]>>;
    expectTypeOf<Parameters<Messages["get"]>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Messages["get"]>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Messages["list"]>[0]>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<Parameters<Messages["list"]>[1]>>().toMatchTypeOf<{
      pageToken?: string;
      labels?: string[];
      after?: Date;
      ascending?: boolean;
    }>();
    expectTypeOf<Parameters<Messages["reply"]>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Messages["reply"]>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Messages["reply"]>[2]>().toMatchTypeOf<{
      text?: string;
      attachments?: unknown[];
      replyAll?: boolean;
    }>();
    expectTypeOf<NonNullable<Parameters<Messages["reply"]>[3]>>().toMatchTypeOf<{
      idempotencyKey?: string;
    }>();
    expectTypeOf<Parameters<Messages["getAttachment"]>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Messages["getAttachment"]>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Messages["getAttachment"]>[2]>().toEqualTypeOf<string>();
    expectTypeOf<Attachment["downloadUrl"]>().toEqualTypeOf<string>();
  });

  it("keeps webhook create/delete and WebSocket connect on the pinned client", () => {
    type Webhooks = AgentMailClient["inboxes"]["webhooks"];
    type Socket = Awaited<ReturnType<AgentMailClient["websockets"]["connect"]>>;
    expectTypeOf<Parameters<Webhooks["create"]>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Webhooks["create"]>[1]>().toMatchTypeOf<{
      url: string;
      eventTypes: string[];
    }>();
    expectTypeOf<Parameters<Webhooks["delete"]>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<Webhooks["delete"]>[1]>().toEqualTypeOf<string>();
    expectTypeOf<
      NonNullable<Parameters<AgentMailClient["websockets"]["connect"]>[0]>
    >().toMatchTypeOf<{
      apiKey?: string;
      abortSignal?: AbortSignal;
      waitForOpen?: boolean;
    }>();
    expectTypeOf<Parameters<Socket["sendSubscribe"]>[0]>().toMatchTypeOf<{
      type: "subscribe";
      inboxIds?: string[];
      eventTypes?: string[];
    }>();
  });
});
