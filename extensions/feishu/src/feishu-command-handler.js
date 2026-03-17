const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
async function handleFeishuCommand(messageText, sessionKey, hookRunner, context) {
  const trimmed = messageText.trim().toLowerCase();
  const isResetCommand = DEFAULT_RESET_TRIGGERS.some(
    (trigger) => trimmed === trigger || trimmed.startsWith(`${trigger} `)
  );
  if (!isResetCommand) {
    return false;
  }
  const command = trimmed.split(" ")[0];
  const action = command === "/new" ? "new" : "reset";
  await hookRunner.runBeforeReset(
    {
      type: "command",
      action,
      context: {
        ...context,
        commandSource: "feishu"
      }
    },
    {
      agentId: "main",
      sessionKey
    }
  );
  return true;
}
export {
  handleFeishuCommand
};
