# Common Pitfalls (from PR #10404 Experience)

## Failure Table

| Mistake                          | Result                                                | Prevention                          |
| -------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| manifest.json only in subfolder  | "manifest.json not found"                             | Must be at repo root                |
| Missing LICENSE                  | "does not include a license"                          | Add LICENSE file at root            |
| "Obsidian" in description        | "don't include Obsidian"                              | Use "for your vault" etc.           |
| PR/manifest description mismatch | "Description mismatch"                                | Copy from one source                |
| PR template not followed         | "did not follow PR template"                          | Use exact official template         |
| JSON trailing comma              | "invalid JSON"                                        | Validate with jq / ConvertFrom-Json |
| Text editor for JSON edit        | `\uXXXX` → `?` unicode corruption, 100s of diff lines | Use Python json module only         |
| `git diff --stat` not checked    | Unnecessary changes in PR                             | Verify ~8 lines changed             |
| Release name `v0.1.0`            | Name mismatch                                         | Use `0.1.0` (no v prefix)           |

## Lessons Learned

- **PR #10404**: Submitted without pre-validation → 9 bot failures → closed
- **PR #10406**: Followed this skill's procedure → **1-shot pass** (plugin-validation SUCCESS, 0 comments)
- **Key insight**: Always use Python `json` module for community-plugins.json + verify `git diff` is minimal

## External References

- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Developer policies](https://docs.obsidian.md/Developer+policies)
- [PR template source](https://raw.githubusercontent.com/obsidianmd/obsidian-releases/refs/heads/master/.github/PULL_REQUEST_TEMPLATE/plugin.md)
