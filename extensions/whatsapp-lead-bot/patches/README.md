# Baileys Patches

## @whiskeysockets+baileys+7.0.0-rc.9.patch

**Fix for WhatsApp label sync issue (#2418)**

### Problem
Labels applied via Baileys `addChatLabel` / `removeChatLabel` don't sync to other linked devices (primary phone). Other operations (archive, pin, mute) sync correctly.

### Root Cause
Label operations use `type: 'regular'` in the app state sync patch, while operations that DO sync correctly use `type: 'regular_low'`.

### Fix
Changed all label-related operations to use `type: 'regular_low'` to match the sync priority pattern used by working operations:

- `addLabel` (label creation)
- `addChatLabel` (apply label to chat)
- `removeChatLabel` (remove label from chat)
- `addMessageLabel` (apply label to message)
- `removeMessageLabel` (remove label from message)

### Side Effects
Also changed `quickReply` and `disableLinkPreviews` to `regular_low` since they were using `regular` as well.

### Testing
After applying this patch:
1. Restart the OpenClaw gateway to pick up the patched Baileys
2. Create a label via `create_label` tool
3. Apply it to a chat via `add_chat_label` tool
4. Check WhatsApp Business app on your primary phone - the label should now be visible

### Upstream
This is a local workaround until https://github.com/WhiskeySockets/Baileys/issues/2418 is resolved upstream.

### Maintenance
The patch is automatically applied on `npm install` via the `postinstall` script in `package.json`.

To regenerate the patch after manual edits to `node_modules/@whiskeysockets/baileys`:
```bash
npx patch-package @whiskeysockets/baileys
```
