import { Type } from "typebox";
import { expect, it } from "vitest";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import type { AnyAgentTool } from "../tools/common.js";
import { gateBoundTool } from "./host-bound-tool.js";

it.each(["direct", "prepared"] as const)(
  "refreshes %s tool authority across benign writes and still refuses revocation",
  async (mode) => {
    let revision = 0;
    let validatedRevision = 0;
    let active = true;
    let executions = 0;
    const assertReceipt = (expected: number) => {
      if (!active) {
        throw new Error("source revoked");
      }
      if (expected !== revision) {
        throw new Error("source needs preparation");
      }
    };
    const assertScopeCurrent = () => {
      if (!active) {
        throw new Error("source revoked");
      }
    };
    const source = Object.assign(
      composeSessionSourceAssertion([
        Object.assign(() => assertReceipt(validatedRevision), {
          prepareSessionSourceScope: async () => {
            validatedRevision = revision;
            const expected = revision;
            return { assertCurrent: () => assertReceipt(expected), checks: [] };
          },
        }),
      ]),
      { assertScopeCurrent },
    );
    const execute = async () => {
      source();
      executions += 1;
      revision += 1;
      return { content: [], details: { executions } };
    };
    const tool: AnyAgentTool = {
      name: "read",
      label: "Read",
      description: "Read",
      parameters: Type.Object({}),
      execute,
    };
    if (mode === "prepared") {
      attachInternalToolExecutionPreparer(tool, async () => ({
        kind: "ready",
        args: {},
        execute,
        dispose() {},
      }));
    }
    const observed: unknown[] = [];
    const bound = gateBoundTool(tool, source, (result) => observed.push(result));
    const invoke = async () => {
      if (mode === "direct") {
        return bound.execute("call", {});
      }
      const prepare = getInternalToolExecutionPreparer(bound)!;
      const prepared = await prepare({ toolCallId: "call", args: {} });
      if (prepared.kind !== "ready") {
        throw new Error("expected deferred tool");
      }
      try {
        revision += 1;
        return await prepared.execute();
      } finally {
        prepared.dispose();
      }
    };

    revision += 1;
    await expect(invoke()).resolves.toMatchObject({ details: { executions: 1 } });
    revision += 1;
    await expect(invoke()).resolves.toMatchObject({ details: { executions: 2 } });
    active = false;
    await expect(invoke()).rejects.toThrow("source revoked");
    expect(executions).toBe(2);
    expect(observed).toHaveLength(2);
  },
);
