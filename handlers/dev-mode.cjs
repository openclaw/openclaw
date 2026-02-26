// Dev Mode Handler — Tool Calling Loop
// Priority 1
// Routes development tasks with injected dev tools (read/write/test/git)

module.exports = {
  name: "dev-mode",
  priority: 1,

  /**
   * @param {Object} deps - {
   *   shouldInjectDevTools, checkRateLimit, formatDevError,
   *   saveLastProject, callSessionBridge, PROJECT_ROUTES, resolveHome
   * }
   */
  init(deps) {
    this._deps = deps;
  },

  match(ctx) {
    return this._deps.shouldInjectDevTools(ctx.userText);
  },

  async execute(ctx) {
    const { checkRateLimit, formatDevError, saveLastProject } = this._deps;

    if (!checkRateLimit("dev")) {
      return {
        status: "pass",
        skillContext: formatDevError(
          "timeout",
          "請求過於頻繁",
          "等待幾分鐘後再試 (上限: 10次/5分鐘)",
        ),
      };
    }

    // Git push intercept → direct to session-bridge
    if (/push|推送/i.test(ctx.userText)) {
      const result = await this._handleGitPush(ctx);
      if (result) {
        return result;
      }
    }

    // Normal dev mode → pass through (proxy injects dev tools into Claude request)
    return { status: "pass", devMode: true };
  },

  async _handleGitPush(ctx) {
    const { callSessionBridge, PROJECT_ROUTES, resolveHome } = this._deps;
    const lowerText = ctx.userText.toLowerCase();

    let matchedDir = null;
    let matchedKeyword = null;
    for (const route of PROJECT_ROUTES) {
      const kw = route.keywords.find((k) => lowerText.includes(k));
      if (kw) {
        matchedDir = route.dir;
        matchedKeyword = kw;
        break;
      }
    }

    if (!matchedDir) {
      return null;
    }

    const repo = resolveHome(matchedDir);
    try {
      let remote = "origin";
      if (/fork/i.test(ctx.userText)) {
        remote = "fork";
      }
      const branch = "main";
      const result = await callSessionBridge(
        `cd ${repo} && git push ${remote} ${branch}`,
        matchedKeyword,
      );
      const output = result.output || "(no output)";
      return {
        status: "handled",
        body: `git push ${remote} ${branch} 完成:\n\n${output}`,
        executor: "claude",
        tracePatch: {
          route_path: "dev_git_push",
          spans: [{ stage: "git_push", repo, success: true }],
        },
      };
    } catch (e) {
      return {
        status: "handled",
        body: `git push 失敗: ${e.message}`,
        executor: "claude",
        tracePatch: {
          route_path: "dev_git_push",
          spans: [{ stage: "git_push", repo, error: e.message }],
        },
      };
    }
  },
};
