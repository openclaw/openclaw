// Synthetic operator policy for the standalone Node suite and its subprocesses.
process.env.OPENCLAW_TEAM_OPERATOR_PROFILE = JSON.stringify({
  channels: [
    ["clickclack", "default"],
    ["discord", "controller-test-agent"],
    ["reef", "default"],
  ],
  modelAgent: "controller-test-agent",
  policy: {
    mode: "full",
    appServer: {
      mode: "yolo",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      defaultWorkspaceDir: "/home/openclaw/.openclaw/workspace",
    },
    workspaceOnly: true,
    updateAuto: false,
    clickclackCommandMenu: false,
  },
  handoff: {
    provider: "fixture-provider",
    sourceBaseUrl: "http://127.0.0.1:23456",
    targetBaseUrl: "https://gateway.example.invalid",
  },
});
