import "./side-question.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
  createFakeClient,
  getSharedCodexAppServerClientMock,
  readCodexAppServerBindingMock,
  runCodexAppServerSideQuestion,
  sideParams,
  useSideQuestionTestSetup,
} = await import("./side-question.test-support.js");

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

describe("Codex side-question app consent", () => {
  useSideQuestionTestSetup();

  it.each([
    {
      name: "yolo mode",
      appServer: { mode: "yolo" as const },
      expectedApprovalPolicy: {
        granular: {
          mcp_elicitations: true,
          rules: false,
          sandbox_approval: false,
          request_permissions: false,
          skill_approval: false,
        },
      },
    },
    {
      name: "on-request policy",
      appServer: { approvalPolicy: "on-request" as const },
      expectedApprovalPolicy: "on-request",
    },
  ])("preserves native app consent with $name when apps are bound", async (testCase) => {
    const client = createFakeClient();
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      return baseRequest(method, params);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockReturnValue({
      ...readCodexAppServerBindingMock(),
      pluginAppPolicyContext: {
        fingerprint: "native-app-consent",
        apps: {
          calendar: {
            source: "account",
            appName: "Calendar",
            allowDestructiveActions: true,
            destructiveApprovalMode: "auto",
            mcpServerNames: [],
          },
        },
        pluginAppIds: {},
      },
    });

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { appServer: testCase.appServer },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const fork = client.request.mock.calls.find(([method]) => method === "thread/fork")?.[1];
    expect(fork).toMatchObject({
      approvalPolicy: testCase.expectedApprovalPolicy,
    });
  });
});
