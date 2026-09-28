# OpenClaw Feishu/Lark

Official OpenClaw channel plugin for Feishu and Lark workplace chats. Community maintained by @m1heng.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/feishu
```

Configure the Feishu/Lark app credentials in OpenClaw, then connect the plugin to the chats where agents should receive and send messages.

## Plugin card callbacks

Plugins can register a Feishu interactive handler with `api.registerInteractiveHandler`
and a namespace, such as `expense-form`. Put the existing structured action envelope
in the card element's callback value:

```json
{
  "oc": "ocf1",
  "k": "button",
  "a": "expense-form:save",
  "c": { "u": "ou_example", "h": "oc_example" }
}
```

The handler receives `FeishuInteractiveHandlerContext` (exported from this package's
`api`): the account, conversation, sender, original message ID, chat type, and
`callback` with `data`, `namespace`, `payload`, and `action`. The action retains
`form_value`, `input_value`, `name`, `option`, and `options` when present. Submitted
fields must total at most 64 KiB when JSON-encoded as UTF-8; invalid or oversized
submissions are rejected together. Text, empty strings, and selection values are
preserved without interpreting them as commands.

Callbacks require original message and chat IDs, successful chat metadata lookup,
and the account's normal DM or group admission and sender policy. A click does not
start pairing or require an additional group mention. Plugins must still validate
their own stored card binding, permitted operation, and current business authority
before writing data. An unmatched structured button is rejected; it never becomes
a model turn. Existing quick commands and approval actions keep their normal paths.

This inbound integration does not change the native card renderer's supported
elements. Plugins that need forms can send cards through the Feishu API using
their existing authorized client.
