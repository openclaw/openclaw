export function shouldBypassConfiguredAcpEnsure(commandName: string): boolean {
  // Recovery slash commands still need configured ACP readiness so stale dead
  // bindings are recreated before /new or /reset dispatches through them.
  // Status renders stored route/session facts and must not prepare external sessions.
  const command = commandName.trim().toLowerCase();
  return command === "acp" || command === "status";
}

export function shouldBypassConfiguredAcpGuildGuards(commandName: string): boolean {
  const command = commandName.trim().toLowerCase();
  return command === "new" || command === "reset";
}
