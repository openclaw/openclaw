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
    ["/chat/main/~key/release-deadbeef", "agent:main:release-deadbeef", true],
    ["/chat/main/cron/~dot/~dotdot/run", "agent:main:cron:.:..:run", false],
    ["/chat/main/channel/~~dot", "agent:main:channel:~dot", false],
  ])("decodes literal path %s", (pathname, sessionKey, literalKey) => {
    expect(parseControlUiSessionPath(pathname)).toEqual({
      namespace: "chat",
      kind: "literal",
      agentId: "main",
      sessionKey,
      ...(literalKey ? { literalKey } : {}),
    });
  });

  it.each([
    ["agent:research:workspace", "~key/workspace"],
    [
      "agent:research:dashboard:12345678-90ab-cdef-1234-567890abcdef",
      "~key/dashboard/12345678-90ab-cdef-1234-567890abcdef",
    ],
    ["agent:research:channel:~dot:.:..", "~key/channel/~~dot/~dot/~dotdot"],
    ["global", "~global"],
  ])("keeps explicit %s identity independent of current home defaults", (sessionKey, suffix) => {
    for (const mainKey of ["workspace", "project"]) {
      const pathname = buildControlUiSessionPath({
        namespace: "dashboard",
        sessionKey,
        fallbackAgentId: "research",
        basePath: "/control",
        mainKey,
        literalKey: true,
      });
      expect(pathname).toBe(`/control/dashboard/research/${suffix}`);
      expect(parseControlUiSessionPath(pathname!, "/control", mainKey)).toEqual({
        namespace: "dashboard",
        kind: "literal",
        agentId: "research",
        sessionKey,
        literalKey: true,
      });
    }
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
    "/chat/%",
    "/chat/main/%",
    "/chat/main/~key",
    "/chat/main/telegram//12345",
    "/other/main",
  ])("rejects malformed or unrelated path %s", (pathname) => {
    expect(parseControlUiSessionPath(pathname)).toBeNull();
  });

  it.each(["main", "workspace", "global", "deadbeef"])(
    "keeps source keys exact when the receiver does not know mainKey=%s",
    (mainKey) => {
      for (const rest of ["main", mainKey]) {
        const sessionKey = `agent:research:${rest}`;
        const path = buildControlUiSessionPath({
          namespace: "chat",
          sessionKey,
          exactKey: true,
          literalMainKey: true,
          basePath: "/control",
        });
        expect(parseControlUiSessionPath(path ?? "", "/control", mainKey)).toMatchObject({
          namespace: "chat",
          kind: "literal",
          agentId: "research",
          sessionKey,
        });
      }
    },
  );

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
      ...(expectedPath.includes("/~key/") ? { literalKey: true } : {}),
      slugCandidate,
    });
  });

  it.each(["chat", "dashboard"] as const)(
    "keeps raw global, agent global, and an escaped marker distinct in %s",
    (namespace) => {
      for (const [sessionKey, suffix] of [
        ["global", "~global"],
        ["agent:research:global", "~key/global"],
        ["agent:research:~global", "~~global"],
      ]) {
        const pathname = buildControlUiSessionPath({
          namespace,
          sessionKey: sessionKey!,
          fallbackAgentId: "research",
          basePath: "/control",
          exactKey: true,
          literalMainKey: true,
          literalGlobalKey: true,
        });
        expect(pathname).toBe(`/control/${namespace}/research/${suffix}`);
        expect(parseControlUiSessionPath(pathname!, "/control")).toMatchObject({
          namespace,
          kind: "literal",
          agentId: "research",
          sessionKey,
        });
      }
      expect(
        buildControlUiSessionPath({
          namespace,
          sessionKey: "global",
          fallbackAgentId: "research",
          exactKey: true,
          literalMainKey: true,
        }),
      ).toBe(`/${namespace}/research`);
    },
  );

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
      literalKey: true,
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
