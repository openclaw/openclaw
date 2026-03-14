# Feishu Extension

## Image Message Support

Send images to Feishu chats:

```typescript
import { sendImageFeishu } from '@openclaw/feishu';

await sendImageFeishu({
  cfg,
  to: 'chat:oc_xxx',
  imagePath: '/path/to/image.jpg',
});
```

Supports: JPG, PNG (max 20MB)

