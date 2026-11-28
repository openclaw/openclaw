# Windows Parallels smoke

## Windows flow

- This repo owns the general Windows VM lifecycle: remote `prlctl` management, clean-state checks, WSL 2, Git/Node, snapshot creation/restoration, and OpenClaw smoke. Assume Parallels Desktop is installed/activated and a Windows 11 VM has been downloaded, then run:

  ```bash
  pnpm test:parallels:windows:prepare -- inventory
  pnpm test:parallels:windows:prepare -- prepare
  pnpm test:parallels:windows:prepare -- verify
  ```

- `prepare` inventories before mutation, requires Parallels Tools and a logged-in desktop session, rejects OpenClaw CLI/app/tray/process state and WSL distros, creates a dated power-off clean-OS snapshot only on an unprepared guest, enables WSL/Virtual Machine Platform, installs the signed Microsoft WSL package, sets WSL 2 as default, installs Git, Node/npm, and the native addons' Visual C++ runtime, verifies the Windows hypervisor is active and no reboot is pending, and creates a power-off `pre-openclaw-native-e2e-<date>` snapshot. Existing baselines without `vcruntime140.dll` fail verification; prepare a new baseline name to upgrade them.
- When today's E2E snapshot already exists, `prepare` restores and verifies that snapshot instead of trusting its name. Treat `prepare` as destructive to post-snapshot guest changes, just like an explicit restore.
- Package elevation resolves the exact version and SHA-256 from Microsoft's official WinGet manifests, validates the expected Authenticode publisher, and copies into a freshly ACL-restricted SYSTEM directory before execution. Keep this generic mechanism here; companion-specific package choices stay in the Windows app repo.
- Restore `clean`, `e2e`, an exact name, or an id:

  ```bash
  pnpm test:parallels:windows:prepare -- restore --snapshot e2e
  ```

- Restoring discards all post-snapshot changes. Inventory first and do not restore while another developer or lane owns the VM. `e2e` selects the newest `pre-openclaw-native-e2e-*`; use an exact snapshot for historical reproduction.
- For native companion work, read `../../../../../openclaw-windows-node/.agents/skills/openclaw-proof-validation/PARALLELS.md`. That optional macOS sidecar reuses this controller and adds only .NET, Windows SDK, WebView2, the app checkout, app-layer snapshots, build/tests, and native proof.
- Preferred entrypoint: `pnpm test:parallels:windows`
- Use the newest verified `pre-openclaw-native-e2e-*` snapshot and pass its exact name with `--snapshot-hint`.
- Default upgrade coverage on Windows should now include: fresh snapshot -> site installer pinned to the requested stable tag -> `openclaw update --channel dev` on the guest. Keep the older host-tgz upgrade path only when the caller explicitly passes `--target-package-spec`.
- Optional exact npm-tag baseline on Windows: `bash scripts/e2e/parallels-windows-smoke.sh --mode upgrade --target-package-spec openclaw@<tag> --json`. That lane installs the published npm tarball as baseline, then runs `openclaw update --channel dev`.
- Optional forward-fix Windows validation: `bash scripts/e2e/parallels-windows-smoke.sh --mode upgrade --upgrade-from-packed-main --json`. That lane installs the packed current-main npm tgz as baseline, then runs `openclaw update --channel dev`.
- Always use `prlctl exec --current-user`; plain `prlctl exec` lands in `NT AUTHORITY\\SYSTEM`.
- Prefer explicit `npm.cmd` and `openclaw.cmd`.
- Use PowerShell only as the transport with `-ExecutionPolicy Bypass`, then call the `.cmd` shims from inside it.
- Current Windows Node installs expose `corepack` as a `.cmd` shim. If a release-to-dev lane sees `corepack` on PATH but `openclaw update --channel dev` still behaves as if corepack is missing, treat that as an exec-shim regression first.
- If an exact published-tag Windows lane fails during preflight with `npm run build` and `'pnpm' is not recognized`, remember that the guest is still executing the old published updater. Validate the fix with `--upgrade-from-packed-main`, then wait for the next tagged npm release before expecting the historical tag lane to pass.
- Multi-word `openclaw agent --message ...` checks should call `& $openclaw ...` inside PowerShell, not `Start-Process ... -ArgumentList` against `openclaw.cmd`, or Commander can see split argv and throw `too many arguments for 'agent'`.
- Windows installer/tgz phases now retry once after guest-ready recheck; keep new Windows smoke steps idempotent so a transport-flake retry is safe.
- If a Windows retry sees the VM become `suspended` or `stopped`, resume/start it before the next `prlctl exec`; otherwise the second attempt just repeats the same `rc=255`.
- Windows global `npm install -g` phases can stay quiet for a minute or more even when healthy; inspect the phase log before calling it hung, and only treat it as a regression once the retry wrapper or timeout trips.
- When those Windows global installs stay quiet, the useful progress often lives in the guest npm debug log, not the helper phase log. The smoke script now streams incremental `npm-cache/_logs/*-debug-0.log` deltas into the phase log during long baseline/package installs; read those lines before assuming the lane is stalled.
- The Windows baseline-package helpers now auto-dump the latest guest `npm-cache/_logs/*-debug-0.log` tail on timeout or nonzero completion. Read that tail in the phase log before opening a second guest shell.
- The same incremental npm-debug streaming also applies to `--upgrade-from-packed-main` / packaged-install baseline phases. A phase log that still says only `install.start`, `install.download-tgz`, `install.install-tgz` can still be healthy if the streamed npm-debug section shows registry fetches or bundled-plugin postinstall work.
- Fresh Windows tgz install phases should also use the background PowerShell runner plus done-file/log-drain pattern; do not rely on one long-lived `prlctl exec ... powershell ... npm install -g` transport for package installs.
- Windows release-to-dev helpers may log `where pnpm` diagnostically. The updater deliberately bootstraps a temporary pinned pnpm and cleans it up; permanent pnpm availability is not a post-update requirement. Require the installed OpenClaw CLI to resolve in a fresh shell using persisted Machine + User PATH.
- Keep the CLI update deadline inside the Windows phase envelope, with separate setup/reporting and cleanup allowances. If setup consumes the command's reserved budget, refuse before launching the updater. Verify version, status, and fresh-shell CLI in the subsequent verification phase; retain the top-level host hard cap.
- Fresh Windows ref-mode onboard should use the same background PowerShell runner plus done-file/log-drain pattern as the npm-update helper, including startup materialization checks, host-side timeouts on short poll `prlctl exec` calls, and retry-on-poll-failure behavior for transient transport flakes.
- Fresh Windows daemon-health reachability should use `openclaw gateway probe --json` with a longer timeout and treat `ok: true` as success; full `gateway status --require-rpc` checks are too eager during initial startup on current main.
- Fresh Windows ref-mode agent verification should set `OPENAI_API_KEY` in the PowerShell environment before invoking `openclaw.cmd agent`, for the same pairing-required fallback reason as macOS.
- The standalone Windows upgrade smoke lane should stop the managed gateway after `upgrade.install-main` and before `upgrade.onboard-ref`. Restarting before onboard can leave the old process alive on the pre-onboard token while onboard rewrites `~/.openclaw/openclaw.json`, which then fails `gateway-health` with `unauthorized: gateway token mismatch`.
- If standalone Windows upgrade fails with a gateway token mismatch but `pnpm test:parallels:npm-update` passes, trust the mismatch as a standalone ref-onboard ordering bug first; the npm-update helper does not re-run ref-mode onboard on the same guest.
- Keep onboarding and status output ASCII-clean in logs; fancy punctuation becomes mojibake in current capture paths.
- If you hit an older run with `rc=255` plus an empty `fresh.install-main.log` or `upgrade.install-main.log`, treat it as a likely `prlctl exec` transport drop after guest start-up, not immediate proof of an npm/package failure.
- If WSL features are enabled but `wsl.exe --version` fails, rerun `prepare`; the inbox features and the signed WSL package are separate prerequisites. If the default reverts to 1, set `wsl.exe --set-default-version 2` and rerun `verify`.
- If `winget` detaches or prints nothing over `prlctl`, call it through `cmd.exe /d /s /c`. Avoid remote UAC: download as the desktop user, then let the controller verify the trusted manifest hash/publisher and install from its protected SYSTEM staging directory.
- If snapshot restore reports incompatible saved CPU state, make a power-off replacement snapshot from the known-good disk state and use its exact name. Never bypass snapshot restore for a two-lane fresh+upgrade claim.
- If baseline verification reports OpenClaw state, restore `clean` or remove the product state deliberately; never bless a dirty guest. Check `%APPDATA%` and `%LOCALAPPDATA%` for both stable and dev companion identities plus Inno uninstall registration.
- Long Windows installers can remain quiet while healthy. Inspect `tasklist` and installer/MSI logs before declaring a hang; keep long operations behind a background runner with short host-bounded polling calls.
