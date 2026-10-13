import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function buildLiveQaApprovalForwardingConfig(
  baseCfg: OpenClawConfig,
  approvalOverrides?: { exec?: boolean; plugin?: boolean },
): Pick<OpenClawConfig, "approvals"> {
  if (!approvalOverrides?.exec && !approvalOverrides?.plugin) {
    return {};
  }
  const approvals = { ...baseCfg.approvals };
  for (const kind of ["exec", "plugin"] as const) {
    if (approvalOverrides[kind]) {
      approvals[kind] = { ...baseCfg.approvals?.[kind], enabled: true, mode: "session" };
    }
  }
  return { approvals };
}
