# IMAP Email Trigger

Let new email trigger a restricted OpenClaw reader agent. The plugin watches an
existing IMAP mailbox, checks allowed senders and sender authentication, and
starts an isolated session for each accepted message. It reads incoming mail;
it does not send replies or process the mailbox's existing messages on first
startup.

## Sender authentication

DMARC policy discovery and relaxed alignment follow the RFC 9989 DNS Tree Walk.
A parent-domain signature does not authenticate a subdomain when the parent
publishes no DMARC policy. Senders affected by this change should publish the
appropriate DMARC policy or sign with the sender domain; do not lower the
configured authentication requirement to compensate. Sender-bound tokens and
explicitly configured trusted authentication headers keep their existing rules.
Check affected senders before upgrading: permanently rejected messages advance
the mailbox cursor and are recorded as skipped, so repairing DNS later does not
automatically replay those messages.

## Get started

Prepare a restricted reader agent with an authenticated model and working
sandbox. Configure the mailbox credentials, sender allowlist, authentication
policy, and reader agent under the plugin's account settings, then enable IMAP.

Passwords must resolve to strings. Malformed credentials are rejected; an unresolved
secret reference leaves only its account unavailable while other accounts can start.

Follow the [IMAP setup guide](https://docs.openclaw.ai/automation/imap) for the
reader configuration, credential storage, and verification steps.
