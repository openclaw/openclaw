---
summary: "オンボーディングウィザードおよび設定スキーマ向けの RPC プロトコルに関する注記"
read_when: "オンボーディングウィザードの手順または設定スキーマのエンドポイントを変更する場合"
title: "オンボーディングと設定プロトコル"
---

# オンボーディング + 設定プロトコル

目的: CLI、macOS アプリ、Web UI 全体で共有されるオンボーディングおよび設定のサーフェスを提供します。

## コンポーネント

- ウィザードエンジン（共有セッション+プロンプト+オンボーディング状態）
- CLI のオンボーディングは UI クライアントと同一のウィザードフローを使用します。
- Gateway RPC（リモートプロシージャコール）がウィザードおよび設定スキーマのエンドポイントを公開します。
- macOS のオンボーディングはウィザードのステップモデルを使用します。
- Web UI は JSON Schema と UI ヒントから設定フォームをレンダリングします。

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

レスポンス（形状）

- ウィザード: `{ sessionId, done, step?, status?, error? }`
- 設定スキーマ: `{ schema, uiHints, version, generatedAt }`

## UI ヒント

- `uiHints` はパスでキー付けされます。オプションのメタデータ（label/help/group/order/advanced/sensitive/placeholder）を含みます。
- 機密フィールドはパスワード入力としてレンダリングされます。リダクション（マスキング）レイヤーはありません。
- 未対応のスキーマノードは生の JSON エディターにフォールバックします。

## 注記

- 本ドキュメントは、オンボーディングおよび設定に関するプロトコルのリファクタリングを追跡するための単一の参照点です。
