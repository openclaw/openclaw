// CLI Tools Handler — summarize, gh, etc.
// Priority 2
// Executes CLI commands and returns results as skill context

module.exports = {
  name: "cli-tools",
  priority: 2,

  /**
   * @param {Object} deps - { detectCliIntent, runCliCommand }
   */
  init(deps) {
    this._deps = deps;
  },

  match(ctx) {
    if (ctx.skillContext) {
      return false;
    }
    const intent = this._deps.detectCliIntent(ctx.userText);
    if (intent) {
      return { matched: true, cliIntent: intent };
    }
    return false;
  },

  async execute(ctx) {
    const { runCliCommand } = this._deps;
    const { cliIntent } = ctx;

    if (cliIntent.error) {
      return {
        status: "pass",
        skillContext: `[${cliIntent.cliName}] ${cliIntent.error}`,
      };
    }

    try {
      const output = await runCliCommand(cliIntent.cmd);
      return {
        status: "pass",
        skillContext: `[${cliIntent.cliName} 結果]\n${output.slice(0, 3000)}`,
      };
    } catch (e) {
      return {
        status: "pass",
        skillContext: `[${cliIntent.cliName} 錯誤] ${e.message}`,
      };
    }
  },
};
