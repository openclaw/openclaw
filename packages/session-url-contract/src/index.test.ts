import { describe, expect, it } from "vitest";
import { buildControlUiCatalogSessionUrl, buildControlUiSessionPath } from "./index.js";
import { buildControlUiCatalogSharePath } from "./share-build.js";

const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "beam",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const;

type ChatParams = Omit<Parameters<typeof buildControlUiSessionPath>[0], "namespace">;

const UUID_KEY = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const buildChatPath = (params: ChatParams) =>
  buildControlUiSessionPath({ namespace: "chat", ...params });
const THREAD_ID = "0123456789abcdef0123456789abcdef";
const buildSharePath = (
  params: Omit<Parameters<typeof buildControlUiCatalogSharePath>[0], "shareRoute" | "threadId">,
) => buildControlUiCatalogSharePath({ shareRoute: SHARE_ROUTE, threadId: THREAD_ID, ...params });

describe("buildControlUiCatalogSessionUrl", () => {
  it("encodes reserved query characters", () => {
    expect(
      buildControlUiCatalogSessionUrl({
        namespace: "dashboard",
        agentId: "research",
        basePath: "/admin/openclaw/",
        catalog: "claude & codex",
        host: "gateway:local/primary",
        thread: "thread?one=1&two=2",
      }),
    ).toBe(
      "/admin/openclaw/dashboard/research?catalog=claude+%26+codex&host=gateway%3Alocal%2Fprimary&thread=thread%3Fone%3D1%26two%3D2",
    );
  });

  it.each(["agentId", "catalog", "host", "thread"] as const)(
    "returns null when required $field is empty",
    (field) => {
      expect(
        buildControlUiCatalogSessionUrl({
          namespace: "chat",
          agentId: "main",
          catalog: "beam",
          host: "gateway",
          thread: "beam-1",
          [field]: " ",
        }),
      ).toBeNull();
    },
  );
});

describe("buildControlUiCatalogSharePath", () => {
  it("builds a lowercase 12-character share id under a nested base path", () => {
    expect(buildSharePath({ basePath: "/admin/openclaw/", displayName: "x".repeat(60) })).toBe(
      `/admin/openclaw/beam/${"x".repeat(48)}-0123456789ab`,
    );
  });

  it.each([
    ["chat", THREAD_ID],
    ["Beam", THREAD_ID],
    ["beam/extra", THREAD_ID],
    ["beam", "0123456789ab"],
    ["beam", "0123456789ABCDEF0123456789ABCDEF"],
  ])("rejects invalid catalog share input %#", (routeSegment, threadId) => {
    expect(
      buildControlUiCatalogSharePath({ shareRoute: { ...SHARE_ROUTE, routeSegment }, threadId }),
    ).toBeNull();
  });
});

describe("buildControlUiSessionPath", () => {
  it.each([
    [
      "case-sensitive literal",
      { sessionKey: "Agent:Ops:Matrix:Channel:!Room:Org:Thread:$Event", exactKey: true },
      "/chat/ops/Matrix/Channel/!Room/Org/Thread/%24Event",
    ],
    [
      "opaque catalog",
      { sessionKey: "agent:ops:catalog:fixture:Host:Thread" },
      "/chat/ops/catalog/fixture/Host/Thread",
    ],
    ["scoped main", { sessionKey: "agent:main:main" }, "/chat/main"],
    ["unscoped main", { sessionKey: "main", fallbackAgentId: "research" }, "/chat/research"],
    [
      "configured main",
      { sessionKey: "agent:research:workspace", mainKey: "workspace" },
      "/chat/research",
    ],
    [
      "default main under a configured key",
      { sessionKey: "agent:research:main", mainKey: "workspace" },
      "/chat/research/main",
    ],
    [
      "global under a configured main key",
      { sessionKey: "global", fallbackAgentId: "ops", mainKey: "workspace", exactKey: true },
      "/chat/ops",
    ],
    [
      "qualified global with a conflicting fallback agent",
      { sessionKey: "agent:research:global", fallbackAgentId: "main" },
      "/chat/research/~key/global",
    ],
    [
      "qualified global under a configured main key",
      { sessionKey: "agent:research:global", mainKey: "workspace" },
      "/chat/research/~key/global",
    ],
    [
      "qualified global casing",
      { sessionKey: "AGENT:RESEARCH:GlObAl" },
      "/chat/research/~key/GlObAl",
    ],
    [
      "global as the configured main key",
      { sessionKey: "agent:research:global", mainKey: "global", exactKey: true },
      "/chat/research",
    ],
    [
      "global as a literal rest prefix",
      { sessionKey: "agent:research:global:notes" },
      "/chat/research/global/notes",
    ],
    [
      "literal segments",
      { sessionKey: "telegram:group:12345", fallbackAgentId: "research" },
      "/chat/research/telegram/group/12345",
    ],
    [
      "dotted segment",
      { sessionKey: "channel:release.js", fallbackAgentId: "research" },
      "/chat/research/channel/release%2Ejs",
    ],
    ["dot escapes", { sessionKey: "agent:main:cron:.:..:run" }, "/chat/main/cron/~dot/~dotdot/run"],
    ["tilde escape", { sessionKey: "agent:main:channel:~dot" }, "/chat/main/channel/~~dot"],
    ["marker escape", { sessionKey: "agent:main:~key" }, "/chat/main/~~key"],
    ["short-id literal", { sessionKey: "agent:main:12345678" }, "/chat/main/~key/12345678"],
    [
      "slug-shaped literal",
      { sessionKey: "agent:main:release-deadbeef" },
      "/chat/main/~key/release-deadbeef",
    ],
    ["UUID", { sessionKey: UUID_KEY }, "/chat/main/12345678"],
    ...(["dashboard", "subagent", "internal-session-effects"] as const).map(
      (surface): [string, ChatParams, string] => [
        `Incognito ${surface}`,
        {
          sessionKey: `agent:main:${surface}:incognito-12345678-90ab-cdef-1234-567890abcdef`,
          displayName: "Private task",
        },
        `/chat/main/${surface}/incognito-12345678-90ab-cdef-1234-567890abcdef`,
      ],
    ),
    [
      "reserved short ref",
      {
        sessionKey: "agent:main:dashboard:deadbeef-0aaa-4000-8000-000000000001",
        mainKey: "deadbeef",
      },
      "/chat/main/deadbeef0",
    ],
  ] satisfies readonly (readonly [string, ChatParams, string])[])(
    "builds $0",
    (_name, params, expected) => {
      expect(buildChatPath(params)).toBe(expected);
    },
  );

  it("preserves base paths and namespaces for qualified global keys", () => {
    expect(
      buildControlUiSessionPath({
        namespace: "dashboard",
        sessionKey: "agent:research:global",
        basePath: " /control/// ",
      }),
    ).toBe("/control/dashboard/research/~key/global");
  });

  it.each([
    { sessionKey: "", fallbackAgentId: "main" },
    { sessionKey: "telegram:12345" },
    { sessionKey: "agent:main" },
    { sessionKey: "agent::control-link" },
    { sessionKey: "agent:main:" },
    { sessionKey: "agent:main:telegram::12345" },
    { sessionKey: "agent:ops::main" },
  ] satisfies readonly ChatParams[])("rejects invalid input %#", (params) => {
    expect(buildChatPath(params)).toBeNull();
  });

  it("removes trailing hex tokens from UUID display slugs", () => {
    expect(buildChatPath({ sessionKey: UUID_KEY, displayName: "Deploy face deadbeef" })).toBe(
      "/chat/main/deploy-12345678",
    );
  });
});
