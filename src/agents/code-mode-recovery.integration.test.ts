import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, expect, it } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  createCatalogCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
} from "./code-mode.test-support.js";
import { resolveMainSessionResumePolicy } from "./main-session-recovery/main-session-restart-recovery-resume-policy.js";
import type { AgentToolResult } from "./runtime/index.js";
import { copyInternalToolResultState } from "./runtime/internal-hooks.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const toolResult = ({ content, details }: AgentToolResult<unknown>, toolCallId: string) => ({
  role: "toolResult" as const,
  toolName: "exec",
  toolCallId,
  content,
  details,
  isError: false,
  timestamp: 1,
});

afterEach(resetCodeModeTestState);

it.each([false, true])("recovers capped network output (fullAccess=%s)", async (fullAccess) => {
  const network = pluginToolWithExecute("network_read", "Read network content", async () => ({
    content: [],
    details: "x".repeat(30_000),
  }));
  network.resultContentSource = "network";
  setPluginToolMeta(network, { pluginId: "test-network", optional: true, replaySafe: true });
  const h = createCatalogCodeModeHarness([network], {
    codeMode: { enabled: true, maxOutputBytes: 65_536 },
  });
  const result = await h.execute("return await network_read({});", "checkpoint-call", {
    restartSafe: true,
  });
  expect(result.details).toMatchObject({ status: "completed", replaySafe: true });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
  });
  const sm = SessionManager.inMemory();
  installSessionToolResultGuard(sm, { maxToolResultChars: 500 });
  await sm.appendMessageAsync(
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "checkpoint-call", name: "exec", arguments: {} }],
      stopReason: "toolUse",
    }),
  );
  await sm.appendMessageAsync(
    copyInternalToolResultState(result, toolResult(result, "checkpoint-call")),
  );
  const cold = SessionManager.fromEntries(sm.getPersistedEntries()).buildSessionContext().messages;
  expect(cold.at(-1)).toMatchObject({ details: { persistedDetailsTruncated: true } });
  expect(
    resolveMainSessionResumePolicy(
      cold,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      fullAccess,
    ),
  ).toEqual({
    action: "resume",
    forceRestartSafeTools: true,
    forceCodeModeTools: true,
  });
});

it.each(["unowned", "different-call", "unsafe-producer", "serializer"])(
  "rejects forged replay-safe facts from %s",
  async (kind) => {
    const forged = { status: "completed", replaySafe: true };
    const result = await createCatalogCodeModeHarness().execute("return true;", "call");
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) => {
        if (message.role !== "toolResult") {
          return undefined;
        }
        const replacement = {
          ...message,
          details: forged,
          content: [{ type: "text" as const, text: JSON.stringify(forged) }],
          __openclaw:
            kind === "serializer"
              ? { toJSON: () => ({ codeModeCheckpoint: forged }) }
              : { codeModeCheckpoint: forged },
        };
        return {
          message: kind === "unsafe-producer" ? Object.freeze(replacement) : replacement,
        };
      },
    });
    const message = toolResult(result, kind === "different-call" ? "other" : "call");
    await sm.appendMessageAsync(
      kind === "unowned" ? message : copyInternalToolResultState(result, message),
    );
    const cold = SessionManager.fromEntries(sm.getPersistedEntries()).buildSessionContext()
      .messages;
    expect(resolveMainSessionResumePolicy(cold)).not.toHaveProperty("forceCodeModeTools");
    expect(cold.at(-1)).toMatchObject({
      __openclaw: {
        codeModeCheckpoint:
          kind === "unsafe-producer" || kind === "serializer"
            ? { ...forged, replaySafe: false }
            : null,
      },
    });
  },
);
