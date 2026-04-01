# Handoff

## Files To Use First

- `CONTRIBUTION_NOTES.md`
- `PR_DRAFT.md`
- `context/`
- `agents/`
- `scripts/`

## If You Later Clone Your Fork

1. From the repo root that contains this bundle, pick a target path inside the destination repo, for example `templates/workspace/`
2. Run:

```bash
./scripts/install_public_workspace_template.sh /path/to/repo templates/workspace
```

3. Review the copied files
4. Adjust naming or placement to match the target repository
5. Commit only the copied template files

## If You Just Want The Bundle

Use:

```bash
./scripts/package_public_workspace.sh
```

Archive path:

`dist/public-workspace-template.tar.gz`
