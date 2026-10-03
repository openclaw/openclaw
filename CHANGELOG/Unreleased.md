## Unreleased

### Changes

- Plugins/Tools: tools can declare `canDeliverSourceReply` and return the finished reply in `details.sourceReply`; OpenClaw delivers it to the current conversation, records it as the assistant turn, and ends the tool batch on both the embedded runtime and the Codex harness, so a tool that already wrote the answer no longer costs a second model turn. Thanks @mbelinky.
