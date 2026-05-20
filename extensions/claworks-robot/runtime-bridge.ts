import type { ClaworksRobotConfig } from "@claworks/runtime";
import {
  createHitlGate,
  type HitlGate,
  type PlaybookRun,
  type SkillRunFn,
  type SubagentRunFn,
} from "@claworks/runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const HITL_CONTROLLER = "claworks-playbook-hitl";

export function resolveClaworksSessionKey(
  config: ClaworksRobotConfig,
  api: OpenClawPluginApi,
): string {
  const fromConfig = config.robot?.session_key?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  const agentId = api.config.agents?.list?.find((a) => a.default)?.id ?? "main";
  return `agent:${agentId}:claworks`;
}

export function createSubagentRunner(
  api: OpenClawPluginApi,
  sessionKey: string,
): SubagentRunFn | undefined {
  const subagent = api.runtime.subagent;
  if (!subagent?.run) {
    return undefined;
  }
  return async ({ prompt, model }) => {
    const { runId } = await subagent.run({
      sessionKey,
      message: prompt,
      model,
      deliver: false,
    });
    const wait = await subagent.waitForRun({ runId, timeoutMs: 180_000 });
    if (wait.status === "timeout") {
      throw new Error(`subagent timed out: ${runId}`);
    }
    if (wait.status === "error") {
      throw new Error(wait.error ?? `subagent failed: ${runId}`);
    }
    const session = await subagent.getSessionMessages({ sessionKey, limit: 20 });
    const text = extractAssistantText(session.messages);
    return { text };
  };
}

export function createSkillRunner(
  api: OpenClawPluginApi,
  sessionKey: string,
): SkillRunFn | undefined {
  const runEmbedded = api.runtime.agent?.runEmbeddedAgent;
  if (!runEmbedded) {
    return undefined;
  }
  return async ({ skillId, input }) => {
    const message =
      input && Object.keys(input).length > 0
        ? `Execute skill ${skillId} with input: ${JSON.stringify(input)}`
        : `Execute skill ${skillId}`;
    const result = await runEmbedded({
      sessionKey,
      message,
      deliver: false,
    } as Parameters<NonNullable<typeof runEmbedded>>[0]);
    return {
      status: "ok",
      skillId,
      text: result.payloads?.map((p) => ("text" in p ? p.text : "")).join("\n") ?? "",
      result,
    };
  };
}

export function createProductionHitlGate(api: OpenClawPluginApi, sessionKey: string): HitlGate {
  const inner = createHitlGate();
  const managed = api.runtime.tasks?.managedFlows;

  return {
    suspend(run: PlaybookRun, stepId: string, message: string, options: string[]) {
      const token = inner.suspend(run, stepId, message, options);
      if (!managed?.bindSession) {
        return token;
      }
      try {
        const flows = managed.bindSession({ sessionKey });
        const flow = flows.createManaged({
          controllerId: HITL_CONTROLLER,
          goal: `HITL ${run.playbookId}/${stepId}: ${message}`,
          status: "waiting",
          currentStep: stepId,
          stateJson: {
            run_id: run.id,
            playbook_id: run.playbookId,
            step_id: stepId,
            options,
            hitl_token: token,
          },
        });
        flows.setWaiting({
          flowId: flow.flowId,
          expectedRevision: flow.revision,
          currentStep: stepId,
          waitJson: { hitl_token: token, options },
        });
      } catch (err) {
        api.logger.warn?.(
          `[claworks:hitl] managedFlow suspend failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return token;
    },

    resolve(token, decision, comment) {
      const entry = inner.resolve(token, decision, comment);
      if (!entry || !managed?.bindSession) {
        return entry;
      }
      try {
        const flows = managed.bindSession({ sessionKey });
        const flow = flows.list().find((f) => {
          const state = f.stateJson as Record<string, unknown> | null;
          return state?.hitl_token === token;
        });
        if (flow && flow.syncMode === "managed") {
          flows.resume({
            flowId: flow.flowId,
            expectedRevision: flow.revision,
            status: "running",
            stateJson: {
              ...(flow.stateJson as Record<string, unknown>),
              decision,
              comment: comment ?? null,
            },
          });
          flows.finish({
            flowId: flow.flowId,
            expectedRevision: flow.revision + 1,
            stateJson: { decision, comment },
          });
        }
      } catch (err) {
        api.logger.warn?.(
          `[claworks:hitl] managedFlow resolve failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return entry;
    },

    get(token) {
      return inner.get(token);
    },
  };
}

function extractAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role === "assistant") {
      if (typeof msg.content === "string") {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        return msg.content
          .map((part) =>
            typeof part === "object" && part && "text" in part
              ? String((part as { text?: string }).text ?? "")
              : "",
          )
          .join("\n");
      }
    }
  }
  return "";
}
