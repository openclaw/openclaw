## Unreleased

- Telegram/actions: add `topic-delete` (Bot API `deleteForumTopic`) to the message tool, gated by both `channels.telegram.actions.editForumTopic` and `deleteMessage`, rejecting conflicting destination fields and refusing the General topic.
