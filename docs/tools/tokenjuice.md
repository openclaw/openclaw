---
summary: "Compact noisy exec and bash tool results with the optional Tokenjuice plugin"
title: "Tokenjuice"
read_when:
  - You want shorter `exec` or `bash` tool results in OpenClaw
  - You want to install or enable the Tokenjuice plugin
  - You need to understand what tokenjuice changes and what it leaves raw
---

`tokenjuice` is an optional external plugin that compacts noisy `exec` and `bash`
tool results after the command has already run.

It changes the returned `tool_result`, not the command itself. Tokenjuice does
not rewrite shell input, rerun commands, or change exit codes.

Today this applies to OpenClaw embedded runs and OpenClaw dynamic tools in the Codex
app-server harness. Native codex-rs shell (`bash`/`exec`) results returned to the
model are not compacted. Native `PostToolUse` events can run the middleware for
observers, but Codex does not accept a replacement tool response.

## Enable the plugin

Install once:

```bash
openclaw plugins install @openclaw/tokenjuice
```

Then enable it:

```bash
openclaw config set plugins.entries.tokenjuice.enabled true
```

Equivalent:

```bash
openclaw plugins enable tokenjuice
```

If you prefer editing config directly:

```json5
{
  plugins: {
    entries: {
      tokenjuice: {
        enabled: true,
      },
    },
  },
}
```

## What tokenjuice changes

- Compacts noisy `exec` and `bash` results before they are fed back into the session.
- Keeps the original command execution untouched.
- Applies a safe-inventory policy: exact file-content reads stay raw, standalone repository-inventory commands can compact, and unsafe mixed command sequences stay raw.
- Stays opt-in: disable the plugin if you want verbatim output everywhere.

The plugin releases Tokenjuice's compiled rule cache after results have used 128
distinct selected working directories. Ignored fallback directories do not count
toward this limit. This bounds retained rule sets from old
worktrees while preserving reuse for repeated results within the current set.
After a release, active projects reload their rules on the next eligible result.
Rule selection still uses the command's working directory.

## Verify it is working

1. Enable the plugin.
2. Start a session that can call OpenClaw's `exec` tool, either in an embedded run or as a dynamic tool in the Codex app-server harness.
3. Run a noisy command such as `git status`.
4. Check that the returned tool result is shorter and more structured than the raw shell output.

Native codex-rs shell results stay unchanged, so this check does not apply to them.
A configured or loaded plugin is not proof that an eligible result was replaced.
Check the output delivered to the agent, not only plugin inspection. Short output
and exact file reads can intentionally remain unchanged.

In Code Mode, completed OpenClaw shell-tool results pass through middleware
before they are serialized for the JavaScript caller. The outer JavaScript result
stays unchanged: it can contain file contents, schemas, or results from several
tools. Do not reduce that envelope as though it were shell output.

## Measure the complete task

Automatic plugin replacement and explicit Tokenjuice CLI wrapping are different
integrations. Keep their results separate. When comparing runs:

- Use the same source revision, task, model, effective reasoning effort, tool mode,
  and validation scope. Check the settings actually used by the run rather than
  relying on a model picker or thread default.
- Count the complete task, including failed commands, follow-up model requests,
  and recovery of omitted output. Report cached input separately without adding
  it twice to the provider total.
- Compare the delivered output, including notices and recovery instructions,
  rather than only the reducer body. Smaller tool output does not establish
  lower whole-task usage or cost.
- Keep failures and short-output controls in the comparison. Verify that the agent
  can still diagnose the failure and that exit codes remain intact.

For explicit CLI wrapping, `--keep-failures` preserves failed-command output raw;
it does not measure failure-output reduction. An opaque test launcher can also
select a generic reducer instead of the test runner-specific reducer. Inspect
the selected reducer for the actual command, and retain raw output when assessing
whether a reduced diagnostic is sufficient. These CLI policies do not configure
the OpenClaw plugin.

## Disable the plugin

```bash
openclaw config set plugins.entries.tokenjuice.enabled false
```

Or:

```bash
openclaw plugins disable tokenjuice
```

## Related

- [Exec tool](/tools/exec)
- [Thinking levels](/tools/thinking)
- [Context engine](/concepts/context-engine)
