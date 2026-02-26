// Skill API Handler — web_search, system_status, gmail, etc.
// Priority 3
// Routes to external skill API (:8000) based on intent detection

module.exports = {
  name: "skill-api",
  priority: 3,

  /**
   * @param {Object} deps - {
   *   detectSkillIntent, callSkill, formatSkillResult, checkRateLimit,
   *   handleGmailBatchDelete, handleGmailFilterCreate, handleGmailUnsubscribe
   * }
   */
  init(deps) {
    this._deps = deps;
  },

  match(ctx) {
    if (ctx.skillContext) {
      return false;
    }
    const intent = this._deps.detectSkillIntent(ctx.userText);
    if (intent) {
      return { matched: true, skillIntent: intent };
    }
    return false;
  },

  async execute(ctx) {
    const {
      callSkill,
      formatSkillResult,
      checkRateLimit,
      handleGmailBatchDelete,
      handleGmailFilterCreate,
      handleGmailUnsubscribe,
    } = this._deps;
    const { skillIntent } = ctx;

    if (!checkRateLimit("skill")) {
      return {
        status: "pass",
        skillContext: `[${skillIntent.skillName}] 請求過於頻繁，請稍後再試 (上限: 30次/分鐘)`,
      };
    }

    // Gmail special handlers
    if (skillIntent.params.mode === "gmail.batch_delete") {
      return { status: "handled_special", handler: "gmail_batch_delete" };
    }
    if (skillIntent.params.mode === "gmail.filter_create") {
      return { status: "handled_special", handler: "gmail_filter_create" };
    }
    if (skillIntent.params.mode === "gmail.unsubscribe") {
      return { status: "handled_special", handler: "gmail_unsubscribe" };
    }

    try {
      const result = await callSkill(skillIntent.skillName, skillIntent.params);
      const formatted = formatSkillResult(skillIntent.skillName, result);
      return {
        status: "pass",
        skillContext: formatted,
      };
    } catch (e) {
      return {
        status: "pass",
        skillContext: `[${skillIntent.skillName} 系統暫時無法連線] 已嘗試呼叫 ${skillIntent.skillName} 技能但暫時失敗（${e.message}）。請告知用戶系統正在維護中，稍後可再試。不要說「無法查詢」，而是說「暫時無法取得資料」。`,
      };
    }
  },
};
