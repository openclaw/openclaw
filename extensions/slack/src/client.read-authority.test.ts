import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSlackWebClientOptions } from "./client-options.js";
import { createSlackReadClient, createSlackLookupClient } from "./client.js";

const scope = vi.hoisted(() => ({ current: undefined as (() => void) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  captureChannelReadAuthority: () => scope.current,
}));
afterEach(() => {
  scope.current = undefined;
});

function authority() {
  let active = true;
  return {
    assert: () => {
      if (!active) {
        throw new Error("read authority revoked");
      }
    },
    revoke: () => {
      active = false;
    },
  };
}

describe("Slack read request authority", () => {
  it("fences the real SDK retry even after the ambient scope changes", async () => {
    const reader = authority();
    const fetch = vi.fn(async () => {
      reader.revoke();
      scope.current = undefined;
      return Response.json({ ok: false }, { status: 500 });
    });
    scope.current = reader.assert;
    const client = createSlackReadClient("synthetic-token", {
      fetch,
      slackApiUrl: "https://slack.invalid/api/",
      retryConfig: { retries: 1, minTimeout: 1, maxTimeout: 1 },
    });
    await expect(client.conversations.history({ channel: "CEXAMPLE" })).rejects.toThrow(
      "read authority revoked",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fences channel lookup clients before transport", async () => {
    const reader = authority();
    const fetch = vi.fn();
    scope.current = reader.assert;
    const client = createSlackLookupClient("synthetic-token", {
      fetch,
      slackApiUrl: "https://slack.invalid/api/",
    });
    scope.current = undefined;
    reader.revoke();
    await expect(client.conversations.info({ channel: "CEXAMPLE" })).rejects.toThrow(
      "read authority revoked",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors the invocation scope when reusing an unscoped fetch", async () => {
    const fetch = vi.fn();
    const options = resolveSlackWebClientOptions({ fetch });
    const reader = authority();
    scope.current = reader.assert;
    reader.revoke();
    expect(() => options.fetch?.("https://slack.invalid/api/conversations.history")).toThrow(
      "read authority revoked",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
