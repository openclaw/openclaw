export const scheduledAppApprovalPolicyCases = [
  { name: "global default", app: {}, expected: "prompt" },
  {
    name: "app default over global default",
    app: { default_tools_approval_mode: "writes" },
    expected: "writes",
  },
  {
    name: "tool override over app default",
    app: {
      default_tools_approval_mode: "prompt",
      tools: { edit: { approval_mode: "approve" } },
    },
    expected: "approve",
  },
  {
    name: "fixed account prompt over app approval",
    app: {
      default_tools_approval_mode: "approve",
      links: { account: { default_tools_approval_mode: "prompt" } },
    },
    toolMetadata: { link_id: "account" },
    expected: "prompt",
  },
  {
    name: "fixed account approval without another account's prompt",
    app: {
      default_tools_approval_mode: "prompt",
      links: {
        account: { default_tools_approval_mode: "approve" },
        other: { default_tools_approval_mode: "prompt" },
      },
    },
    toolMetadata: { link_id: "account" },
    expected: "approve",
  },
  {
    name: "tool override over fixed account prompt",
    app: {
      links: { account: { default_tools_approval_mode: "prompt" } },
      tools: { edit: { approval_mode: "approve" } },
    },
    toolMetadata: { link_id: "account" },
    expected: "approve",
  },
  {
    name: "title-keyed tool override over fixed account prompt",
    app: {
      links: { account: { default_tools_approval_mode: "prompt" } },
      tools: { "Edit event": { approval_mode: "writes" } },
    },
    toolMetadata: { link_id: "account" },
    expected: "writes",
  },
  {
    name: "fixed account prompt when the full-name entry shadows the title override",
    app: {
      default_tools_approval_mode: "approve",
      links: { account: { default_tools_approval_mode: "prompt" } },
      tools: { edit: { enabled: true }, "Edit event": { approval_mode: "approve" } },
    },
    toolMetadata: { link_id: "account" },
    expected: "prompt",
  },
  {
    name: "app default for a tool without account metadata",
    app: {
      default_tools_approval_mode: "writes",
      links: { account: { default_tools_approval_mode: "prompt" } },
    },
    expected: "writes",
  },
  {
    name: "argument-selected account ceiling over fixed metadata",
    app: {
      default_tools_approval_mode: "approve",
      links: {
        account: { default_tools_approval_mode: "prompt" },
        other: { default_tools_approval_mode: "approve" },
      },
    },
    toolMetadata: { link_id: "other", _codex_apps: { requires_explicit_link_id: true } },
    expected: "prompt",
  },
  {
    name: "argument-selected account default for links without overrides",
    app: {
      default_tools_approval_mode: "prompt",
      links: { account: { default_tools_approval_mode: "approve" } },
    },
    toolMetadata: { _codex_apps: { requires_explicit_link_id: true } },
    expected: "prompt",
  },
  {
    name: "argument-selected account approval when every mode allows it",
    app: {
      default_tools_approval_mode: "approve",
      links: { account: { default_tools_approval_mode: "approve" } },
    },
    toolMetadata: { _codex_apps: { requires_explicit_link_id: true } },
    expected: "approve",
  },
];
