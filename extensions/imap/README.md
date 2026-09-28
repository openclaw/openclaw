# IMAP Email Trigger

Let new email trigger a restricted OpenClaw reader agent. The plugin watches an
existing IMAP mailbox, checks allowed senders and sender authentication, and
starts an isolated session for each accepted message. It reads incoming mail;
it does not send replies or process the mailbox's existing messages on first
startup.

## Get started

Prepare a restricted reader agent with an authenticated model and working
sandbox. Configure the mailbox credentials, sender allowlist, authentication
policy, and reader agent under the plugin's account settings, then enable IMAP.

Follow the [IMAP setup guide](https://docs.openclaw.ai/automation/imap) for the
reader configuration, credential storage, and verification steps.
