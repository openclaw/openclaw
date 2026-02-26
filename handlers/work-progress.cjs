// Work Progress Query Handler
// Priority 2.5
// Fetches work tracker data and formats progress report

module.exports = {
  name: "work-progress",
  priority: 2.5,

  /**
   * @param {Object} deps - { detectProgressIntent, fetchWorkProgress, formatProgressResponse }
   */
  init(deps) {
    this._deps = deps;
  },

  match(ctx) {
    if (ctx.skillContext) {
      return false;
    } // already has skill context
    return this._deps.detectProgressIntent(ctx.userText);
  },

  async execute(ctx) {
    const { fetchWorkProgress, formatProgressResponse } = this._deps;

    try {
      const [wtData, procs] = await fetchWorkProgress();
      const progressText = formatProgressResponse(wtData, procs);
      return {
        status: "handled",
        body: progressText,
        executor: "local",
        tracePatch: {
          route_path: "progress_query",
          spans: [{ stage: "work_progress", success: true }],
        },
      };
    } catch (e) {
      return {
        status: "pass",
        skillContext: `[工作進度查詢失敗] ${e.message}`,
      };
    }
  },
};
