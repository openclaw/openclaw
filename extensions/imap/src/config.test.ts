import fs from "node:fs";
import type { IdentifierAuthentication } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { expect, it } from "vitest";
import { resolveImapConfig } from "./config.js";

it("rejects invalid passwords while deferring unresolved secret references", () => {
  const account = {
    host: "imap.example.com",
    user: "reader@example.com",
    agentId: "mail_reader",
  };
  for (const password of [undefined, null, 123, false, []]) {
    expect(() => resolveImapConfig({ accounts: { inbox: { ...account, password } } })).toThrow(
      "IMAP account inbox requires a resolved password",
    );
  }
  expect(
    resolveImapConfig({
      accounts: {
        inbox: {
          ...account,
          password: { source: "env", provider: "default", id: "IMAP_PASSWORD" },
        },
      },
    }),
  ).toEqual({ accounts: {} });
});

it("accepts all SDK authentication strengths and rejects an unknown config minimum", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: Record<string, unknown> };
  const strengths = [
    "mutable",
    "unverified",
    "asserted",
    "verified",
  ] satisfies IdentifierAuthentication[];
  for (const min of [...strengths, "unknown"]) {
    const value = {
      accounts: {
        inbox: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: "fixture-password",
          agentId: "mail_reader",
          senderAuth: { min },
        },
      },
    };
    expect(
      validateJsonSchemaValue({
        schema: manifest.configSchema,
        cacheKey: "imap.manifest.config-schema",
        value,
      }).ok,
    ).toBe(min !== "unknown");
    if (min !== "unknown") {
      expect(resolveImapConfig(value).accounts.inbox?.senderAuth.min).toBe(min);
    }
  }
});

it.each([
  { deliver: true, delivery: { channel: "telegram", to: "chat-123" }, valid: true },
  { deliver: true, delivery: { channel: "telegram" }, valid: false },
  { deliver: true, delivery: { to: "chat-123" }, valid: false },
  { deliver: true, delivery: { channel: " ", to: "chat-123" }, valid: false },
  { deliver: true, delivery: undefined, valid: true },
  { deliver: false, delivery: undefined, valid: true },
])("validates delivery route requirements: $delivery", ({ deliver, delivery, valid }) => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: Record<string, unknown> };
  const value = {
    accounts: {
      inbox: {
        host: "imap.example.com",
        user: "reader@example.com",
        password: "fixture-password",
        agentId: "mail_reader",
        deliver,
        ...(delivery ? { delivery } : {}),
      },
    },
  };

  expect(
    validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "imap.manifest.config-schema.delivery",
      value,
    }).ok,
  ).toBe(valid);
  if (valid) {
    expect(resolveImapConfig(value).accounts.inbox?.delivery).toEqual(delivery);
  }
});

it("preserves shipped deliver:true accounts without an explicit route", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: Record<string, unknown> };
  const value = {
    accounts: {
      inbox: {
        host: "imap.example.com",
        user: "reader@example.com",
        password: "fixture-password",
        agentId: "mail_reader",
        deliver: true,
      },
    },
  };

  expect(
    validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "imap.manifest.config-schema.legacy-deliver",
      value,
    }).ok,
  ).toBe(true);
  const resolved = resolveImapConfig(value).accounts.inbox;
  expect(resolved?.deliver).toBe(true);
  expect(resolved?.delivery).toBeUndefined();
});

it("rejects a partial delivery route when delivery is set", () => {
  expect(() =>
    resolveImapConfig({
      accounts: {
        inbox: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: "fixture-password",
          agentId: "mail_reader",
          deliver: true,
          delivery: { channel: " ", to: "chat-123" },
        },
      },
    }),
  ).toThrow("requires both delivery.channel and delivery.to when delivery is set");
});
