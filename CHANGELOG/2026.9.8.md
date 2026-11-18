<!-- openclaw-docs-mirror-v1 {"version":"2026.9.8","sources":["docs/releases/2026.9.8.md"],"sourceDigest":"sha256:50daaf31c0d3c21e6b6f32227a383023952fb57af0c774f98e0a7028073b53eb"} -->

## 2026.9.8


### v2026.9.8

For formatted release notes, [read this release on the docs site](https://docs.openclaw.ai/releases/2026.9.8).

OpenClaw 2026.9.8 fixes missing replies between agents, reduces memory use when running many Codex agents, and addresses failed updates and Windows startup problems.

**Release scale:** 43 pull requests, 12 direct commits, and 8 contributors.

#### Web UI

- **Browser tabs after updates.** If you leave OpenClaw's bundled web interface open during an update, the tab can keep loading views using its older files. Those files are only kept temporarily, so older tabs may still need a reload; see the [retention limits](https://docs.openclaw.ai/web/control-ui/development). [#163478](https://github.com/openclaw/openclaw/pull/163478), backporting [#163090](https://github.com/openclaw/openclaw/pull/163090) and [#163099](https://github.com/openclaw/openclaw/pull/163099), with contributions from [@vincentkoc](https://github.com/vincentkoc).
- **Session assignment.** Moving the pointer over “Assign to…” and then pressing Enter now opens the menu without accidentally assigning the session to someone. [#163467](https://github.com/openclaw/openclaw/pull/163467), backporting [#161393](https://github.com/openclaw/openclaw/pull/161393), coauthored by [@RomneyDa](https://github.com/RomneyDa) and [@vincentkoc](https://github.com/vincentkoc).
- **Silent-reply help.** Help text in 20 existing languages now explains where an agent can stay silent. Silence settings apply to group chats; direct chats and work requested inside OpenClaw require a reply. [#163409](https://github.com/openclaw/openclaw/pull/163409), using translations from [#162942](https://github.com/openclaw/openclaw/pull/162942), with contributions from [@vincentkoc](https://github.com/vincentkoc).

#### Updates and Maintenance

- <a id="update-recovery-sources"></a>**Update recovery.** Repairing an update now keeps the plugins you allowed and enabled. A fresh Doctor run can finish pending upgrade confirmations and clear warnings for completed work. For Windows 2026.9.4 recovery, back up first and follow the [separate-terminal recovery instructions](https://docs.openclaw.ai/cli/update), using the original service account and installation settings. [#162959](https://github.com/openclaw/openclaw/pull/162959), backported by [@RomneyDa](https://github.com/RomneyDa), with work by [@VACInc](https://github.com/VACInc), [@obviyus](https://github.com/obviyus) and [@ericcaiwx-star](https://github.com/ericcaiwx-star).
- <a id="platform-update-sources"></a>**Windows updates.** If Windows briefly reports that installation files are in use, the updater retries. If it still cannot replace them, it leaves the installed package in place. An older updater cannot gain this fix mid-update; follow the [update guidance](https://docs.openclaw.ai/cli/update) if the first upgrade fails. [#163074](https://github.com/openclaw/openclaw/pull/163074), backported by [@RomneyDa](https://github.com/RomneyDa), with work by [@fuller-stack-dev](https://github.com/fuller-stack-dev) and [@obviyus](https://github.com/obviyus).
- **macOS updates.** Updating through npm now handles two different paths to the same installation, including the moment when npm has removed the old files but not yet replaced them. [#163481](https://github.com/openclaw/openclaw/pull/163481), backporting [#163479](https://github.com/openclaw/openclaw/pull/163479), with work by [@vincentkoc](https://github.com/vincentkoc).
- **Starting OpenClaw.** Starting directly or in a container now prevents two copies from using the same saved data at once. Windows startup also avoids getting stuck when a cache folder's path is too long. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#update-recovery-sources).
- **Stopping OpenClaw.** Shutdown can finish when memory synchronization has no work to do, while still allowing a write already underway to finish. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#platform-update-sources).
- **Database maintenance.** Maintenance retries when another operation briefly has the database busy. [Update rehearsals](https://docs.openclaw.ai/install/updating) avoid unnecessary database copies and keep each record's ID unchanged. [Update recovery sources and credits](https://docs.openclaw.ai/releases/2026.9.8#update-recovery-sources), [platform update sources and credits](https://docs.openclaw.ai/releases/2026.9.8#platform-update-sources).
- **Changing connection settings.** Work already underway can finish when you [change connection settings](https://docs.openclaw.ai/gateway/configuration/hot-reload), provided the user still has access. Removing access still stops that work. Changing the sign-in method or how OpenClaw listens for connections still needs a restart; see the [proxy setup guidance](https://docs.openclaw.ai/gateway/trusted-proxy-auth). [#163174](https://github.com/openclaw/openclaw/pull/163174), backported by [@RomneyDa](https://github.com/RomneyDa) from [#160909](https://github.com/openclaw/openclaw/pull/160909).

#### Messaging

- **Replies between agents.** When an agent asks another for help, the result comes back to the requester once. [Work inside OpenClaw](https://docs.openclaw.ai/concepts/messages) must return a result or keep working instead of ending silently. Custom workflows must handle returned results and request follow-up messages explicitly; `REPLY_SKIP` and `ANNOUNCE_SKIP` no longer hide replies. [Doctor updates the old settings](https://docs.openclaw.ai/gateway/doctor/config-migrations), preserving silence in group chats. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#platform-update-sources).
- **Replies after reloads and wake.** Fixed a case where a channel looked connected after a reload or waking the computer, but could no longer send replies. The problem was reported with Matrix. [#163504](https://github.com/openclaw/openclaw/pull/163504), backporting [#163268](https://github.com/openclaw/openclaw/pull/163268). Thanks to upstream author [@scotthuang](https://github.com/scotthuang) and contributor [@vincentkoc](https://github.com/vincentkoc).
- **Telegram cleanup.** Doctor can move confirmed-empty files left over from old Telegram connections into an archive. It leaves nonempty or uncertain files for review and keeps the originals if the move fails. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#update-recovery-sources).
- **Telegram previews.** Fixed late edits to a Telegram reply preview from a task that had already been replaced. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#update-recovery-sources).

#### Skills

- **Refreshing skills.** On Unix-based systems, skills copied from a read-only installation can now be refreshed in sandboxed workspaces and Claude CLI sessions. The copied folders no longer block the refresh because they inherited the original's restrictions. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#update-recovery-sources).

#### Models and Providers

- **GPT-6.1 Sol.** Support for [GPT-6.1 Sol](https://docs.openclaw.ai/providers/openai/models) was still incomplete in this release. These changes prepared for it. [#161400](https://github.com/openclaw/openclaw/pull/161400), [#163132](https://github.com/openclaw/openclaw/pull/163132), backported by [@RomneyDa](https://github.com/RomneyDa).
- **Local models on Windows.** When required Microsoft files are missing, managed llama.cpp setup can add them beside your local model server so it can start. If startup still fails, rerun setup or configure a compatible server manually. [#163093](https://github.com/openclaw/openclaw/pull/163093) and its backport [#163128](https://github.com/openclaw/openclaw/pull/163128), both by [@RomneyDa](https://github.com/RomneyDa).
- **Codex memory use.** Running many [native Codex agents](https://docs.openclaw.ai/plugins/codex-harness) uses less duplicate memory. OpenClaw waits until an agent's conversation list is needed before starting the background process for that list, and shares settings where compatible. Memory used to track [saved shell environments](https://docs.openclaw.ai/tools/exec) is also limited. [Update recovery sources and credits](https://docs.openclaw.ai/releases/2026.9.8#update-recovery-sources), [platform update sources and credits](https://docs.openclaw.ai/releases/2026.9.8#platform-update-sources).
- **Anthropic background work.** Fixed cases where an Anthropic conversation got stuck or finished before results from background commands, other agents or workflows had been collected. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#update-recovery-sources).

#### Browser and Computer Use

- **Desktop app access.** If you use [Codex Computer Use](https://docs.openclaw.ai/plugins/codex-computer-use) with an API key, checking access to desktop apps no longer stops to ask for an unrelated browser sign-in. Controlling the browser still requires its own sign-in. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#windows-session-sources).

#### Security and Privacy

- **Local connection checks.** HTTPS checks that OpenClaw is running locally now follow the managed proxy settings and verify that the server's certificate matches the one you configured on every connection. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#update-recovery-sources).
- **Secrets in logs.** Fixed a case where secrets in long, unusually formatted log entries were not hidden when OpenClaw ran on Bun. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#platform-update-sources).

#### Other Bug Fixes

- <a id="windows-session-sources"></a>**Saved conversations on Windows.** Fixed an error that stopped Windows users from opening saved conversations or preparing scheduled agent tasks. [#162931](https://github.com/openclaw/openclaw/pull/162931), authored by [@RomneyDa](https://github.com/RomneyDa), backports [#160075](https://github.com/openclaw/openclaw/pull/160075) for [#157067](https://github.com/openclaw/openclaw/issues/157067) and [#159339](https://github.com/openclaw/openclaw/issues/159339). It also includes the desktop app access fix from [#162467](https://github.com/openclaw/openclaw/pull/162467) and clearer messages when diagnosing workspace recovery.
- **Repairing conversation history.** Repair no longer crashes when it follows a long chain of linked conversations. It preserves the history and keeps each transcript attached to the right session. [Sources and credits](https://docs.openclaw.ai/releases/2026.9.8#update-recovery-sources).

Thanks to [@ericcaiwx-star](https://github.com/ericcaiwx-star), [@fuller-stack-dev](https://github.com/fuller-stack-dev), [@obviyus](https://github.com/obviyus), [@Patrick-Erichsen](https://github.com/Patrick-Erichsen), [@RomneyDa](https://github.com/RomneyDa), [@scotthuang](https://github.com/scotthuang), [@VACInc](https://github.com/VACInc) and [@vincentkoc](https://github.com/vincentkoc) for their contributions across this release.

