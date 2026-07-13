# Living Answers

Living Answers are ordinary Workspaces widgets with an optional expiry. They are useful for temporary, agent-authored results that should disappear unless an operator pins them.

Set `ephemeral.expiresAt` to an ISO 8601 timestamp with an explicit timezone when calling `workspace_widget_add` or `workspace_widget_update`. Expired widgets are removed transactionally on the next workspace read. Pinning is explicit: update the widget with `ephemeral: null`; this clears the expiry and preserves the widget.

## Action forms

`builtin:action-form` turns a bounded, workspace-authored template into a small operator form. Its props contain:

- `template`: 1-2000 characters, with slots such as `{topic}`
- `fields`: 1-8 declared `text`, `number`, or `select` fields
- `buttonLabel`: optional, 1-40 characters

Every template slot must name a declared field. Values are type-checked and length-capped, and interpolation is one pass, so slot-like text inside a submitted value is never expanded again.

Submitting a form does not grant a new action capability. It routes through the same prompt-send gate as approved custom widgets: one in-flight request, ten confirmed requests per rolling minute per widget, and an operator confirmation quoting the exact prompt for every submission. A decline sends nothing and consumes no rate slot. The message goes through `chat.send` with `deliver: false`; the agent still decides how to handle it under its existing tools and permissions.

Do not use an action form to encode arbitrary RPC methods, shell commands, or approval bypasses. The form only produces a prompt; normal agent/tool authorization remains the enforcement boundary.
