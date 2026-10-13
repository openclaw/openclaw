# Preserve literal fences in Feishu rich-post code blocks

## Context

The inbound rich-post renderer encloses every code block in three backticks. A code example containing a literal closing fence therefore exits the block early when converted to Markdown, changing the code the agent receives. The existing Markdown parser demonstrates the corruption at the public post parser boundary.

## Decision

Choose an enclosing backtick run longer than every literal run in the code, with a minimum of three. Preserve language sanitization, newline normalization and attachment/mention behavior. The same narrow delimiter selection pattern already exists in markdown-core table serialization; no SDK surface expansion is needed.

## Alternatives

Escape or remove literal code changes the message's authored content. Add a new shared SDK API widens the boundary unnecessarily for this small plugin-owned serializer correction. A fixed longer fence still collides with sufficiently long authored runs.

## Consequences

Nested Markdown examples remain one code block with their original content. This is a text serialization correction, not a security-boundary finding. Provider transport, access controls, links and other rich-post elements remain unchanged.

## Validation

Frozen main28ee33394fe3ae90b74fefeb2ddd9e30649d6432: existing post parser suite7 passed and the new real-parser roundtrip failed. Candidate8 passed; file duration2.90s, wrapper wall6.84s. Node24.19.0, pinned pnpm12.9.0 physical checkout install; formatter and whitespace check passed. Lint wrapper timed out during initial SDK declaration preparation at its300s deadline; subsequent package typecheck failed on missing generated SDK declarations and downstream types. Those checks are not claimed passing. No broad full suite, live Feishu API, account or Gateway verification. Full failed/successful receipts retained locally; PR CI remains broad proof. CommonMark closing-fence semantics: https://spec.commonmark.org/current/#fenced-code-blocks.
