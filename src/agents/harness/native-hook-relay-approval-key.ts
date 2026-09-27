export function nativeHookRelayPreToolUseApprovalKey(params: {
  relayId: string;
  runId: string;
  toolUseId?: string;
}): string | undefined {
  const toolUseId = params.toolUseId?.trim();
  return toolUseId ? JSON.stringify([params.relayId, params.runId, toolUseId]) : undefined;
}
