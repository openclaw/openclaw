import path from "node:path";
import type { OpenClawPluginNodeInvokePolicy } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { evaluateFilePolicy, snapshotNodeFileReadPolicy } from "./policy.js";
import { readWorkspaceMemoryRequest } from "./workspace-memory-request.js";
import { readWorkspaceSkillsRequest } from "./workspace-skills-request.js";

export function createWorkspaceMemoryPolicy(): OpenClawPluginNodeInvokePolicy {
  return createWorkspaceWorkerPolicy("memory");
}

export function createWorkspaceSkillsPolicy(): OpenClawPluginNodeInvokePolicy {
  return createWorkspaceWorkerPolicy("skills");
}

function createWorkspaceWorkerPolicy(kind: "memory" | "skills"): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [`workspace.${kind}`],
    dangerous: true,
    async handle(ctx) {
      let maxReplyBytes: number | undefined;
      let resourceReadPolicy: ReturnType<typeof snapshotNodeFileReadPolicy> | undefined;
      try {
        const request =
          kind === "memory"
            ? readWorkspaceMemoryRequest(ctx.params)
            : readWorkspaceSkillsRequest(ctx.params);
        const workspaces = asOptionalRecord(ctx.pluginConfig?.workspaces) ?? {};
        const configured = Object.values(workspaces).some((value) => {
          const binding = asOptionalRecord(value);
          return (
            binding?.nodeId === ctx.nodeId &&
            typeof binding.remoteRoot === "string" &&
            path.posix.isAbsolute(binding.remoteRoot) &&
            !binding.remoteRoot.includes("\0") &&
            path.posix.resolve(binding.remoteRoot) === request.workspaceDir
          );
        });
        if (!configured) {
          throw new Error("Node workspace is not configured");
        }
        if (
          kind === "skills" &&
          ["readResources", "discovery"].includes(String(asOptionalRecord(ctx.params)?.operation))
        ) {
          resourceReadPolicy = snapshotNodeFileReadPolicy({
            nodeId: ctx.nodeId,
            nodeDisplayName: ctx.node?.displayName,
            pluginConfig: ctx.pluginConfig,
          });
        }
        for (const access of request.paths) {
          const decision = evaluateFilePolicy({
            ...access,
            nodeId: ctx.nodeId,
            nodeDisplayName: ctx.node?.displayName,
            pluginConfig: ctx.pluginConfig,
          });
          if (!decision.ok || decision.reason === "ask-always") {
            throw new Error("Workspace worker requires an existing file grant");
          }
          if (decision.maxBytes !== undefined) {
            maxReplyBytes = Math.min(maxReplyBytes ?? Infinity, decision.maxBytes);
          }
        }
      } catch (error) {
        return { ok: false, code: "POLICY_DENIED", message: String(error) };
      }
      return await ctx.invokeNode({
        params: { ...asOptionalRecord(ctx.params), maxReplyBytes, resourceReadPolicy },
      });
    },
  };
}
