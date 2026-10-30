## Unreleased

### Changes

- Telegram/actions: add `topic-delete` (Bot API `deleteForumTopic`) to the message tool, gated by both `channels.telegram.actions.editForumTopic` and `deleteMessage`, rejecting conflicting destination fields and refusing the General topic.

### Fixes

- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
