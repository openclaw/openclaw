# @claworks/sdk

ClaWorks Extension Pack SDK（初版）。

```typescript
import { definePackManifest, definePlaybookDraft } from "@claworks/sdk";

export const manifest = definePackManifest({
  id: "my-pack",
  name: "My Pack",
  version: "1.0.0",
  license: "MIT",
  provides: { objectTypes: [], playbooks: [], actionTypes: [] },
});
```

Pack 目录布局见 `docs/design/REPO-STRUCTURE.md`。
