// Follow-up Execution Handler
// Priority 0.9
// When user sends short confirmation (好/execute/do it),
// extract 👉 commands from conversation history and execute

module.exports = {
  name: "follow-up",
  priority: 0.9,

  /**
   * @param {Object} deps - { detectDevIntent, isAllowedPath, saveLastProject, executeDevCommand }
   */
  init(deps) {
    this._deps = deps;
    this.CONFIRM_WORDS = [
      "執行",
      "做吧",
      "好",
      "繼續",
      "開始吧",
      "處理",
      "do it",
      "go",
      "execute",
      "proceed",
      "yes",
      "ok",
    ];
  },

  match(ctx) {
    if (!ctx.messages || ctx.messages.length < 2) {
      return false;
    }

    const text = ctx.userText;
    if (!text || text.length > 10) {
      return false;
    }

    const lower = text.toLowerCase();
    // Don't treat as confirm if it contains project keywords
    if (ctx.hasProjectKeyword) {
      return false;
    }

    const isConfirm = this.CONFIRM_WORDS.some((w) => lower.includes(w));
    if (!isConfirm) {
      return false;
    }

    const wantsAll = lower.includes("全部") || lower.includes("all") || lower.includes("都");

    // Extract 👉 suggestions from history
    const suggestions = [];
    for (const m of [...ctx.messages].toReversed()) {
      if (m.role !== "assistant") {
        continue;
      }
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const matches = content.match(/^👉\s*(.+)/gm);
      if (matches) {
        for (const match of matches) {
          const cmd = match.replace(/^👉\s*/, "").trim();
          if (cmd.length >= 3) {
            suggestions.push(cmd);
          }
        }
        break;
      }
    }

    if (suggestions.length === 0) {
      return false;
    }
    return { matched: true, suggestions, wantsAll };
  },

  async execute(ctx) {
    const { detectDevIntent, isAllowedPath, saveLastProject, executeDevCommand } = this._deps;
    const { suggestions, wantsAll } = ctx;

    if (wantsAll) {
      const results = [];
      for (const cmd of suggestions) {
        const cmdDevIntent = detectDevIntent(cmd);
        if (cmdDevIntent && isAllowedPath(cmdDevIntent.projectDir)) {
          void saveLastProject(cmdDevIntent.projectDir);
          try {
            const output = await executeDevCommand(cmd, cmdDevIntent.projectDir, null);
            results.push(`✓ ${cmd}\n${output}`);
          } catch (e) {
            results.push(`✗ ${cmd}\n${e.message}`);
          }
        } else {
          results.push(`⊘ ${cmd} (無法路由)`);
        }
      }
      return {
        status: "handled",
        body: results.join("\n\n───\n\n"),
        executor: "local",
        tracePatch: {
          route_path: "follow_up_exec_all",
          spans: [{ stage: "follow_up", count: suggestions.length }],
        },
      };
    }

    // Single execution — fall through with replaced userText
    return { status: "pass", replacedUserText: suggestions[0] };
  },
};
