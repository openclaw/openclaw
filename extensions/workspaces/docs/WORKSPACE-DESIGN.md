# Workspace design review and distribution

Workspaces are documents owned by the Workspaces plugin. Agents can author and
refine them, but neither agent tools nor imported files can grant access or
approve executable custom-widget files.

## Review and refine loop

1. Call `workspace_get` and review the stored document rather than relying on the
   layout you intended to create.
2. Identify concrete issues by tab and widget id: unused space, unrelated content,
   missing bindings, misleading titles, or widgets sized poorly for their content.
3. Make the smallest useful change. Prefer `workspace_layout_set` for a batch of
   positions on one tab, `workspace_widget_update` for title, size, visibility,
   bindings, or props, and `workspace_widget_move` for one move or cross-tab move.
4. Call `workspace_get` again. If the result is worse, use `workspace_undo`; then
   re-read before continuing.
5. Stop when another pass would only churn the layout.

The grid has 12 columns. A widget rectangle must stay within those columns, and a
tab may contain at most 24 widgets. Put the highest-signal widget first, group one
concern per tab, and prefer live allowlisted bindings over copied snapshots.

## Distribution security contract

The Control UI export produces a versioned `openclaw-workspaces` layout package.
It is not a content or authorization backup. Export intentionally omits workspace
and tab resource ids, revisions, creator identities, registry approvals, file
digests, grants, bindings, props, credentials, and other opaque widget data. A
property-name blacklist cannot prove arbitrary JSON is credential-free, so only
the explicit layout-safe fields are distributable.

Import is a two-step owner action:

1. The gateway parses a package under a 256 KB limit, rejects unsafe prototype
   keys and unknown structure, validates the resulting Workspaces schema, and
   prepares fresh tab and widget resource ids. Slug collisions receive a safe
   suffix. Custom widget names move to a new `*-import-N` namespace and their
   registry entries are always `pending`.
2. The canonical human workspace owner reviews the tab/widget summary and
   explicitly approves the short-lived preview. Commit fails if a different owner
   or isolation domain presents it, if it expired, or if the workspace changed
   after preview.

Commit adds new tabs; it does not replace existing tabs or carry grants forward.
New tabs enter the normal sharing-sync flow before an external member can receive
access. A `?ws=<slug>` Control UI deep link only selects among tabs already
returned to the operator view. Teams links use immutable workspace/tab ids and the
gateway authorizes the exact tab resource before returning it.

Imported custom widgets do not activate automatically. Their display cards remain
pending until an operator separately reviews and approves the installed widget
files; only then can the gateway mint a frame capability.
