const mode = (default_tools_approval_mode: string) => ({ default_tools_approval_mode });
const account = (value: string) => ({ account: mode(value) });
const fixedAccount = { link_id: "account" };
const selectedAccount = { _codex_apps: { requires_explicit_link_id: true } };

export const scheduledAppApprovalPolicyCases = (
  [
    ["global default", {}, "prompt"],
    ["app default over global default", mode("writes"), "writes"],
    [
      "tool override over app default",
      { ...mode("prompt"), tools: { edit: { approval_mode: "approve" } } },
      "approve",
    ],
    [
      "fixed account prompt over app approval",
      { ...mode("approve"), links: account("prompt") },
      "prompt",
      fixedAccount,
    ],
    [
      "fixed account approval without another account's prompt",
      { ...mode("prompt"), links: { ...account("approve"), other: mode("prompt") } },
      "approve",
      fixedAccount,
    ],
    [
      "tool override over fixed account prompt",
      { links: account("prompt"), tools: { edit: { approval_mode: "approve" } } },
      "approve",
      fixedAccount,
    ],
    [
      "title-keyed tool override over fixed account prompt",
      { links: account("prompt"), tools: { "Edit event": { approval_mode: "writes" } } },
      "writes",
      fixedAccount,
    ],
    [
      "fixed account prompt when the full-name entry shadows the title override",
      {
        ...mode("approve"),
        links: account("prompt"),
        tools: { edit: { enabled: true }, "Edit event": { approval_mode: "approve" } },
      },
      "prompt",
      fixedAccount,
    ],
    [
      "app default for a tool without account metadata",
      { ...mode("writes"), links: account("prompt") },
      "writes",
    ],
    [
      "argument-selected account ceiling over fixed metadata",
      { ...mode("approve"), links: { ...account("prompt"), other: mode("approve") } },
      "prompt",
      { link_id: "other", ...selectedAccount },
    ],
    [
      "argument-selected account default for links without overrides",
      { ...mode("prompt"), links: account("approve") },
      "prompt",
      selectedAccount,
    ],
    [
      "argument-selected account approval when every mode allows it",
      { ...mode("approve"), links: account("approve") },
      "approve",
      selectedAccount,
    ],
  ] as const
).map(([name, app, expected, toolMetadata]) => ({ name, app, expected, toolMetadata }));
