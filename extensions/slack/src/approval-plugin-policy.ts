import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/** Returns undefined only when Slack plugin approvals retain legacy account authorization. */
export function resolvePluginApprovalSlackApprovers(
  cfg: OpenClawConfig,
  request: PluginApprovalRequest,
): readonly string[] | undefined {
  const policy = cfg.approvals?.plugin?.slack;
  if (!policy) {
    return undefined;
  }
  const subject = request.request.policySubject;
  const plugins = policy.plugins;
  if (!subject && plugins && Object.keys(plugins).length > 0) {
    // A missing selected owner cannot safely inherit a broader list when
    // another configured plugin may narrow who can approve its calls.
    return [];
  }
  const plugin =
    subject && plugins && Object.hasOwn(plugins, subject.pluginKey)
      ? plugins[subject.pluginKey]
      : undefined;
  const tools = plugin?.tools;
  if (tools && Object.keys(tools).length > 0) {
    // A tool override may narrow a plugin list. Missing exact call identity
    // cannot inherit the broader list while this request is pending.
    if (!subject?.tool) {
      return [];
    }
    const toolKey = subject.appId
      ? `${encodeURIComponent(subject.appId)}/${encodeURIComponent(subject.tool)}`
      : subject.mcpServer
        ? `mcp/${encodeURIComponent(subject.mcpServer)}/${encodeURIComponent(subject.tool)}`
        : encodeURIComponent(subject.tool);
    if (Object.hasOwn(tools, toolKey)) {
      return tools[toolKey]?.approvers ?? [];
    }
  }
  return plugin?.approvers ?? policy.approvers;
}
