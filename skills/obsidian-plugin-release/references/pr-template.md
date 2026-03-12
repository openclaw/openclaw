# PR Template for obsidian-releases

**⚠️ Use this template exactly — the bot parses the PR body.**

## PR Title

```
Add plugin: Plugin Name
```

## PR Body

```markdown
# I am submitting a new Community Plugin

- [x] I attest that I have done my best to deliver a high-quality plugin...

## Repo URL

Link to my plugin: https://github.com/owner/repo

## Release Checklist

- [x] I have tested the plugin on
  - [x] Windows
  - [ ] macOS
  - [ ] Linux
  - [ ] Android _(if applicable)_
  - [ ] iOS _(if applicable)_
- [x] My GitHub release contains all required files...
  - [x] `main.js`
  - [x] `manifest.json`
  - [x] `styles.css` _(optional)_
- [x] GitHub release name matches the exact version number...
- [x] The `id` in my `manifest.json` matches the `id` in the `community-plugins.json` file.
- [x] My README.md describes the plugin's purpose...
- [x] I have read the developer policies...
- [x] I have read the tips in plugin guidelines...
- [x] I have added a license in the LICENSE file.
- [x] My project respects and is compatible with the original license...
```

## Commit + PR Commands

```powershell
git add community-plugins.json
git commit -m "Add plugin: Plugin Name"
git push origin master

gh pr create `
  --repo obsidianmd/obsidian-releases `
  --title "Add plugin: Plugin Name" `
  --body-file pr-body.md
```
