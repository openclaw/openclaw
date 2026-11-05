import type { PendingApprovalSnapshot, QuestionRecord } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import {
  waitForControlUiRoute,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { baseScenario } from "../control-ui-parity/scenarios.ts";

type DocumentScene = {
  id: string;
  label: string;
  scenario: ControlUiMockGatewayScenario;
  visit: (page: Page, gateway: MockGatewayControls, baseUrl: string) => Promise<void>;
};

const approvalId = "retention-approval";
const questionId = "retention-question";
const remoteGatewayUrl = "wss://retention-gateway.example/mobile";

function pendingApproval(): PendingApprovalSnapshot {
  const now = Date.now();
  return {
    id: approvalId,
    status: "pending",
    urlPath: `/approve/${approvalId}`,
    createdAtMs: now - 30_000,
    expiresAtMs: now + 15 * 60_000,
    presentation: {
      kind: "exec",
      commandText: "pnpm test",
      host: "gateway",
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}

function pendingQuestion(): QuestionRecord {
  const now = Date.now();
  return {
    id: questionId,
    agentId: "main",
    sessionKey: baseScenario.sessionKey,
    createdAtMs: now - 30_000,
    expiresAtMs: now + 15 * 60_000,
    status: "pending",
    questions: [
      {
        questionId: "layout",
        header: "Layout",
        question: "Which layout should the preview use?",
        options: [{ label: "Comfortable" }, { label: "Compact" }],
        isOther: true,
      },
    ],
  };
}

async function returnToNewSession(page: Page, baseUrl: string) {
  await page.goto(new URL("/new", baseUrl).href);
  await waitForControlUiRoute(page, { routeId: "new-session" });
}

// These boot-only surfaces require document navigation. The caller keeps the
// browser context and CDP session alive to measure retirement across documents.
export const documentScenes: DocumentScene[] = [
  {
    id: "document-gateway-confirmation",
    label: "Gateway URL confirmation: open and keep current Gateway",
    scenario: { ...baseScenario, awaitInitialRoster: false },
    visit: async (page, _gateway, baseUrl) => {
      // A distinct path forces a document load; a hash change on /new would
      // never re-run the boot-only connection confirmation.
      const url = new URL("/chat", baseUrl);
      url.hash = new URLSearchParams({ gatewayUrl: remoteGatewayUrl }).toString();
      const response = await page.goto(url.href);
      if (!response) {
        throw new Error("Gateway confirmation requires a full document navigation");
      }
      const confirmation = page.locator("openclaw-gateway-url-confirmation");
      await confirmation.getByText(remoteGatewayUrl, { exact: true }).waitFor();
      await confirmation.getByRole("button", { name: "Keep current Gateway", exact: true }).click();
      await confirmation.locator("openclaw-modal-dialog").waitFor({ state: "detached" });
      await returnToNewSession(page, baseUrl);
    },
  },
  {
    id: "document-approval",
    label: "Standalone pending command approval",
    scenario: {
      ...baseScenario,
      awaitInitialRoster: false,
      featureMethods: [...baseScenario.featureMethods!, "approval.get", "approval.resolve"],
      methodResponses: {
        ...baseScenario.methodResponses,
        "approval.get": { approval: pendingApproval() },
      },
    },
    visit: async (page, gateway, baseUrl) => {
      // Mock response overrides persist through reload in this browser context.
      // Refresh only fixture deadlines; retain native clocks for the census.
      await gateway.setMethodResponse("approval.get", { approval: pendingApproval() });
      await page.goto(new URL(`/approve/${approvalId}`, baseUrl).href);
      const approval = page.locator("openclaw-approval-page");
      await approval.getByText("Waiting for your decision", { exact: true }).waitFor();
      await approval.getByRole("button", { name: "Allow once", exact: true }).waitFor();
      await returnToNewSession(page, baseUrl);
    },
  },
  {
    id: "document-question",
    label: "Standalone pending question",
    scenario: {
      ...baseScenario,
      featureMethods: [
        ...baseScenario.featureMethods!,
        "question.get",
        "question.list",
        "question.resolve",
      ],
      methodResponses: {
        ...baseScenario.methodResponses,
        "question.get": { question: pendingQuestion() },
        "question.list": { questions: [] },
      },
    },
    visit: async (page, gateway, baseUrl) => {
      await gateway.setMethodResponse("question.get", { question: pendingQuestion() });
      await page.goto(new URL(`/ask/${questionId}`, baseUrl).href);
      const question = page.locator("openclaw-question-page");
      await question
        .getByRole("heading", { name: "Waiting for your answer", exact: true })
        .waitFor();
      await question.locator("openclaw-chat-question-panel").waitFor();
      await returnToNewSession(page, baseUrl);
    },
  },
];
