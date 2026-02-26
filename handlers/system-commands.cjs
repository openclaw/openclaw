// System Commands Handler — deterministic local execution + system monitor
// Priority 0.6 (exec) + 0.8 (system monitor)
// No LLM involved; pattern match → local exec → return result

module.exports = {
  name: "system-commands",
  priority: 0.6,

  /**
   * @param {import('./base-handler.cjs').HandlerContext} ctx
   * @param {Object} deps - { detectExecAction, localExec, detectSystemIntent, handleSystemCommand }
   */
  init(deps) {
    this._deps = deps;
  },

  match(ctx) {
    const { detectExecAction, detectSystemIntent } = this._deps;
    const exec = detectExecAction(ctx.userText);
    if (exec) {
      return { matched: true, execAction: exec, type: "exec" };
    }

    const sys = detectSystemIntent(ctx.userText);
    if (sys) {
      return { matched: true, sysIntent: sys, type: "system" };
    }

    return false;
  },

  async execute(ctx) {
    const { localExec, handleSystemCommand } = this._deps;

    if (ctx.type === "system") {
      const result = await handleSystemCommand(ctx.sysIntent.type);
      return {
        status: "handled",
        body: result,
        executor: "local",
        tracePatch: {
          route_path: "system_cmd",
          spans: [{ stage: "system_cmd", type: ctx.sysIntent.type }],
        },
      };
    }

    if (ctx.type === "exec") {
      try {
        const output = await localExec(ctx.execAction.action, ctx.execAction.args);
        return {
          status: "handled",
          body: output,
          executor: "local",
          tracePatch: {
            route_path: "exec_direct",
            spans: [{ stage: "local_exec", action: ctx.execAction.action, success: true }],
          },
        };
      } catch (e) {
        return {
          status: "handled",
          body: `執行失敗: ${e.message}`,
          executor: "local",
          tracePatch: {
            route_path: "exec_direct",
            spans: [{ stage: "local_exec", action: ctx.execAction.action, error: e.message }],
          },
        };
      }
    }

    return { status: "pass" };
  },
};
