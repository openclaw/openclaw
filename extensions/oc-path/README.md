# OC Path

Inspect or edit a specific value inside a workspace file using an `oc://`
address. The plugin adds `openclaw path` commands for Markdown, JSON/JSONC,
JSONL, and YAML files, with operations to resolve, find, validate, and edit
their contents.

## Get started

Enable the plugin and inspect the command reference:

```bash
openclaw plugins enable oc-path
openclaw path --help
```

Use `set --dry-run` to review an edit before applying it. Commands run locally
on the CLI host and do not require a running Gateway.

Markdown bullet fields can wrap onto continuation lines. Resolving a field
returns its complete value; setting it replaces that value while preserving
child bullets, sibling fields, and the file's line endings.

Markdown paths returned by `find` can be reused with `resolve` and `set`, including quoted field names and empty section or item slugs. Quoted selector-like names are literals; unquoted selectors such as `$last` keep their usual meaning.

For JSON/JSONC, JSONL, and YAML arrays, a quoted numeric index such as `"0"`
works in both `resolve` and `find`, including before a wildcard. Paths returned
by `find` preserve the quoted index spelling.

This is a file-editing interface; it does not replace higher-level configuration
or memory management.

See the [OC Path guide](https://docs.openclaw.ai/plugins/oc-path) for addressing
syntax and worked examples.
