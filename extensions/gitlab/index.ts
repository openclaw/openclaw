import {
  GitLabIssueOperationSchema,
  isGitLabIssueWrite,
  parseGitLabIssueOperation,
} from "@openclaw/gateway-protocol/gitlab-issues";
import {
  GitLabPublicationOperationSchema,
  parseGitLabPublicationOperation,
} from "@openclaw/gateway-protocol/gitlab-publication";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";

export default definePluginEntry({
  id: "gitlab",
  name: "GitLab",
  description: "Requester-attributed GitLab publication, issues and discussions",
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          name: "gitlab_issues",
          label: "GitLab Issues and Comments",
          description:
            "Read and manage GitLab issues, issue comments, and existing merge-request discussions as the person requesting this turn. Uses that person's connected My GitLab account inside the Gateway; never uses System, agent, CLI, or another person's credentials as fallback. Supply the explicit projectUrl on the configured GitLab server. Read current issue/note fields before editing or deleting; retain returned IDs and pagination. Use discussion replies for threads and ordinary notes for root comments. Only make writes the user requested. After an uncertain write, read the exact target and reconcile its author/content before retrying; never repeat create/post/reply blindly. Missing or ambiguous requester authorization requires a new signed-in user turn or connecting My GitLab in Profile. Repository publication is a separate action.",
          parameters: GitLabIssueOperationSchema,
          async execute(_toolCallId, input, signal) {
            context.assertInvocationCurrent();
            signal?.throwIfAborted();
            const operation = parseGitLabIssueOperation(input);
            if (!operation) {
              throw new Error(
                "Provide a supported GitLab issue or discussion action and explicit project URL.",
              );
            }
            const write = isGitLabIssueWrite(operation);
            const result = await api.runtime.gateway.request(
              write ? "tools.gitlab.issues.write" : "tools.gitlab.issues.read",
              operation,
              {
                scopes: [write ? "operator.sessions.write" : "operator.sessions.read"],
                timeoutMs: 120_000,
                signal,
              },
            );
            const { wrapExternalContent } = await import("openclaw/plugin-sdk/security-runtime");
            context.assertInvocationCurrent();
            signal?.throwIfAborted();
            return textResult(
              wrapExternalContent(JSON.stringify(result, null, 2), {
                source: "api",
                includeWarning: false,
              }),
              result,
            );
          },
        }),
      },
      { name: "gitlab_issues", workspaceAccess: false },
    );
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          name: "gitlab_publish",
          label: "GitLab Publish",
          async: false,
          catalogMode: "direct-only",
          description:
            "Publish this conversation's repository changes as the requesting person's connected My GitLab account. Never uses System, agent, CLI or another person's credentials. Requires the user's instruction to publish. action publish creates a draft MR by default; supply baseBranch when the repository workflow selects a branch other than the project default. For a clean local checkout not yet owned by this conversation, supply workspacePath: the native host adopts an isolated managed worktree and preserves earlier files. Use bootstrapDraft:true only when the user requests an initial empty draft MR before implementation; it requires draft:true and an unchanged tree on a new remote branch. Publication yields the turn and its result resumes this same conversation; started/requested/publishing is not completion. Retain requestId and exact SHA. action status reads an accepted request; never resubmit an uncertain write. action confirm uses requestId plus the exact requestDigest, generation and account returned in status.confirmation to reconcile the original request. No arbitrary repository, account or publishing-session selector is accepted. Missing personal authorization requires connecting My GitLab in Profile. Use gitlab_issues for issues and comments.",
          parameters: GitLabPublicationOperationSchema,
          async execute(toolCallId, input, signal) {
            context.assertInvocationCurrent();
            signal?.throwIfAborted();
            const operation = parseGitLabPublicationOperation(input);
            if (!operation || !context.sessionKey || !context.agentId) {
              throw new Error(
                "GitLab publication requires the current signed-in Gateway conversation.",
              );
            }
            const method = `tools.gitlab.publication.${operation.action}`;
            const params = {
              sessionKey: context.sessionKey,
              agentId: context.agentId,
              idempotencyKey: context.runId ? `${context.runId}:${toolCallId}` : toolCallId,
              operation,
            };
            if (operation.action !== "status") {
              if (!context.gatewayHandoff) {
                throw new Error("GitLab publication requires native conversation handoff support.");
              }
              return context.gatewayHandoff({ method, params, signal });
            }
            const result = await api.runtime.gateway.request(method, params, {
              scopes: ["operator.sessions.read"],
              signal,
              timeoutMs: 120_000,
            });
            const { wrapExternalContent } = await import("openclaw/plugin-sdk/security-runtime");
            context.assertInvocationCurrent();
            signal?.throwIfAborted();
            return textResult(
              wrapExternalContent(JSON.stringify(result, null, 2), {
                source: "api",
                includeWarning: false,
              }),
              result,
            );
          },
        }),
      },
      {
        name: "gitlab_publish",
        workspaceAccess: false,
        gatewayHandoffMethods: [
          "tools.gitlab.publication.publish",
          "tools.gitlab.publication.confirm",
        ],
      },
    );
  },
});
