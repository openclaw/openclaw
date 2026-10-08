import path from "node:path";
import type { ControlUiMockGatewayScenario } from "../ui/src/test-helpers/control-ui-e2e.js";
import { createControlUiChatHistoryMessage } from "../ui/src/test-helpers/control-ui-session-fixtures.js";

/** Presentation fixture: loads the real native GitHub browser module, never calls GitHub. */
export function applyGitHubMergeDemo(scenario: ControlUiMockGatewayScenario): void {
  const now = Date.now();
  const messages = [
    createControlUiChatHistoryMessage(
      "user",
      "Merge the async API change once the checks are green.",
      now - 90_000,
    ),
    createControlUiChatHistoryMessage(
      "assistant",
      "The checks passed. I've requested the merge and will confirm when it's complete.",
      now - 80_000,
    ),
  ];
  scenario.nativePlugins = [
    {
      pluginId: "github",
      rootDir: path.resolve(import.meta.dirname, ".."),
      source: "scripts/control-ui-mock-github-merge.browser.ts",
    },
  ];
  scenario.sessionKey = "agent:main:main";
  scenario.historyMessages = messages;
  scenario.sessionTranscripts = {
    ...scenario.sessionTranscripts,
    "agent:main:main": { messages, inFlightRun: null },
  };
  scenario.inFlightRun = null;
  scenario.repeatingSessionEvents = { events: [] };
  scenario.sessions = scenario.sessions?.map((session) =>
    session.key === "agent:main:main"
      ? {
          ...session,
          label: "GitHub async merge demo",
          displayName: "GitHub async merge demo",
          hasActiveRun: false,
          status: "done",
        }
      : session,
  );
}
