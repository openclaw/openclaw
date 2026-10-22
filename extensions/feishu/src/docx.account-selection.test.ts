import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { registerFeishuDocTools } from "./docx.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.fn((creds: { appId?: string } | undefined) => ({
  __appId: creds?.appId,
}));

// mock-isolation: Account selection inspects client identity without creating an SDK transport.
vi.mock("./client.js", () => ({
  createFeishuClient: (creds: { appId?: string } | undefined) => createFeishuClientMock(creds),
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({ default: {} }));

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("@larksuiteoapi/node-sdk");
  vi.resetModules();
});

beforeEach(() => vi.clearAllMocks());

function setup(disabled = false) {
  const account = (id: string, doc: boolean) => ({
    appId: `app-${id}`,
    appSecret: `sec-${id}`, // pragma: allowlist secret
    tools: { doc },
  });
  const { api, resolveTool } = createToolFactoryHarness({
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          a: account("a", !disabled),
          b: account("b", true),
        },
      },
    },
  });
  registerFeishuDocTools(api);
  return (agentAccountId: string) => resolveTool("feishu_doc", { agentAccountId });
}

const list = { action: "list_blocks", doc_token: "d" };
test("uses each agentAccountId context when params omit accountId", async () => {
  const resolve = setup();
  const a = resolve("a");
  const b = resolve("b");
  await a.execute("a", list);
  await b.execute("b", list);
  expect(createFeishuClientMock.mock.calls.map(([account]) => account?.appId)).toEqual([
    "app-a",
    "app-b",
  ]);
});
test("explicit accountId overrides agentAccountId context", async () => {
  await setup()("b").execute("override", { ...list, accountId: "a" });
  expect(createFeishuClientMock.mock.lastCall?.[0]?.appId).toBe("app-a");
});

test.each([
  { source: "context", agentAccountId: "a", params: {} },
  { source: "override", agentAccountId: "b", params: { accountId: "a" } },
])(
  "rejects a disabled $source account when another account enables docs",
  async ({ agentAccountId, params }) => {
    const result = await setup(true)(agentAccountId).execute("call-disabled", {
      ...list,
      ...params,
    });

    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu Doc tools are disabled for account "a"');
  },
);
