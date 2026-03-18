# Upgrading OpenClaw

The `extensions/commonly/` directory is self-contained — it has no imports from `src/channels/commonly/` (which no longer exists) or from any other Commonly-custom code in `src/`. This means upgrading OpenClaw to a newer release only requires replacing the core `src/` tree.

## Upgrade steps

1. **Clone or download the new OpenClaw release:**
   ```bash
   git clone https://github.com/openclaw/openclaw /tmp/openclaw-new
   # or: download and extract the release tarball
   ```

2. **Replace `_external/clawdbot/` with the new release, preserving our extension:**
   ```bash
   # From the commonly repo root
   rsync -av --exclude='extensions/commonly/' \
     /tmp/openclaw-new/ \
     _external/clawdbot/
   ```
   Alternatively, copy everything except `extensions/commonly/` manually.

3. **Re-install dependencies:**
   ```bash
   cd _external/clawdbot
   pnpm install
   ```

4. **Check for plugin-SDK breaking changes:**
   Open `src/plugin-sdk/index.ts` and verify that the interfaces used by our extension still exist:
   - `OpenClawPluginApi` — used in `extensions/commonly/index.ts`
   - `ChannelPlugin`, `ReplyPayload` — used in `extensions/commonly/src/channel.ts`
   - `buildChannelConfigSchema`, `createReplyPrefixContext`, `DEFAULT_ACCOUNT_ID` — used in `extensions/commonly/src/channel.ts`
   - `jsonResult`, `readNumberParam`, `readStringParam` — used in `extensions/commonly/src/tools.ts`

   Also check `src/agents/tools/common.ts` still exports `AnyAgentTool`, `readStringArrayParam` (imported by `extensions/commonly/src/tools.ts`).

5. **Run tests:**
   ```bash
   cd _external/clawdbot
   pnpm test
   ```
   If `extensions/commonly/` tests pass, the extension is compatible with the new version.

6. **Commit:**
   ```bash
   git add _external/clawdbot/
   git commit -m "[commonly] Upgrade OpenClaw to vXXXX.X.X"
   ```

## What lives where

| Location | Owner | Touches upstream upgrade? |
|---|---|---|
| `extensions/commonly/` | Commonly team | No — excluded from upgrade |
| `src/` (everything else) | OpenClaw upstream | Yes — replaced wholesale |

## Build prerequisites

Before running `gcloud builds submit`, ensure:

1. **a2ui bundle** — run `pnpm canvas:a2ui:bundle` locally (generates `src/canvas-host/a2ui/a2ui.bundle.js`). The bundle is gitignored but the `.gcloudignore` keeps it in the build context.
2. **Template files** — `docs/reference/templates/IDENTITY.md` and `USER.md` must exist locally. They are gitignored globally but the `.gcloudignore` negates that exclusion for the template directory. Create minimal versions if missing from a fresh clone.

## Known breaking changes by version

### v2026.2.26
- **`socket.io-client` dep required** — must be declared in root `package.json` (`^4.8.3`). Previously it was only used inside `src/channels/commonly/` which compiled into the main bundle.
- **`gateway.controlUi` origin check** — non-loopback gateway mode now requires either `allowedOrigins` or `dangerouslyAllowHostHeaderOriginFallback: true` in `gateway.controlUi` inside `/state/moltbot.json` (the gateway reads the PVC copy, not the ConfigMap). The provisioner (`agentProvisionerServiceK8s.js`) handles this automatically via `provisionOpenClawAccount` and `syncAccountToStateMoltbot`.
- **Workspace templates required** — `docs/reference/templates/IDENTITY.md` and `USER.md` must be present in the image; the gateway crashes on first agent workspace init if they are missing.

## Pushing to Team-Commonly/openclaw fork

`_external/clawdbot/` has no `.git` directory — it's tracked by the `commonly` monorepo. The fork lives at `github.com/Team-Commonly/openclaw`. After applying changes in the monorepo, sync them to the fork using a rebase (not a squash) so the fork's history remains aligned with upstream.

```bash
git clone git@github.com:Team-Commonly/openclaw.git /tmp/openclaw-fork
cd /tmp/openclaw-fork
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch upstream

# Rebase all Commonly-specific commits onto the upstream release tag
git rebase v<new-version>
# Conflicts in src/ → take HEAD (upstream): git checkout --ours src/... && git add src/...
# Conflicts in extensions/commonly/ → take incoming (our code)

# Apply new Commonly commits on top (rsync from _external/clawdbot/ per-file or per-section)
# Then force-push
git push --force-with-lease origin main
rm -rf /tmp/openclaw-fork
```

**Rules:**
- Never squash upstream commits — preserve the full upstream history
- `src/` conflicts during rebase: always take HEAD (monorepo uses pure upstream src/)
- Run `pnpm canvas:a2ui:bundle` before each `gcloud builds submit` (sources change between upstream releases)

## Upstream repository

`https://github.com/openclaw/openclaw`
Fork: `https://github.com/Team-Commonly/openclaw`
