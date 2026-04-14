import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { buildMatrixQaConfig } from "./config.js";
import type { MatrixQaProvisionedTopology } from "./topology.js";

describe("matrix qa config", () => {
  const topology: MatrixQaProvisionedTopology = {
    defaultRoomId: "!main:matrix-qa.test",
    defaultRoomKey: "main",
    rooms: [
      {
        key: "main",
        kind: "group" as const,
        memberRoles: ["driver", "observer", "sut"],
        memberUserIds: [
          "@driver:matrix-qa.test",
          "@observer:matrix-qa.test",
          "@sut:matrix-qa.test",
        ],
        name: "Main",
        requireMention: true,
        roomId: "!main:matrix-qa.test",
      },
      {
        key: "secondary",
        kind: "group" as const,
        memberRoles: ["driver", "observer", "sut"],
        memberUserIds: [
          "@driver:matrix-qa.test",
          "@observer:matrix-qa.test",
          "@sut:matrix-qa.test",
        ],
        name: "Secondary",
        requireMention: true,
        roomId: "!secondary:matrix-qa.test",
      },
      {
        key: "driver-dm",
        kind: "dm" as const,
        memberRoles: ["driver", "sut"],
        memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
        name: "DM",
        requireMention: false,
        roomId: "!dm:matrix-qa.test",
      },
    ],
  };

  it("builds default Matrix QA config from provisioned topology", () => {
    const next = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(next.channels?.matrix?.accounts?.sut).toMatchObject({
      dm: {
        allowFrom: ["@driver:matrix-qa.test"],
        enabled: true,
        policy: "allowlist",
      },
      groupAllowFrom: ["@driver:matrix-qa.test"],
      groupPolicy: "allowlist",
      groups: {
        "!main:matrix-qa.test": { enabled: true, requireMention: true },
        "!secondary:matrix-qa.test": { enabled: true, requireMention: true },
      },
      replyToMode: "off",
      threadReplies: "inbound",
    });
  });

  it("applies room-keyed Matrix QA config overrides", () => {
    const next = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      overrides: {
        groupAllowFrom: ["@driver:matrix-qa.test", "@observer:matrix-qa.test"],
        groupsByKey: {
          secondary: {
            requireMention: false,
          },
        },
        replyToMode: "all",
        threadReplies: "always",
      },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(next.channels?.matrix?.accounts?.sut).toMatchObject({
      groupAllowFrom: ["@driver:matrix-qa.test", "@observer:matrix-qa.test"],
      groups: {
        "!main:matrix-qa.test": { enabled: true, requireMention: true },
        "!secondary:matrix-qa.test": { enabled: true, requireMention: false },
      },
      replyToMode: "all",
      threadReplies: "always",
    });
  });

  it("rejects unknown room-key overrides", () => {
    expect(() =>
      buildMatrixQaConfig({} as OpenClawConfig, {
        driverUserId: "@driver:matrix-qa.test",
        homeserver: "http://127.0.0.1:28008/",
        overrides: {
          groupsByKey: {
            ghost: {
              requireMention: false,
            },
          },
        },
        sutAccessToken: "sut-token",
        sutAccountId: "sut",
        sutUserId: "@sut:matrix-qa.test",
        topology,
      }),
    ).toThrow('Matrix QA group override references unknown room key "ghost"');
  });
});
