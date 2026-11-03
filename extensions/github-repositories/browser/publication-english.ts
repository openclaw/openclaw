export const publicationEnglish = {
  githubPublication: {
    title: "Publication",
    publishAsLabel: "Publish as",
    personal: "My GitHub",
    system: "System GitHub",
    agent: "Agent override",
    publishAs: "Publish as @{account}",
    account: "Publication account",
    newAction: "Choose a new publication",
    failedAttempt: "Publication attempt failed",
    capacity:
      'Too many publications are awaiting review. Finish an existing publication, then select "{newAction}" to make room. Existing retries remain available.',
    confirm: "Confirm original publication",
    check: "Check publication",
    refresh: "Refresh publication",
    statusFailed: "Publication failed",
    statusConfirm: "Confirmation needed",
    statusRequested: "Publication queued",
    statusPublishing: "Publication in progress",
    statusUnavailable: "Publication status unavailable",
    statusUnknown: "Outcome unknown",
    unknown:
      "The outcome is unknown. Retry keeps the original account and request; it does not switch accounts.",
    target: "Pull request: {repository} → {base}",
    pushTarget: "Push: {repository} · {branch}",
    snapshot: "Original accepted snapshot",
    head: "HEAD",
    index: "Index tree",
    workspace: "Workspace tree",
    dispatched: "GitHub {kind} was dispatched; its remote outcome may still be unknown.",
    observed: "GitHub {kind} was observed. Disconnecting does not undo this effect.",
    effectLink: "View GitHub effect",
    effectPush: "push",
    effectPullRequest: "pull request",
    personalWorkspace:
      "Wait for work to finish and reclaim the workspace to publish with My GitHub.",
    unidentified: "Sign in with a personal profile to use My GitHub.",
    sharedUnavailable: {
      unavailable:
        "No usable GitHub credential is available in the Gateway environment. Sign in with gh auth login on the Gateway runtime host, or optionally add a connection in Settings → Profile → GitHub connections. My GitHub is separate and optional.",
      changed: "The Gateway GitHub account changed. Reload and retry publication.",
      rate_limited:
        "GitHub rate-limited account verification. Wait and retry publication; reconnecting is not needed.",
      unverified:
        "GitHub account verification is unavailable. Retry publication or check gh auth status on the Gateway runtime host.",
      unsupported_workspace:
        "Publish PR needs a session-owned worktree or repository workspace. Normal agent gh commands still work; reconnecting GitHub will not help.",
      unknown:
        "GitHub publication account verification is unavailable. Reload and retry, or check gh auth status on the Gateway runtime host. Settings connections are optional; My GitHub is separate.",
    },
  },
};
