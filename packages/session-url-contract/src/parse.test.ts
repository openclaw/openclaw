import { describe, expect, it } from "vitest";
import { buildControlUiSessionPath } from "./index.js";
import {
  matchControlUiCatalogSharePath,
  parseControlUiSessionPath,
  type ControlUiSessionPathTarget,
} from "./parse.js";

type ParseCase = readonly [string, ControlUiSessionPathTarget, string?];
const UUID = "12345678-90ab-cdef-1234-567890abcdef";
const SHARE_ID = "0123456789abcdef0123456789abcdef";
const SLUG = "not-a-short-id";
const literal = (sessionKey: string, agentId = "main") =>
  ({ namespace: "chat", kind: "literal", agentId, sessionKey }) as const;

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
    [`/chat/main/${SLUG}`, { ...literal(`agent:main:${SLUG}`), slugCandidate: SLUG }],
  ] satisfies readonly ParseCase[])("parses %s", (pathname, expected, basePath = "") => {
    expect(parseControlUiSessionPath(pathname, basePath)).toEqual(expected);
  });

  it.each([
    ["/chat/main/~key/release-deadbeef", "agent:main:release-deadbeef"],
    ["/chat/main/cron/~dot/~dotdot/run", "agent:main:cron:.:..:run"],
    ["/chat/main/channel/~~dot", "agent:main:channel:~dot"],
  ])("decodes literal path %s", (pathname, sessionKey) => {
    expect(parseControlUiSessionPath(pathname)).toEqual(literal(sessionKey));
  });

  it("keeps reserved boot literal", () => {
    expect(parseControlUiSessionPath("/chat/main/boot")).toEqual(literal("agent:main:boot"));
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

  it.each([
    ["agent:main:standup", "/chat/main/standup", "standup"],
    ["agent:main:sessions", "/chat/main/~key/sessions", undefined],
    ["agent:main:12345678", "/chat/main/~key/12345678", undefined],
    [`agent:main:${UUID}`, `/chat/main/~key/${UUID}`, undefined],
    [`agent:main:dashboard:${UUID}`, `/chat/main/dashboard/${UUID}`, undefined],
  ] as const)("round-trips exact key %s", (sessionKey, expectedPath, slugCandidate) => {
    const path = buildControlUiSessionPath({ namespace: "chat", sessionKey, exactKey: true });
    const expected = { ...literal(sessionKey), slugCandidate };

    expect(path).toBe(expectedPath);
    expect(parseControlUiSessionPath(path ?? "")).toEqual(expected);
  });

  it("parses a tool-composed forced literal with multiple segments", () => {
    expect(
      parseControlUiSessionPath(`/control/chat/roboclaw/~key/dashboard/${UUID}`, "/control"),
    ).toEqual(literal(`agent:roboclaw:dashboard:${UUID}`, "roboclaw"));
  });
});

describe("matchControlUiCatalogSharePath", () => {
  it.each([
    ["/beam/0123456789ab", undefined, "0123456789ab"],
    [`/openclaw/beam/fix-upload-flow-${SHARE_ID}`, "/openclaw", SHARE_ID],
  ] as const)("parses %s", (pathname, basePath, shortId) => {
    const expected = { routeSegment: "beam", shortId };
    expect(matchControlUiCatalogSharePath({ pathname, basePath })).toEqual(expected);
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
