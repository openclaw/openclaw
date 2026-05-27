---
summary: "Apply multi-file patches with the apply_patch tool"
read_when:
  - You need structured file edits across multiple files
  - You want to document or debug patch-based edits
title: "apply_patch tool"
---

Apply file changes using a structured patch format. This is ideal for multi-file
or multi-hunk edits where a single `edit` call would be brittle.

The tool accepts a single `input` string that wraps one or more file operations:

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## Parameters

- `input` (required): Full patch contents including `*** Begin Patch` and `*** End Patch`.

## Notes

- Patch paths support relative paths (from the workspace directory) and absolute paths.
- `apply_patch` is workspace-contained by default. Set `tools.exec.applyPatch.workspaceOnly` to `false` only if you intentionally want `apply_patch` to write/delete outside the workspace directory.
- When this setting is unset and `tools.exec.security` is `full` and `tools.exec.ask` is `off`, `apply_patch` inherits that no-approval host-write authority instead of requiring a separate `workspaceOnly: false` setting. Set `tools.exec.applyPatch.workspaceOnly: true`, or `tools.fs.workspaceOnly: true`, to keep it inside the workspace.
- Use `*** Move to:` within an `*** Update File:` hunk to rename files.
- `*** End of File` marks an EOF-only insert when needed.
- Available by default for OpenAI and OpenAI Codex models. Set
  `tools.exec.applyPatch.enabled: false` to disable it.
- Optionally gate by model via
  `tools.exec.applyPatch.allowModels`.
- Config is only under `tools.exec`.

## Example

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

## Related

<CardGroup cols={2}>
  <Card title="Diffs" href="/tools/diffs" icon="code-compare">
    Read-only diff viewer for change presentation.
  </Card>
  <Card title="Exec tool" href="/tools/exec" icon="terminal">
    Shell command execution from the agent.
  </Card>
  <Card title="Code execution" href="/tools/code-execution" icon="square-code">
    Sandboxed remote Python analysis with xAI.
  </Card>
</CardGroup>
