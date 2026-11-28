# Examples from OpenClaw's copy

**Existing** and **Before** quotations below are literal source text from commit `a564030a2b6e`. **After (proposed)** and **Proposed model** text records the workshop revisions, not changes already made to product copy. Source line ranges are pinned to that commit. Preserve them when improving an example.

Provider and model names in proposed samples are illustrative display names. The rate-limit examples assume fixture facts naming OpenAI, GPT-5.5, and a reset at 4:56 AM UTC. `{name}` and similar slots are filled by the code. Bracketed setting phrases are intended action labels, not verified capabilities or invented URLs. Their availability and destinations must be supplied and verified by the implementation.

## Models

### Error or failure message

Existing:

> Couldn’t start your camera. Close other apps using it, then try again.

`ui/src/i18n/locales/en-chat-camera.ts:28`. Names what failed, then one thing the reader can do without leaving the screen.

Existing:

> Couldn’t save this message. Free browser storage or reconnect to send it.

`ui/src/i18n/locales/en-chat-composer.ts:162`. Says what is at risk and the two actions that fix it.

Before (exact):

> Couldn’t update progress. Try again; your last plan is saved.

`ui/src/i18n/locales/en-chat-session-optional.ts:84`. Tells the reader what survived the failure.

After (proposed):

> Couldn’t update progress. Try again. Your last plan is saved.

Keeps the saved-work fact and splits the semicolon.

Existing:

> Couldn’t connect because the Gateway is busy. This page will retry automatically.

`ui/src/i18n/locales/en-login.ts:77`. Gives the cause with “because” and says that no action is needed.

Before (exact):

> Couldn’t verify the GitHub account because of a rate limit. Wait and try publishing again; you don’t need to reconnect.

`ui/src/i18n/locales/en-github.ts:152`. Names the cause and rules out the fix the reader would try next.

After (proposed):

> Couldn’t verify the GitHub account because of a rate limit. Wait and try publishing again. You don’t need to reconnect.

Names the cause, preserves recovery, and uses periods.

Existing:

> Couldn’t connect because this page’s address isn’t allowed. Ask an admin to allow it.

`ui/src/i18n/locales/en-login.ts:190`. The reader cannot fix this, so it says what is wrong and who can.

Before (exact):

> {provider} reports a billing problem

`ui/src/i18n/locales/en.ts:1557`. A provider-side problem gets the sentence only: who and what, no instructions.

After (proposed):

> OpenAI reported a billing problem with the account OpenClaw uses. Choose another model.

Proposed rendering of the billing cause with a verified provider display name. Offer switching only when available.

Before (exact):

> This reply stopped because the provider was signed out. Sign in again or choose another model.

`ui/src/i18n/locales/en.ts:1572`. Cause first; both next steps are on the screen where the message appears.

After (proposed):

> The account for OpenAI was removed. Sign in again.

Proposed account-wording update for provider_sign_in_removed. The cause-list owner must adopt it before callers use it.

Existing:

> Couldn’t complete this action. Try again.

`ui/src/i18n/locales/en.ts:1546`. Existing local action fallback. Keep its retry only where that action can safely work. Unknown run failures use the cause-list generic sentence without a blanket retry.

Existing:

> Another sign-in is still in progress. Wait a moment, then try again.

`src/agents/failover/user-copy.ts:51`. A chat-channel failure with no internal names and an instruction the reader can follow.

Before (exact):

> The provider cannot serve this model right now. Choose another model.

`src/agents/failover/assistant-request-failure-copy.ts:97`. Plain cause, then one step the reader can take from the chat.

After (proposed):

> OpenAI can’t serve GPT-5.5 right now. Choose another model.

Proposed rendering of route_unavailable, naming provider and model rather than “this model”.

### Empty state

Existing:

> No agents yet. Open Agents to add one.

`ui/src/i18n/locales/en-chat-command-results.ts:80`. States the empty fact, then the one place to change it.

Existing:

> No MCP servers yet. Add one to give the agent new tools.

`ui/src/i18n/locales/en-chat-composer-menu.ts:29`. Says why the reader would want one.

Existing:

> No learned skills yet. Your agent saves skills here as it learns from its work.

`ui/src/i18n/locales/en-skill-workshop.ts:37`. Explains how the list fills when the reader has nothing to do.

### Confirmation

Existing:

> Delete “{session}”?

`ui/src/i18n/locales/en-session-deletion.ts:6`. The title is the action as a question, with the thing named in curly quotes.

Existing:

> This deletes the automation and stops future activity. This can’t be undone.

`ui/src/i18n/locales/en-cron.ts:95`. What happens, then the one fact that makes the reader pause.

Before (exact):

> This deletes the session entry but keeps an archived copy of its chat history. Work on any attached device stops first.

`ui/src/i18n/locales/en-session-deletion.ts:8`. Says what goes, what stays, and what happens first.

After (proposed):

> This deletes the session but keeps an archived copy of its chat history. Work on any attached device stops first.

Drops the implementation word “entry” while keeping the retention and stop behavior.

Before (exact):

> OpenClaw removes the saved sign-in for {name}. Its tools stop working until you sign in again.

`ui/src/i18n/locales/en-plugin-management.ts:376`. Names the actor and the consequence the reader will notice later.

After (proposed):

> OpenClaw removes the account for {name}. Its tools stop working until you sign in again.

Names the stored connection as an account, not a saved sign-in.

### Status

Before (exact):

> Saving…

`ui/src/i18n/locales/en-settings.ts:1150`. One word and the ellipsis character for work in progress.

After (proposed):

> Saving

Copy-only ellipsis removal. Existing loading indication stays. Adding animation is separate UI work.

Before (exact):

> Device ready. Waiting for your app…

`ui/src/i18n/locales/en-portals.ts:15`. Reports the step that finished and the one in progress.

After (proposed):

> Device ready. Waiting for your app

The completed and waiting steps stay distinct. Removes punctuation only, not loading behavior.

Existing:

> API key saved.

`ui/src/i18n/locales/en-settings.ts:1200`. Names the thing that was saved, so the reader knows which action worked.

Before (exact):

> Reply stopped; plan saved

`ui/src/i18n/locales/en-chat-session-optional.ts:87`. Two facts in four words: what ended and what was kept.

After (proposed):

> Reply stopped. Plan saved.

Separates the two recorded facts with periods.

### Button or action label

Existing:

> Always allow

`ui/src/i18n/locales/en-approvals.ts:23`. Two words that say what the button does from now on.

Existing:

> Check again

`ui/src/i18n/locales/en-portals.ts:19`. A verb the reader would use, in sentence case.

Existing:

> Copy public link

`ui/src/i18n/locales/en-chat-session-sharing.ts:17`. Verb, then the name of the thing as the rest of the UI writes it.

Existing:

> Replace objective

`ui/src/i18n/locales/en-chat-goals.ts:35`. Repeats the verb of its dialog title (“Replace goal objective?”), so the button answers the question.

### Setting description

Existing:

> Let agents run commands and use tools on this device.

`ui/src/i18n/locales/en-devices.ts:201`. Says what turning it on allows, in the reader's terms.

Before (exact):

> Choose an image up to 2 MB. It will be resized for sessions and the sidebar.

`ui/src/i18n/locales/en-settings.ts:117`. Gives the limit as a number with its unit, then what happens to the image.

After (proposed):

> Choose an image up to 2 MB. It’s resized for sessions and the sidebar.

Keeps the limit and uses the present tense.

Before (exact):

> Cookies are only synced for these hostnames; an empty list means nothing is synced.

`ui/src/i18n/locales/en-settings.ts:1615`. States the rule and what the empty case means.

After (proposed):

> Cookies are only synced for these hostnames. An empty list means nothing is synced.

Applies the approved no-semicolon rule without changing the empty case.

Existing:

> Agents ask before commands the allowlist doesn’t cover.

`ui/src/i18n/locales/en-preferences.ts:106`. Describes the behavior the reader will see, not the mechanism.

### Short help text

Existing:

> Suggested message: {text}. Press Tab to use it, or Escape to dismiss. It won’t be sent automatically.

`ui/src/i18n/locales/en-chat-composer.ts:14`. Both keys and what each does, then the worry answered: it won’t send by itself.

Existing:

> The new token isn’t shown here because it belongs to another device.

`ui/src/i18n/locales/en-devices.ts:126`. Explains an absence the reader would otherwise report as a bug.

### Docs sentence or opening paragraph

Existing:

> A Template is that agent packaged so someone else can start with it. It carries the setup for the job and leaves your history behind.

`docs/concepts/agents-and-templates.md:14-15`. Defines the term by what it is, in words a first-time reader has.

Existing:

> OpenClaw starts with one agent, and one agent can do a wide range of work. A second agent is worth making when a piece of work stands apart:

`docs/concepts/agents-and-templates.md:22-23`. Gives the default before the alternative, and introduces its list with a colon.

Before (exact):

> OpenClaw remembers things by writing plain Markdown files in your agent's workspace (default `~/.openclaw/workspace`). The model only remembers what gets saved to disk; there is no hidden state.

`docs/concepts/memory.md:9-11`. Opens with how the feature works and closes the question a careful reader has.

After (proposed):

> OpenClaw remembers things by writing plain Markdown files in your agent's workspace (default `~/.openclaw/workspace`). The model only remembers what gets saved to disk. There is no hidden state.

Keeps the full explanation and replaces the semicolon with a period.

Existing:

> Multi-user mode lets several trusted people operate the same OpenClaw agent. It adds session ownership, participant history, live presence, and owner filtering. A team can then tell who started work, who is responsible for it now, and who has been involved.

`docs/concepts/multi-user.md:11`. An opening paragraph in three steps: what it is, what it adds, what the reader gets.

Existing:

> Everyone who can operate an agent can make it do anything that agent can do. Session ownership, visibility in the sidebar, and presence indicators are usability features, not security boundaries.

`docs/concepts/multi-user.md:15`. States the risk plainly, at the point where the reader could misjudge it.

## Pairs

The before quotations are evidence, not style recommendations. Proposed setting phrases below are rendered through the surface's link resolver. No live address is claimed here.

### Run-failure messages in chat channels

Before, `src/agents/failover/user-copy.ts:45`:

> ⚠️ The AI service needs a short break. Please try again in a few minutes.

After (proposed):

> OpenAI is rate limiting GPT-5.5 until 4:56 AM UTC. Send /model to choose another model, or [set up a fallback model].

What changed: Names and the deadline come from typed facts. Offers one chat action and one settings alternative. The original constant lacks these facts, so the caller and resolver must supply them. Omit the deadline when unknown.

Before, `src/agents/failover/user-copy.ts:47`:

> Couldn't sign in to the AI service. Sign in again under Models in the OpenClaw app or run `openclaw configure`.

After (proposed):

> OpenClaw couldn’t sign in to OpenAI. [Check the OpenAI account]

What changed: Names the provider and links to the OpenClaw account setting. The caller must supply the provider identity and a usable destination.

Before, `src/agents/failover/user-copy.ts:153`:

> Automatic rate-limit recovery is disabled${scope} for this session (retry.provider.maxRetries: 0).

After (proposed):

> OpenAI is rate limiting GPT-5.5, and automatic retries are turned off. Send /model to choose another model, or [turn on automatic retries].

What changed: Uses the recorded retry setting and a direct settings action. Provider and model names need typed identity from the caller.

Before, `src/agents/failover/user-copy.ts:337`:

> Message ordering conflict - please try again. If this persists, use /new to start a fresh session.

After (proposed):

> OpenAI couldn’t accept the messages in this chat. Try again, or send /new to start a new session.

What changed: Proposed cause-list wording for conversation_state_rejected. Naming OpenAI requires verified provider identity, not a guess from this string alone.

Before, `src/agents/failover/user-copy.ts:394`:

> ⚠️ OpenClaw couldn't finish this request. Check the conversation before trying again. For details, open Settings → Logs in the OpenClaw app or run `openclaw logs --follow`.

After (proposed):

> OpenClaw couldn’t finish this reply.

What changed: Unknown cause gets one generic sentence, without a command or raw detail.

Before, `src/agents/failover/assistant-request-failure-copy.ts:78`:

> The device runner is offline. Reconnect it, retry later, or bring the session back to this gateway.

After (proposed):

> The device this session runs on is offline.

What changed: Proposed cause-list wording for runner-offline. It names the device and leaves unavailable recovery actions out.

Before, `src/agents/failover/assistant-request-failure-copy.ts:68`:

> PostgreSQL canceled a database operation or its statement timed out. Check the conversation for completed work before trying again. If it happens again, ask the operator to check PostgreSQL timeouts and server activity.

After (proposed):

> This reply stopped because OpenClaw’s database took too long to respond.

What changed: Proposed wording for a detected database timeout. The old 57014 branch also covers cancellation. Classify those separately before using this sentence, otherwise it invents a timeout. Additional uncertain-work caution wording remains a separate decision.

Before, `src/agents/embedded-agent-runner/run/terminal-timeout.ts:70-71`:

> Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.

After (proposed):

> This reply took longer than the agent’s time limit. [Change the time limit]

What changed: Links to the agent time-limit setting instead of quoting a config key or sending the reader to docs. Retry is not offered when the same limit would stop it again.

### Control UI

Before, `ui/src/i18n/locales/en-new-session-setup.ts:246`:

> Session hosting is disabled. On the paired device, run openclaw config set nodeHost.workerRuns.enabled true, then openclaw node install --force.

After (proposed):

> The selected device isn’t set up to host sessions. [Set up session hosting](https://docs.openclaw.ai/nodes/session-hosting)

What changed: This fix is on the paired device, outside the Control UI. The existing session-hosting docs section explains it.

Before, `ui/src/i18n/locales/en-chat-composer-menu.ts:36`:

> Web search is off in Gateway config (tools.web.search.enabled). It can’t be turned on for a single session.

After (proposed):

> Web search is turned off for this Gateway. It can’t be turned on for a single session. [Open web search settings]

What changed: Links to the actual OpenClaw setting rather than docs. Show the settings action only to a reader who can use it.

Before, `ui/src/i18n/locales/en-activity.ts:244`:

> This connection does not have operator.read, so retained run identity cannot be loaded.

After (proposed):

> You need read access to inspect this run.

Proposed title: **Read access required**.

What changed: Names the required level without promoting it to admin access or exposing a raw scope name.

Before, `ui/src/i18n/locales/en-new-session-setup.ts:176`:

> The selected runner isn't ready yet. Try again in a moment.

After (proposed):

> The selected device isn’t ready yet. Try again in a moment.

What changed: “Runner” became “device”, and the apostrophe is curly.

Before, `ui/src/i18n/locales/en-openclaw-id-dialogs.ts:18`:

> Its node goes too: {device} stops running tools for your claw.

After (proposed):

> {device} also stops running tools for your Claw.

What changed: “Its node goes too” used an internal name to say what the rest of the sentence already says.

Before, `ui/src/i18n/locales/en-model-favorites.ts:10`:

> Could not load favorites. Retry.

After (proposed):

> Couldn’t load favorites. Try again.

What changed: Follows the “Couldn’t” followed by the action and “Try again.” pattern that about 400 strings use.

Before, `ui/src/i18n/locales/en-chat-session.ts:11`:

> Couldn’t change effort. Try again. {error}

After (proposed):

> Couldn’t change effort. Try again.

What changed: Keeps the page sentence plain. Useful sanitized evidence belongs in nested **Show details**, only when there is additional detail to show. The historical label at `ui/src/i18n/locales/en.ts:1545` was “Error details”.

Before, `ui/src/i18n/locales/en-portals.ts:23`:

> This gateway does not support portals.

After (proposed):

> This Gateway doesn’t support portals.

What changed: Gateway is capitalized, and the contraction matches the rest of the UI.

Before, `ui/src/i18n/locales/en-settings.ts:1063`:

> Couldn’t delete the profile. Reload the config and try again.

After (proposed):

> Couldn’t delete the profile. Reload settings and try again.

What changed: “Config” became “settings”, the word on the page the reader is looking at.

### Docs

Before, `docs/concepts/queue.md:11`:

> OpenClaw serializes inbound auto-reply runs (all channels) through a tiny in-process queue to prevent multiple agent runs from colliding, while still allowing safe parallelism across sessions.

After (proposed):

> OpenClaw runs one reply at a time in each session, on every channel, so two replies never collide. Different sessions still run at the same time.

What changed: Two plain statements in place of “serializes”, “in-process”, and “parallelism”, and “reply” for “auto-reply run”. The queue itself is an implementation detail that the “How it works” section already covers.

Before, `docs/gateway/troubleshooting.md:10`:

> This is the deep runbook. Start at [/help/troubleshooting](/help/troubleshooting) for the fast triage flow first.

After (proposed):

> This page lists the detailed Gateway troubleshooting pages. If you haven't narrowed the problem down yet, start with [General troubleshooting](/help/troubleshooting).

What changed: The link text names the destination page instead of showing its path, and the opening says what this page is.

Before, `docs/index.md:44`:

> Launch the browser dashboard for chat, config, and sessions.

After (proposed):

> Open the Control UI in your browser to chat, change settings, and manage sessions.

What changed: “Control UI” and “settings” are the glossary words, and the card's own title already says Control UI.

Before, `docs/web/dashboards.md:9-10`:

> Every thread in the Control UI can own a **dashboard** — a grid of live widgets your agent builds for you.

After (proposed):

> Every session in the Control UI can have a **dashboard**: a grid of live widgets your agent builds for you.

What changed: “Session” for “thread”, and a colon in place of the em dash.

Before, `docs/help/troubleshooting.md:9`:

> Triage front door. 2 minutes to a diagnosis, then jump to the deep page.

After (proposed):

> Start here when OpenClaw isn't working. The checks on this page take about 2 minutes and point you to the page for your problem.

What changed: Full sentences that say who the page is for and what it does, in place of two fragments and a metaphor.

Before, `docs/channels/pairing.md:13-14`:

> 1. **DM pairing** (who is allowed to talk to the bot)
>
> 2. **Node pairing** (which devices/nodes are allowed to join the gateway network)

After (proposed):

> 1. **DM pairing**: who is allowed to message your agent
>
> 2. **Device pairing**: which devices are allowed to connect to your Gateway

What changed: Glossary words: agent for “bot”, device for “node”, Gateway capitalized. Bold term, colon, description.

Still needed: The `openclaw nodes` command keeps its name; only the prose changes.

Before, `docs/concepts/memory.md:44-45`:

> If you want your agent to remember something, just ask it: "Remember that I prefer TypeScript." It writes the note to the appropriate file.

After (proposed):

> To have your agent remember something, ask it: "Remember that I prefer TypeScript." It writes the note to the appropriate file.

What changed: The filler “just” is gone, and the sentence opens with the reader's goal.
