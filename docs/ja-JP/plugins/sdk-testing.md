---
read_when:
    - プラグインのテストを書いている場合
    - プラグインSDKのテストユーティリティが必要な場合
    - バンドルプラグインのコントラクトテストについて理解したい場合
sidebarTitle: Testing
summary: OpenClaw プラグインのテストユーティリティとパターン
title: プラグインSDK テスト
x-i18n:
    generated_at: "2026-04-02T08:36:38Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 49ddd2c211059612f7b75fd8ecbd3bc19221ac549ab1906a22374a64f54f2bfe
    source_path: plugins/sdk-testing.md
    workflow: 15
---

# プラグインSDK テスト

OpenClaw プラグインのテストユーティリティ、パターン、およびlint適用に関するリファレンスです。

<Tip>
  **テスト例をお探しですか？** ハウツーガイドにテスト例が含まれています:
  [チャネルプラグインのテスト](/plugins/sdk-channel-plugins#step-6-test) および
  [プロバイダープラグインのテスト](/plugins/sdk-provider-plugins#step-6-test)。
</Tip>

## テストユーティリティ

**インポート:** `openclaw/plugin-sdk/testing`

testing サブパスは、プラグイン作成者向けに限定されたヘルパーセットをエクスポートします:

```typescript
import {
  installCommonResolveTargetErrorCases,
  shouldAckReaction,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/testing";
```

### 利用可能なエクスポート

| エクスポート                             | 用途                                                    |
| -------------------------------------- | ------------------------------------------------------ |
| `installCommonResolveTargetErrorCases` | ターゲット解決のエラーハンドリング用の共有テストケース         |
| `shouldAckReaction`                    | チャネルが確認リアクションを追加すべきかチェックする            |
| `removeAckReactionAfterReply`          | 返信配信後に確認リアクションを削除する                       |

### 型

testing サブパスは、テストファイルで便利な型も再エクスポートします:

```typescript
import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
  PluginRuntime,
  RuntimeEnv,
  MockFn,
} from "openclaw/plugin-sdk/testing";
```

## ターゲット解決のテスト

`installCommonResolveTargetErrorCases` を使用して、チャネルのターゲット解決に対する標準的なエラーケースを追加します:

```typescript
import { describe } from "vitest";
import { installCommonResolveTargetErrorCases } from "openclaw/plugin-sdk/testing";

describe("my-channel target resolution", () => {
  installCommonResolveTargetErrorCases({
    resolveTarget: ({ to, mode, allowFrom }) => {
      // Your channel's target resolution logic
      return myChannelResolveTarget({ to, mode, allowFrom });
    },
    implicitAllowFrom: ["user1", "user2"],
  });

  // Add channel-specific test cases
  it("should resolve @username targets", () => {
    // ...
  });
});
```

## テストパターン

### チャネルプラグインの単体テスト

```typescript
import { describe, it, expect, vi } from "vitest";

describe("my-channel plugin", () => {
  it("should resolve account from config", () => {
    const cfg = {
      channels: {
        "my-channel": {
          token: "test-token",
          allowFrom: ["user1"],
        },
      },
    };

    const account = myPlugin.setup.resolveAccount(cfg, undefined);
    expect(account.token).toBe("test-token");
  });

  it("should inspect account without materializing secrets", () => {
    const cfg = {
      channels: {
        "my-channel": { token: "test-token" },
      },
    };

    const inspection = myPlugin.setup.inspectAccount(cfg, undefined);
    expect(inspection.configured).toBe(true);
    expect(inspection.tokenStatus).toBe("available");
    // No token value exposed
    expect(inspection).not.toHaveProperty("token");
  });
});
```

### プロバイダープラグインの単体テスト

```typescript
import { describe, it, expect } from "vitest";

describe("my-provider plugin", () => {
  it("should resolve dynamic models", () => {
    const model = myProvider.resolveDynamicModel({
      modelId: "custom-model-v2",
      // ... context
    });

    expect(model.id).toBe("custom-model-v2");
    expect(model.provider).toBe("my-provider");
    expect(model.api).toBe("openai-completions");
  });

  it("should return catalog when API key is available", async () => {
    const result = await myProvider.catalog.run({
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      // ... context
    });

    expect(result?.provider?.models).toHaveLength(2);
  });
});
```

### プラグインランタイムのモック

`createPluginRuntimeStore` を使用するコードの場合、テストでランタイムをモックします:

```typescript
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore<PluginRuntime>("test runtime not set");

// In test setup
const mockRuntime = {
  agent: {
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent"),
    // ... other mocks
  },
  config: {
    loadConfig: vi.fn(),
    writeConfigFile: vi.fn(),
  },
  // ... other namespaces
} as unknown as PluginRuntime;

store.setRuntime(mockRuntime);

// After tests
store.clearRuntime();
```

### インスタンスごとのスタブによるテスト

プロトタイプの変更よりもインスタンスごとのスタブを使用してください:

```typescript
// Preferred: per-instance stub
const client = new MyChannelClient();
client.sendMessage = vi.fn().mockResolvedValue({ id: "msg-1" });

// Avoid: prototype mutation
// MyChannelClient.prototype.sendMessage = vi.fn();
```

## コントラクトテスト（リポジトリ内プラグイン）

バンドルプラグインには、登録の所有権を検証するコントラクトテストがあります:

```bash
pnpm test -- src/plugins/contracts/
```

これらのテストは以下を検証します:

- どのプラグインがどのプロバイダーを登録するか
- どのプラグインがどの音声プロバイダーを登録するか
- 登録の形状の正確性
- ランタイムコントラクトの準拠性

### スコープ付きテストの実行

特定のプラグインの場合:

```bash
pnpm test -- <bundled-plugin-root>/my-channel/
```

コントラクトテストのみの場合:

```bash
pnpm test -- src/plugins/contracts/shape.contract.test.ts
pnpm test -- src/plugins/contracts/auth.contract.test.ts
pnpm test -- src/plugins/contracts/runtime.contract.test.ts
```

## lint の適用（リポジトリ内プラグイン）

リポジトリ内プラグインに対して `pnpm check` で3つのルールが適用されます:

1. **モノリシックなルートインポートの禁止** -- `openclaw/plugin-sdk` ルートバレルは拒否されます
2. **直接の `src/` インポートの禁止** -- プラグインは `../../src/` を直接インポートできません
3. **セルフインポートの禁止** -- プラグインは自身の `plugin-sdk/<name>` サブパスをインポートできません

外部プラグインはこれらのlintルールの対象外ですが、同じパターンに従うことを推奨します。

## テスト設定

OpenClaw は V8 カバレッジ閾値付きの Vitest を使用しています。プラグインテストの場合:

```bash
# Run all tests
pnpm test

# Run specific plugin tests
pnpm test -- <bundled-plugin-root>/my-channel/src/channel.test.ts

# Run with a specific test name filter
pnpm test -- <bundled-plugin-root>/my-channel/ -t "resolves account"

# Run with coverage
pnpm test:coverage
```

ローカル実行でメモリ負荷が発生する場合:

```bash
OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test
```

## 関連

- [SDK 概要](/plugins/sdk-overview) -- インポート規約
- [SDK チャネルプラグイン](/plugins/sdk-channel-plugins) -- チャネルプラグインのインターフェース
- [SDK プロバイダープラグイン](/plugins/sdk-provider-plugins) -- プロバイダープラグインのフック
- [プラグインの構築](/plugins/building-plugins) -- はじめにガイド
