---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "macOS permission persistence (TCC) and signing requirements"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging missing or stuck macOS permission prompts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Packaging or signing the macOS app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing bundle IDs or app install paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "macOS Permissions"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# macOS permissions (TCC)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS permission grants are fragile. TCC associates a permission grant with the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
app's code signature, bundle identifier, and on-disk path. If any of those change,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS treats the app as new and may drop or hide prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Requirements for stable permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Same path: run the app from a fixed location (for OpenClaw, `dist/OpenClaw.app`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Same bundle identifier: changing the bundle ID creates a new permission identity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signed app: unsigned or ad-hoc signed builds do not persist permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Consistent signature: use a real Apple Development or Developer ID certificate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  so the signature stays stable across rebuilds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ad-hoc signatures generate a new identity every build. macOS will forget previous（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grants, and prompts can disappear entirely until the stale entries are cleared.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Recovery checklist when prompts disappear（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Quit the app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Remove the app entry in System Settings -> Privacy & Security.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Relaunch the app from the same path and re-grant permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. If the prompt still does not appear, reset TCC entries with `tccutil` and try again.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Some permissions only reappear after a full macOS restart.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example resets (replace bundle ID as needed):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo tccutil reset Accessibility bot.molt.mac（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo tccutil reset ScreenCapture bot.molt.mac（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo tccutil reset AppleEvents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Files and folders permissions (Desktop/Documents/Downloads)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS may also gate Desktop, Documents, and Downloads for terminal/background processes. If file reads or directory listings hang, grant access to the same process context that performs file operations (for example Terminal/iTerm, LaunchAgent-launched app, or SSH process).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Workaround: move files into the OpenClaw workspace (`~/.openclaw/workspace`) if you want to avoid per-folder grants.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are testing permissions, always sign with a real certificate. Ad-hoc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
builds are only acceptable for quick local runs where permissions do not matter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
