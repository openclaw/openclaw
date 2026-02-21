# 2026-02-21 Autonomy & Avatar Setup

## 概要

auto-agent（自律インターネットアクセス）の有効化、アバターウィンドウの確認・修正、
config.json のセキュリティ整合を実施した。

---

## 変更内容

### 1. config.json 更新 (`~/.openclaw/config.json`)

**Gateway トークン更新**

```diff
- "token": "test-token-autonomy"
+ "token": "kUyymC6zOuDa41H0KEcVZILRScO2vJ7Z95cPBX2jF9GAy0BO7y08NKFEgFn22BZ"
```

**auto-agent プラグイン有効化**

```json
"auto-agent": {
  "enabled": true,
  "config": {
    "enabled": true,
    "checkIntervalMs": 60000,
    "selfHealing": true,
    "autoRollback": true,
    "gitAutoCommit": false,
    "webSearch": { "enabled": true, "provider": "brave" }
  }
}
```

**plugins.allow / entries の整合修正**

- `vrchat`（extensions/vrchat/ が空ディレクトリ）をallow・entriesから除外
- `vrchat-relay`・`memory-core`・`llm-task`（entry file不在）も同様除外
- 実体ある有効プラグイン: `discord`, `line`, `talk-voice`, `voice-call`, `auto-agent`

---

### 2. extensions/auto-agent/index.ts [NEW]

`extensions/auto-agent/` に実体コードが不在だったため新規作成。

- `/auto-agent status` — 設定・BRAVE_API_KEY有無を表示
- `/auto-agent enable` / `disable` — 自律モードの切り替え
- `process.env.BRAVE_API_KEY` チェックをUIに表示

### 3. extensions/auto-agent/package.json [NEW]

プラグインを発見できるよう `openclaw.extensions` フィールドで `index.ts` を登録。

---

### 4. scripts/avatar-window.html [確認済み・実装完了]

`HakuaAvatar.lnk` → `scripts/start-avatar.bat` → Edge/Chrome appモードで
`scripts/avatar-window.html` を起動する構成を確認。

`avatar-window.html` は既に完全実装済み:

- Three.js `FBXLoader` で `assets/NFD/Hakua/FBX/Hakua.fbx`（14MB）をロード
- `OrbitControls` でカメラ操作可能
- SBV2 `http://localhost:5000` の死活監視 (10秒間隔)
- FBX読み込み失敗時のプレースホルダーBox表示

---

## 検証結果

| チェック                | 結果                                      |
| ----------------------- | ----------------------------------------- |
| `openclaw plugins list` | ✅ exit 0、Auto Agent 認識                |
| Gatewayトークン         | ✅ 更新済み                               |
| auto-agent config       | ✅ webSearch.enabled:true, provider:brave |
| talk-voice (SBV2)       | ✅ 設定済み (要SBV2サーバー起動)          |
| voice-call              | ✅ enabled, mock provider                 |
| FBX アセット            | ✅ 14MB 存在確認                          |
| avatar-window.html      | ✅ Three.js FBX実装完了                   |

---

## 残作業（ユーザー手動対応）

| #   | タスク             | 手順                                                  |
| --- | ------------------ | ----------------------------------------------------- |
| 1   | BRAVE_API_KEY取得  | https://brave.com/search/api/ → `.env`に設定          |
| 2   | SBV2起動テスト     | `Desktop\SBV2-TTS.lnk` → `http://localhost:5000` 確認 |
| 3   | アバターテスト     | `Desktop\HakuaAvatar.lnk` ダブルクリック              |
| 4   | OpenClaw起動テスト | `Desktop\OpenClaw.lnk` ダブルクリック                 |

---

## 関連ファイル

- `~/.openclaw/config.json` — メイン設定
- `extensions/auto-agent/index.ts` — 新規作成
- `extensions/auto-agent/package.json` — 新規作成
- `scripts/avatar-window.html` — 実装確認
- `scripts/start-avatar.bat` — `HakuaAvatar.lnk` のターゲット
