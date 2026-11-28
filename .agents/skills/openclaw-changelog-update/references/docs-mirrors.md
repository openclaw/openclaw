# Post-release docs mirrors

## Post-release docs mirrors

After explicit approval of the docs publication, publish the approved docs
sources and their mechanically flattened changelog in the same source PR.
This is separate from initial release generation; do not run an editorial
rewrite automatically during release preparation or publication.

Render the ordered docs sources into one full Markdown file, even for a large
release or a release spanning several docs pages:

```bash
pnpm changelog:from-docs --version YYYY.M.PATCH \
  --source docs/releases/YYYY.M.PATCH.md \
  --output CHANGELOG/YYYY.M.PATCH.md
pnpm changelog:check
```

Repeat `--source` in the approved reading order for a multipart release. The
converter removes presentation wrappers, turns accordion titles into headings,
expands docs links, and preserves source text, credits, code, tables, and images.
Unsupported markup fails instead of silently dropping content. Its first-line
marker binds the ordered source paths and exact source digest. Checks compare
only marked mirrors against their sources; untouched historical originals stay
in their initial format. Preserve `CHANGELOG/records/YYYY.M.PATCH.md` as the
frozen accounting record when replacing reader prose, and regenerate the mirror
in the same PR whenever its docs sources change.

The approved publication bundle owns source merge, verified docs deployment,
and the later GitHub Release body update as separate recorded steps. After
deployment, freshly read the existing release, then update only its body with
version/statistics, Raw changelog and docs links, one alphabetically deduplicated
verified human thanks roster, and the unchanged release-verification section.
Include verified PR, direct-commit, coauthor, and issue credit, including
`@steipete`; exclude bots. Keep both the 125,000-character and 125,000-byte
ceilings without truncating credits or proof. GitHub owns native avatars and
assets. Verify the body readback, resume only incomplete steps, and never retag,
rebuild, republish assets, or rerun initial publication to replace this body.
The initial history verifier rejects docs mirrors; verify them with `pnpm changelog:check` and the approved publication
steps above.
