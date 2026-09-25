import { expectDefined } from "@openclaw/normalization-core/expect";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { expect, it } from "vitest";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { readUserTurnDelegatedInputPolicy } from "../sessions/user-turn-transcript.metadata.js";
import {
  prepareSystemAgentRunAdmission,
  retainAdmittedRunDelegatedInputPolicies,
} from "./admitted-run-context.js";
import type { InheritedToolPolicyV2 } from "./inherited-tool-policy.schema.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

export function registerInputPolicyTranscriptCheckpointTest(
  openPersistedSessionManager: () => Promise<{ sessionManager: SessionManager }>,
) {
  it("commits input requirements after hooks once per changed generation", async () => {
    const { sessionManager: manager } = await openPersistedSessionManager();
    const admission = prepareSystemAgentRunAdmission({}, "policy-fragment", "main", "test");
    const policy: InheritedToolPolicyV2 = {
      clauses: [{ kind: "configured", allow: ["read"] }],
      parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] },
    };
    try {
      const context = await admission.admit("embedded");
      retainAdmittedRunDelegatedInputPolicies(context, [policy]);
      let block = false;
      let rewriteRunIdDuringSerialization = false;
      installSessionToolResultGuard(manager, {
        runId: "policy-fragment",
        admittedRunContext: context,
        beforeMessageWriteHook: ({ message }) =>
          block
            ? { block: true }
            : {
                message: Object.assign(
                  { ...message, __openclaw: { delegatedInputPolicyVersion: 99 } },
                  rewriteRunIdDuringSerialization
                    ? {
                        toJSON(this: Record<string, unknown>) {
                          return {
                            ...this,
                            __openclaw: {
                              ...asNullableRecord(this["__openclaw"]),
                              runId: "other-run",
                            },
                          };
                        },
                      }
                    : {},
                ),
              },
      });
      const fragment = makeAgentAssistantMessage({
        content: [
          { type: "toolCall", id: "read-call", name: "read", arguments: { path: "README.md" } },
        ],
        stopReason: "toolUse",
      });
      const firstId = await manager.appendMessageAsync(fragment);
      const first = manager.getEntry(expectDefined(firstId, "Expected persisted transcript entry"));
      expect(first?.type).toBe("message");
      if (first?.type !== "message") {
        throw new Error("Missing committed fragment");
      }
      expect(readUserTurnDelegatedInputPolicy(first.message)).toEqual(policy);
      const secondId = await manager.appendMessageAsync(
        makeTextToolResult("read-call", "read", "contents", false, 1),
      );
      const second = manager.getEntry(
        expectDefined(secondId, "Expected persisted transcript entry"),
      );
      expect(second?.type).toBe("message");
      if (second?.type !== "message") {
        throw new Error("Missing committed result");
      }
      expect(readUserTurnDelegatedInputPolicy(second.message)).toBeUndefined();
      retainAdmittedRunDelegatedInputPolicies(context, [
        { ...policy, clauses: [{ kind: "configured", deny: ["write"] }] },
      ]);
      block = true;
      await expect(manager.appendMessageAsync(fragment)).rejects.toThrow("must persist before");
      block = false;
      rewriteRunIdDuringSerialization = true;
      const rewrittenId = await manager.appendMessageAsync(fragment);
      const rewritten = manager.getEntry(
        expectDefined(rewrittenId, "Expected persisted transcript entry"),
      );
      expect(rewritten?.type).toBe("message");
      if (rewritten?.type !== "message") {
        throw new Error("Missing committed repaired fragment");
      }
      expect(asNullableRecord(asNullableRecord(rewritten.message)?.["__openclaw"])?.runId).toBe(
        "policy-fragment",
      );
    } finally {
      admission.close();
    }
  });
}
