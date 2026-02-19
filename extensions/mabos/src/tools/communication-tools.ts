/**
 * Communication Tools — ACL-based inter-agent messaging and stakeholder escalation
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: any) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

const AgentMessageParams = Type.Object({
  from: Type.String({ description: "Sender agent ID" }),
  to: Type.String({ description: "Recipient agent ID" }),
  performative: Type.Union(
    [
      Type.Literal("REQUEST"),
      Type.Literal("INFORM"),
      Type.Literal("QUERY"),
      Type.Literal("PROPOSE"),
      Type.Literal("ACCEPT"),
      Type.Literal("REJECT"),
      Type.Literal("CONFIRM"),
      Type.Literal("CANCEL"),
    ],
    { description: "ACL performative (speech act type)" },
  ),
  content: Type.String({ description: "Message content" }),
  reply_to: Type.Optional(Type.String({ description: "Message ID being replied to" })),
  priority: Type.Optional(
    Type.Union(
      [Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("urgent")],
      { description: "Message priority" },
    ),
  ),
});

const DecisionRequestParams = Type.Object({
  agent_id: Type.String({ description: "Agent requesting the decision" }),
  decision_id: Type.String({ description: "Decision ID (e.g., 'DEC-001')" }),
  title: Type.String({ description: "Decision title" }),
  description: Type.String({ description: "What needs to be decided" }),
  options: Type.Array(
    Type.Object({
      id: Type.String(),
      label: Type.String(),
      impact: Type.String({ description: "Expected impact" }),
      risk: Type.Optional(Type.String()),
      cost: Type.Optional(Type.Number()),
    }),
    { description: "Decision options with impact analysis" },
  ),
  recommendation: Type.Optional(Type.String({ description: "Agent's recommended option" })),
  urgency: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("critical"),
    ]),
  ),
  deadline: Type.Optional(Type.String({ description: "Decision deadline (ISO date)" })),
});

export function createCommunicationTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "agent_message",
      label: "Agent Message",
      description:
        "Send an ACL message between agents. Supports REQUEST, INFORM, QUERY, PROPOSE, ACCEPT, REJECT, CONFIRM, CANCEL performatives.",
      parameters: AgentMessageParams,
      async execute(_id: string, params: Static<typeof AgentMessageParams>) {
        const ws = resolveWorkspaceDir(api);
        const inboxPath = join(ws, "agents", params.to, "inbox.json");
        const inbox = (await readJson(inboxPath)) || [];

        const msg = {
          id: `MSG-${Date.now()}`,
          from: params.from,
          to: params.to,
          performative: params.performative,
          content: params.content,
          reply_to: params.reply_to,
          priority: params.priority || "normal",
          timestamp: new Date().toISOString(),
          read: false,
        };

        inbox.push(msg);
        await writeJson(inboxPath, inbox);

        return textResult(
          `Message ${msg.id} sent: ${params.from} → ${params.to} [${params.performative}] (priority: ${msg.priority})`,
        );
      },
    },

    {
      name: "decision_request",
      label: "Request Decision",
      description:
        "Escalate a decision to the stakeholder queue with options, impact analysis, and recommendation.",
      parameters: DecisionRequestParams,
      async execute(_id: string, params: Static<typeof DecisionRequestParams>) {
        const ws = resolveWorkspaceDir(api);
        const queuePath = join(ws, "decision-queue.json");
        const queue = (await readJson(queuePath)) || [];

        const decision = {
          id: params.decision_id,
          agent: params.agent_id,
          title: params.title,
          description: params.description,
          options: params.options,
          recommendation: params.recommendation,
          urgency: params.urgency || "medium",
          deadline: params.deadline,
          status: "pending",
          created: new Date().toISOString(),
        };

        queue.push(decision);
        await writeJson(queuePath, queue);

        const threshold = (api.pluginConfig as any)?.stakeholderApprovalThresholdUsd || 5000;
        const hasCostOverThreshold = params.options.some((o) => (o.cost || 0) > threshold);

        return textResult(`Decision ${params.decision_id} queued for stakeholder review.
- **Title:** ${params.title}
- **Options:** ${params.options.length}
- **Recommendation:** ${params.recommendation || "none"}
- **Urgency:** ${decision.urgency}
${hasCostOverThreshold ? `⚠️ Cost exceeds approval threshold ($${threshold})` : ""}`);
      },
    },

    {
      name: "contract_net_initiate",
      label: "Contract Net — Call for Proposals",
      description:
        "Initiate a contract-net task allocation: broadcast a call for proposals to candidate agents, collect bids, and select the best.",
      parameters: Type.Object({
        initiator: Type.String({ description: "Initiating agent ID" }),
        task_id: Type.String({ description: "Task ID" }),
        task_description: Type.String({ description: "What needs to be done" }),
        candidates: Type.Array(Type.String(), {
          description: "Agent IDs to solicit proposals from",
        }),
        criteria: Type.Array(Type.String(), {
          description: "Evaluation criteria (e.g., 'cost', 'speed', 'quality')",
        }),
        deadline: Type.Optional(Type.String({ description: "Proposal deadline (ISO date)" })),
        budget: Type.Optional(Type.Number({ description: "Budget constraint" })),
      }),
      async execute(
        _id: string,
        params: {
          initiator: string;
          task_id: string;
          task_description: string;
          candidates: string[];
          criteria: string[];
          deadline?: string;
          budget?: number;
        },
      ) {
        const ws = resolveWorkspaceDir(api);
        const now = new Date().toISOString();

        // Create CFP record
        const cfpPath = join(ws, "contract-net", `${params.task_id}.json`);
        const cfp = {
          task_id: params.task_id,
          initiator: params.initiator,
          description: params.task_description,
          candidates: params.candidates,
          criteria: params.criteria,
          deadline: params.deadline,
          budget: params.budget,
          status: "open",
          proposals: [] as any[],
          created_at: now,
        };
        await writeJson(cfpPath, cfp);

        // Send CFP to each candidate's inbox
        for (const agent of params.candidates) {
          const inboxPath = join(ws, "agents", agent, "inbox.json");
          const inbox = (await readJson(inboxPath)) || [];
          inbox.push({
            id: `CFP-${params.task_id}-${agent}`,
            from: params.initiator,
            to: agent,
            performative: "CFP",
            content: `Call for Proposals: ${params.task_description}\nCriteria: ${params.criteria.join(", ")}\nBudget: ${params.budget || "negotiable"}\nDeadline: ${params.deadline || "ASAP"}`,
            priority: "high",
            timestamp: now,
            read: false,
            task_id: params.task_id,
          });
          await writeJson(inboxPath, inbox);
        }

        return textResult(
          `Contract-Net CFP ${params.task_id} sent to ${params.candidates.length} agents: ${params.candidates.join(", ")}`,
        );
      },
    },

    {
      name: "contract_net_propose",
      label: "Contract Net — Submit Proposal",
      description: "Submit a proposal in response to a call for proposals.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "Proposing agent ID" }),
        task_id: Type.String({ description: "Task ID from CFP" }),
        proposal: Type.Object({
          approach: Type.String({ description: "How the agent would accomplish the task" }),
          estimated_cost: Type.Optional(Type.Number()),
          estimated_duration: Type.Optional(Type.String()),
          confidence: Type.Number({ description: "Confidence in success 0.0-1.0" }),
          conditions: Type.Optional(
            Type.Array(Type.String(), { description: "Conditions for the proposal" }),
          ),
        }),
      }),
      async execute(
        _id: string,
        params: {
          agent_id: string;
          task_id: string;
          proposal: {
            approach: string;
            estimated_cost?: number;
            estimated_duration?: string;
            confidence: number;
            conditions?: string[];
          };
        },
      ) {
        const ws = resolveWorkspaceDir(api);
        const cfpPath = join(ws, "contract-net", `${params.task_id}.json`);
        const cfp = await readJson(cfpPath);

        if (!cfp) return textResult(`CFP '${params.task_id}' not found.`);
        if (cfp.status !== "open")
          return textResult(
            `CFP '${params.task_id}' is no longer accepting proposals (status: ${cfp.status}).`,
          );

        cfp.proposals.push({
          agent: params.agent_id,
          ...params.proposal,
          submitted_at: new Date().toISOString(),
        });

        await writeJson(cfpPath, cfp);
        return textResult(
          `Proposal submitted by ${params.agent_id} for task ${params.task_id} (confidence: ${params.proposal.confidence})`,
        );
      },
    },

    {
      name: "contract_net_award",
      label: "Contract Net — Award Task",
      description: "Evaluate proposals and award the task to the best bidder.",
      parameters: Type.Object({
        initiator: Type.String({ description: "Initiating agent ID" }),
        task_id: Type.String({ description: "Task ID" }),
        winner: Type.Optional(
          Type.String({ description: "Agent ID to award (or omit to auto-select)" }),
        ),
      }),
      async execute(_id: string, params: { initiator: string; task_id: string; winner?: string }) {
        const ws = resolveWorkspaceDir(api);
        const cfpPath = join(ws, "contract-net", `${params.task_id}.json`);
        const cfp = await readJson(cfpPath);

        if (!cfp) return textResult(`CFP '${params.task_id}' not found.`);
        if (cfp.proposals.length === 0) return textResult("No proposals received.");

        // Auto-select: highest confidence
        const winner =
          params.winner ||
          cfp.proposals.sort((a: any, b: any) => b.confidence - a.confidence)[0].agent;
        const winningProposal = cfp.proposals.find((p: any) => p.agent === winner);

        cfp.status = "awarded";
        cfp.winner = winner;
        await writeJson(cfpPath, cfp);

        // Notify winner
        const winnerInbox = join(ws, "agents", winner, "inbox.json");
        const inbox = (await readJson(winnerInbox)) || [];
        inbox.push({
          id: `AWARD-${params.task_id}`,
          from: params.initiator,
          to: winner,
          performative: "ACCEPT",
          content: `Your proposal for task ${params.task_id} has been accepted.`,
          priority: "high",
          timestamp: new Date().toISOString(),
          read: false,
        });
        await writeJson(winnerInbox, inbox);

        // Notify losers
        for (const p of cfp.proposals) {
          if (p.agent !== winner) {
            const loserInbox = join(ws, "agents", p.agent, "inbox.json");
            const li = (await readJson(loserInbox)) || [];
            li.push({
              id: `REJECT-${params.task_id}`,
              from: params.initiator,
              to: p.agent,
              performative: "REJECT",
              content: `Task ${params.task_id} awarded to another agent.`,
              priority: "normal",
              timestamp: new Date().toISOString(),
              read: false,
            });
            await writeJson(loserInbox, li);
          }
        }

        return textResult(`Task ${params.task_id} awarded to ${winner}.
- Proposals received: ${cfp.proposals.length}
- Winning confidence: ${winningProposal?.confidence}
- Approach: ${winningProposal?.approach?.slice(0, 100)}`);
      },
    },
  ];
}
