# OpenClaw Slack

Official OpenClaw channel plugin for Slack channels, DMs, commands, and app events.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/slack
```

Configure the Slack app credentials and allowed workspaces/channels in OpenClaw. The plugin lets agents receive Slack events and reply through the configured Slack app.

## Fork a channel thread

Inside an existing public or private channel thread, send an ordinary message:

```text
@OpenClaw /fork [title]
```

The optional single-line title (up to 3000 characters) becomes the new root message, not a Slack thread title. OpenClaw copies the conversation into an independent session, posts a new top-level root in the **same channel**, binds that root to the copied session, and posts up to three recent visible text excerpts in the new thread. Continue through the returned Slack link. The channel audience is unchanged; a fork does not create a private conversation. Titles and excerpts are literal text, with mentions, link parsing, and unfurls disabled.

Slack custom slash commands cannot run inside threads. Use the ordinary message above, not `/openclaw fork` or a top-level `/fork`. Top-level messages (including synthetic reply targets from `replyToMode: all`), ordinary and managed DMs, group DMs, source-less slash contexts, and Enterprise Grid/org installs are not supported. No last-active thread is inferred.

The selected account must already belong to the channel, have channel metadata and thread-history read access, and be able to post. Slack may require a user read token with `channels:history` or `groups:history` for `conversations.replies`; a missing permission is reported before creating a root. Existing channel, sender, mention, and participation policies still apply to subsequent replies. Binding changes routing, not who may participate.

If root creation is uncertain, OpenClaw does not retry it automatically. Check the named channel before sending a new request. If a root is confirmed but setup or recap delivery fails, the root and copied context are retained and the error reports what is known.
