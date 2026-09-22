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

```text
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@ optional change context
-old line
+new line
*** Update File: src/old-name.ts
*** Move to: src/new-name.ts
@@
 context line
-old line
+new line
*** Update File: src/tail.ts
@@
+appended last line
*** End of File
*** Delete File: obsolete.txt
*** End Patch
```

`*** Move to:` goes on the line directly after its `*** Update File:` header.
`*** End of File` goes after the hunk lines it terminates, marking that the hunk
runs to the end of the file.

## Parameters

- `input` (required): Full patch contents including `*** Begin Patch` and `*** End Patch`.

## Notes

- Patch paths support relative paths (from the workspace directory) and absolute paths.
- `tools.exec.applyPatch.workspaceOnly` defaults to `true` (workspace-contained). Set it to `false` only if you intentionally want `apply_patch` to write/delete outside the workspace directory.
- This setting is independent of `tools.exec.mode`. Setting `tools.exec.mode: "full"` does not lift the `apply_patch` workspace boundary.
- `tools.fs.workspaceOnly` contains `apply_patch` independently, so clearing one setting can leave the other in force.
- An explicit session permission mode overrides both configuration settings: `full` removes their containment, `guarded` and `workspace` contain `apply_patch`, and `read-only` omits the tool.
- Required workspace roots and sandbox restrictions still apply in `full` mode. Keep patch paths inside a required root; changing either configuration setting or the session mode cannot lift it.
- Memory-flush runs expose only `read` and append-only `write`, so `apply_patch` is unavailable even in `full` mode.
- Runs whose entire agent executes on a worker (`worker-turn`) ignore both configuration settings. With no permission mode, they contain `apply_patch` whenever it is available; an explicit `full` mode disables that tool containment. Workers used only for remote commands (`remote-exec`) follow the locally running agent's file-tool policy.
- `*** Add File:` and a non-self `*** Move to:` require the destination path to be absent. To intentionally replace a path, delete it earlier in the same patch before adding or moving the replacement.
- Use `*** Move to:` within an `*** Update File:` hunk to rename files.
- `*** End of File` marks an EOF-only insert when needed.
- Enabled by default for every model. Set `tools.exec.applyPatch.enabled: false`
  to disable it, or restrict it to specific models with
  `tools.exec.applyPatch.allowModels` (accepts raw ids like `gpt-5.4` or full
  ids like `openai/gpt-5.4`).
- The tool's enablement and model settings live under `tools.exec.applyPatch.*`.

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
