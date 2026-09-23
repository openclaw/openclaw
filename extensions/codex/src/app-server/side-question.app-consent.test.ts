import "./side-question.test-support.js";
import { describe, expect, it } from "vitest";

const {
  createFakeClient,
  getSharedCodexAppServerClientMock,
  readCodexAppServerBindingMock,
  runCodexAppServerSideQuestion,
  sideParams,
  useSideQuestionTestSetup,
} = await import("./side-question.test-support.js");

describe("Codex side-question app consent", () => {
  useSideQuestionTestSetup();

  it.each([true, false])(
    "preserves native app consent in yolo mode when apps are bound: %s",
    async (hasBoundApp) => {
      const client = createFakeClient();
      const baseRequest = client.request.getMockImplementation()!;
      client.request.mockImplementation(async (method, params) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        return baseRequest(method, params);
      });
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      if (hasBoundApp) {
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
      }

      await expect(
        runCodexAppServerSideQuestion(sideParams(), {
          pluginConfig: { appServer: { mode: "yolo" } },
        }),
      ).resolves.toEqual({ text: "Side answer." });

      const fork = client.request.mock.calls.find(([method]) => method === "thread/fork")?.[1];
      expect(fork).toMatchObject({
        approvalPolicy: hasBoundApp
          ? {
              granular: {
                mcp_elicitations: true,
                rules: false,
                sandbox_approval: false,
                request_permissions: false,
                skill_approval: false,
              },
            }
          : "never",
      });
    },
  );
});
