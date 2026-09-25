// Verifies runtime channel capabilities derived from channel account config.
import { describe, expect, it } from "vitest";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";

describe("collectRuntimeChannelCapabilities", () => {
  it("advertises markdown details when the browser handshake includes the flag", () => {
    expect(
      collectRuntimeChannelCapabilities({
        channel: "webchat",
        clientCaps: ["tool-events", "markdown-details"],
      }),
    ).toEqual(["markdownDetails"]);
  });

  it("does not advertise markdown details when an explicit capability list omits the flag", () => {
    expect(
      collectRuntimeChannelCapabilities({
        channel: "webchat",
        clientCaps: ["tool-events", "inline-widgets"],
      }),
    ).toBeUndefined();
  });

  it("does not grant disclosure guidance to a webchat client that omits its capability list", () => {
    expect(collectRuntimeChannelCapabilities({ channel: "webchat" })).toBeUndefined();
    expect(
      collectRuntimeChannelCapabilities({
        channel: "webchat",
        clientCaps: [],
      }),
    ).toBeUndefined();
    expect(
      collectRuntimeChannelCapabilities({
        channel: "webchat",
        clientCaps: null,
      }),
    ).toBeUndefined();
  });

  it("keeps disclosure guidance for installed native clients that predate the flag", () => {
    for (const clientId of ["openclaw-macos", "openclaw-ios", "openclaw-android"]) {
      expect(
        collectRuntimeChannelCapabilities({
          channel: "webchat",
          clientId,
          clientCaps: ["agent-kind", "inline-widgets"],
        }),
      ).toEqual(["markdownDetails"]);
    }
  });

  it("does not advertise markdown details for a plugin-less non-webchat channel", () => {
    expect(collectRuntimeChannelCapabilities({ channel: "heartbeat" })).toBeUndefined();
    expect(
      collectRuntimeChannelCapabilities({
        channel: "heartbeat",
        clientCaps: [],
      }),
    ).toBeUndefined();
  });

  it("adds thread-bound spawn capabilities when the channel account allows unified spawns", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        session: {
          threadBindings: {
            spawnSessions: true,
          },
        },
      },
    });

    expect(capabilities).toEqual(["threadbound-subagent-spawn", "threadbound-acp-spawn"]);
  });

  it("omits thread-bound spawn capabilities when unified spawns are disabled", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        session: {
          threadBindings: {
            spawnSessions: false,
          },
        },
      },
    });

    expect(capabilities).toBeUndefined();
  });
});
