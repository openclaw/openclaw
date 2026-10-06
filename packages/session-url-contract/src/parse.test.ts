import { describe, expect, it } from "vitest";
import { buildControlUiSessionPath } from "./index.js";
import {
  matchControlUiCatalogSharePath,
  parseControlUiSessionPath,
  type ControlUiSessionPathTarget,
} from "./parse.js";

type ParseCase = readonly [
  pathname: string,
  expected: ControlUiSessionPathTarget,
  basePath?: string,
];

describe("parseControlUiSessionPath", () => {
  it.each([
    ["/chat/main", { namespace: "chat", kind: "main", agentId: "main" }],
    [
      "/control/dashboard/OPS-Team",
      { namespace: "dashboard", kind: "main", agentId: "ops-team" },
      "/control",
    ],
    [
      "/dashboard/main/12345678",
      {
        namespace: "dashboard",
        kind: "short",
        agentId: "main",
        shortId: "12345678",
        literalSessionKey: "agent:main:12345678",
      },
    ],
    [
      "/chat/wrong/wrong-slug-1234567890AB",
      {
        namespace: "chat",
        kind: "short",
        agentId: "wrong",
        shortId: "1234567890ab",
        literalSessionKey: "agent:wrong:wrong-slug-1234567890AB",
        slugHint: "wrong-slug",
      },
    ],
    [
      "/chat/main/not-a-short-id",
      {
        namespace: "chat",
        kind: "literal",
        agentId: "main",
        sessionKey: "agent:main:not-a-short-id",
        slugCandidate: "not-a-short-id",
      },
    ],
  ] satisfies readonly ParseCase[])("parses %s", (pathname, expected, basePath = "") => {
    expect(parseControlUiSessionPath(pathname, basePath)).toEqual(expected);
  });

  it.each([
    ["/chat/main/~key/release-deadbeef", "agent:main:release-deadbeef"],
    ["/chat/main/cron/~dot/~dotdot/run", "agent:main:cron:.:..:run"],
    ["/chat/main/channel/~~dot", "agent:main:channel:~dot"],
  ])("decodes literal path %s", (pathname, sessionKey) => {
    expect(parseControlUiSessionPath(pathname)).toEqual({
      namespace: "chat",
      kind: "literal",
      agentId: "main",
      sessionKey,
    });
  });

  it("keeps reserved boot literal", () => {
    expect(parseControlUiSessionPath("/chat/main/boot")).toEqual({
      namespace: "chat",
      kind: "literal",
      agentId: "main",
      sessionKey: "agent:main:boot",
    });
  });

  it("keeps configured and default main keys distinct", () => {
    expect(parseControlUiSessionPath("/chat/research", "", "workspace")).toMatchObject({
      kind: "main",
      agentId: "research",
    });
    for (const key of ["main", "workspace"]) {
      expect(parseControlUiSessionPath(`/chat/research/${key}`, "", "workspace")).toMatchObject({
        kind: "literal",
        sessionKey: `agent:research:${key}`,
      });
    }
  });

  it.each([
    ["%C5%BF", "main"],
    ["%E2%84%AAelvin", "kelvin"],
  ])("normalizes URL agent %s", (encodedAgentId, agentId) => {
    expect(parseControlUiSessionPath(`/chat/${encodedAgentId}`)).toMatchObject({ agentId });
  });

  it.each([
    "/chat/%",
    "/chat/main/%",
    "/chat/main/~key",
    "/chat/main/telegram//12345",
    "/other/main",
  ])("rejects malformed or unrelated path %s", (pathname) => {
    expect(parseControlUiSessionPath(pathname)).toBeNull();
  });

  it.each([
    ["agent:main:standup", "/chat/main/standup", "standup"],
    ["agent:main:sessions", "/chat/main/~key/sessions", undefined],
    ["agent:main:12345678", "/chat/main/~key/12345678", undefined],
    [
      "agent:main:12345678-90ab-cdef-1234-567890abcdef",
      "/chat/main/~key/12345678-90ab-cdef-1234-567890abcdef",
      undefined,
    ],
    [
      "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
      "/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef",
      undefined,
    ],
  ] as const)("round-trips exact key %s", (sessionKey, expectedPath, slugCandidate) => {
    const path = buildControlUiSessionPath({ namespace: "chat", sessionKey, exactKey: true });

    expect(path).toBe(expectedPath);
    expect(parseControlUiSessionPath(path ?? "")).toEqual({
      namespace: "chat",
      kind: "literal",
      agentId: "main",
      sessionKey,
      slugCandidate,
    });
  });

  it("parses a tool-composed forced literal with multiple segments", () => {
    expect(
      parseControlUiSessionPath(
        "/control/chat/roboclaw/~key/dashboard/2139bddb-3211-4641-b993-10f619f124e6",
        "/control",
      ),
    ).toEqual({
      namespace: "chat",
      kind: "literal",
      agentId: "roboclaw",
      sessionKey: "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6",
    });
  });
});

describe("matchControlUiCatalogSharePath", () => {
  it.each([
    ["/beam/0123456789ab", undefined, "0123456789ab"],
    [
      "/openclaw/beam/fix-upload-flow-0123456789abcdef0123456789abcdef",
      "/openclaw",
      "0123456789abcdef0123456789abcdef",
    ],
  ] as const)("parses %s", (pathname, basePath, shortId) => {
    expect(matchControlUiCatalogSharePath({ pathname, basePath })).toEqual({
      routeSegment: "beam",
      shortId,
    });
  });

  it("parses the route owner before descriptor validation", () => {
    expect(matchControlUiCatalogSharePath({ pathname: "/beam/nothexvaluezz" })).toEqual({
      routeSegment: "beam",
      shortId: "nothexvaluezz",
    });
  });

  it.each(["/chat/0123456789ab", "/ui/chat", "/beam/0123456789a", "/beam/0123456789ab/extra"])(
    "rejects ordinary, resource, and implausible share paths for %s",
    (pathname) => {
      expect(matchControlUiCatalogSharePath({ pathname })).toBeNull();
    },
  );

  it("ignores paths outside the configured base", () => {
    expect(
      matchControlUiCatalogSharePath({
        pathname: "/wrong/openclaw/beam/0123456789ab",
        basePath: "/openclaw",
      }),
    ).toBeNull();
  });
});
