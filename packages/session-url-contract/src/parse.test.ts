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
const short = (agentId: string, shortId: string, literalRest: string, slugHint?: string) =>
  ({
    kind: "short",
    agentId,
    shortId,
    literalSessionKey: `agent:${agentId}:${literalRest}`,
    ...(slugHint ? { slugHint } : {}),
  }) as const;

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
      { namespace: "dashboard", ...short("main", "12345678", "12345678") },
    ],
    [
      "/chat/wrong/wrong-slug-1234567890AB",
      {
        namespace: "chat",
        ...short("wrong", "1234567890ab", "wrong-slug-1234567890AB", "wrong-slug"),
      },
    ],
    [`/chat/main/${SLUG}`, { ...literal(`agent:main:${SLUG}`), slugCandidate: SLUG }],
    ["/chat/main/~key/release-deadbeef", literal("agent:main:release-deadbeef")],
    ["/chat/main/cron/~dot/~dotdot/run", literal("agent:main:cron:.:..:run")],
    ["/chat/main/channel/~~dot", literal("agent:main:channel:~dot")],
    ["/chat/main/boot", literal("agent:main:boot")],
    [
      `/control/chat/roboclaw/~key/dashboard/${UUID}`,
      literal(`agent:roboclaw:dashboard:${UUID}`, "roboclaw"),
      "/control",
    ],
  ] satisfies readonly ParseCase[])("parses %s", (pathname, expected, basePath = "") => {
    expect(parseControlUiSessionPath(pathname, basePath)).toEqual(expected);
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
