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
type ChatCase = readonly [string, string, Omit<ChatParams, "sessionKey">?];

const UUID = "12345678-90ab-cdef-1234-567890abcdef";
const UUID_KEY = `agent:main:dashboard:${UUID}`;
const buildChatPath = (params: ChatParams) =>
  buildControlUiSessionPath({ namespace: "chat", ...params });
const THREAD_ID = "0123456789abcdef0123456789abcdef";
const catalogSession = {
  namespace: "dashboard",
  agentId: "research",
  basePath: "/admin/openclaw/",
  catalog: "claude & codex",
  host: "gateway:local/primary",
  thread: "thread?one=1&two=2",
} as const;
const buildSharePath = (
  params: Omit<Parameters<typeof buildControlUiCatalogSharePath>[0], "shareRoute" | "threadId">,
) => buildControlUiCatalogSharePath({ shareRoute: SHARE_ROUTE, threadId: THREAD_ID, ...params });

describe("buildControlUiCatalogSessionUrl", () => {
  it("encodes reserved query characters", () => {
    expect(buildControlUiCatalogSessionUrl(catalogSession)).toBe(
      "/admin/openclaw/dashboard/research?catalog=claude+%26+codex&host=gateway%3Alocal%2Fprimary&thread=thread%3Fone%3D1%26two%3D2",
    );
  });

  it.each(["agentId", "catalog", "host", "thread"] as const)("rejects empty %s", (field) => {
    expect(buildControlUiCatalogSessionUrl({ ...catalogSession, [field]: " " })).toBeNull();
  });
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
      "Agent:Ops:Matrix:Channel:!Room:Org:Thread:$Event",
      "/chat/ops/Matrix/Channel/!Room/Org/Thread/%24Event",
      { exactKey: true },
    ],
    ["agent:ops:catalog:fixture:Host:Thread", "/chat/ops/catalog/fixture/Host/Thread"],
    ["agent:main:main", "/chat/main"],
    ["main", "/chat/research", { fallbackAgentId: "research" }],
    ["agent:research:workspace", "/chat/research", { mainKey: "workspace" }],
    ["agent:research:main", "/chat/research/main", { mainKey: "workspace" }],
    ["global", "/chat/ops", { fallbackAgentId: "ops", mainKey: "workspace", exactKey: true }],
    ["agent:research:global", "/chat/research/~key/global", { fallbackAgentId: "main" }],
    ["agent:research:global", "/chat/research/~key/global", { mainKey: "workspace" }],
    ["AGENT:RESEARCH:GlObAl", "/chat/research/~key/GlObAl"],
    ["agent:research:global", "/chat/research", { mainKey: "global", exactKey: true }],
    ["agent:research:global:notes", "/chat/research/global/notes"],
    [
      "telegram:group:12345",
      "/chat/research/telegram/group/12345",
      { fallbackAgentId: "research" },
    ],
    ["channel:release.js", "/chat/research/channel/release%2Ejs", { fallbackAgentId: "research" }],
    ["agent:main:cron:.:..:run", "/chat/main/cron/~dot/~dotdot/run"],
    ["agent:main:channel:~dot", "/chat/main/channel/~~dot"],
    ["agent:main:~key", "/chat/main/~~key"],
    ["agent:main:12345678", "/chat/main/~key/12345678"],
    ["agent:main:release-deadbeef", "/chat/main/~key/release-deadbeef"],
    [UUID_KEY, "/chat/main/12345678"],
    ...(["dashboard", "subagent", "internal-session-effects"] as const).map((surface): ChatCase => [
      `agent:main:${surface}:incognito-${UUID}`,
      `/chat/main/${surface}/incognito-${UUID}`,
      { displayName: "Private task" },
    ]),
    [
      "agent:main:dashboard:deadbeef-0aaa-4000-8000-000000000001",
      "/chat/main/deadbeef0",
      { mainKey: "deadbeef" },
    ],
  ] satisfies readonly ChatCase[])("builds %s", (sessionKey, expected, options) => {
    expect(buildChatPath({ sessionKey, ...options })).toBe(expected);
  });

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
