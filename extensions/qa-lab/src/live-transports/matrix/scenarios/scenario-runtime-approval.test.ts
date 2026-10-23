import { afterEach, expect, it, vi } from "vitest";
import {
  runApprovalDenyReactionScenario,
  runApprovalExecMetadataSingleEventScenario,
  runApprovalPluginMetadataSingleEventScenario,
} from "./scenario-runtime-approval.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import { matrixSyncResponse } from "./scenario-runtime.test-support.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  {
    kind: "exec",
    decision: "allow-once",
    emoji: "✅",
    run: runApprovalExecMetadataSingleEventScenario,
  },
  { kind: "exec", decision: "deny", emoji: "❌", run: runApprovalDenyReactionScenario },
  {
    kind: "plugin",
    decision: "allow-once",
    emoji: "✅",
    run: runApprovalPluginMetadataSingleEventScenario,
  },
])(
  "observes the $kind $decision option and sender echo before accepting the decision",
  async ({ kind, decision, emoji, run }) => {
    const phases: string[] = [];
    let approvalId = "plugin-approval";
    let syncCount = 0;
    const context = createMatrixQaE2eeTestContext({
      gatewayCall: async (method, params, options) => {
        if (method === `${kind}.approval.request`) {
          phases.push("request");
          approvalId = kind === "exec" ? String(params?.id) : approvalId;
          expect(params).toMatchObject({
            timeoutMs: 30_000,
            twoPhase: true,
            turnSourceChannel: "matrix",
            turnSourceTo: "room:!room:matrix-qa.test",
          });
          expect(options).toEqual({ expectFinal: false, timeoutMs: 35_000 });
          return { id: approvalId, status: "accepted" };
        }
        expect(method).toBe(`${kind}.approval.waitDecision`);
        expect(params).toEqual({ id: approvalId });
        expect(options).toEqual({ expectFinal: true, timeoutMs: 35_000 });
        expect(phases).toEqual(["prime", "request", "approval", "option", "send", "echo"]);
        phases.push("decision");
        return { id: approvalId, decision };
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.pathname.includes("/send/m.reaction/")) {
          expect(phases.at(-1)).toBe("option");
          expect(init?.method).toBe("PUT");
          const body = init?.body;
          if (typeof body !== "string") {
            throw new Error("Matrix reaction must send JSON text");
          }
          expect(JSON.parse(body)).toEqual({
            "m.relates_to": { rel_type: "m.annotation", event_id: "$approval", key: emoji },
          });
          phases.push("send");
          return Response.json({ event_id: "$reaction" });
        }
        expect(url.pathname).toBe("/_matrix/client/v3/sync");
        syncCount += 1;
        if (syncCount === 1) {
          phases.push("prime");
          return matrixSyncResponse(context.roomId, [], "start");
        }
        if (syncCount === 2) {
          phases.push("approval");
          return matrixSyncResponse(
            context.roomId,
            [
              {
                event_id: "$approval",
                sender: context.sutUserId,
                type: "m.room.message",
                content: {
                  body: "Review this request",
                  "com.openclaw.approval": {
                    id: approvalId,
                    kind,
                    version: 1,
                    type: "approval.request",
                    state: "pending",
                    allowedDecisions: ["allow-once", "deny"],
                    commandText: "printf fixture",
                    pluginId: "matrix-qa-plugin",
                    toolName: "matrix_qa_tool",
                    severity: "warning",
                    agentId: "qa",
                  },
                },
              },
            ],
            "approval",
          );
        }
        const echo = syncCount === 4;
        expect(syncCount).toBeLessThanOrEqual(4);
        phases.push(echo ? "echo" : "option");
        return matrixSyncResponse(
          context.roomId,
          [
            {
              event_id: echo ? "$reaction" : "$option",
              sender: echo ? context.driverUserId : context.sutUserId,
              type: "m.reaction",
              content: {
                "m.relates_to": { rel_type: "m.annotation", event_id: "$approval", key: emoji },
              },
            },
          ],
          echo ? "echo" : "option",
        );
      }),
    );
    const result = await run(context);
    expect(phases.at(-1)).toBe("decision");
    expect(result.details).toBe(
      (kind === "plugin"
        ? [
            "approval event: $approval",
            `approval id: ${approvalId}`,
            "plugin id: matrix-qa-plugin",
            "tool name: matrix_qa_tool",
            "decision: allow-once",
          ]
        : [
            "approval event: $approval",
            `approval id: ${approvalId}`,
            "approval kind: exec",
            `decision: ${decision}`,
            "reaction event: $reaction",
            "reaction target: $approval",
          ]
      ).join("\n"),
    );
  },
);
