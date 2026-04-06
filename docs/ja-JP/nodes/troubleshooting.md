---
read_when:
    - ノードは接続されているがカメラ/canvas/画面/execツールが失敗する場合
    - ノードペアリングと承認のメンタルモデルが必要な場合
summary: ノードのペアリング、フォアグラウンド要件、パーミッション、ツール障害のトラブルシューティング
title: ノードのトラブルシューティング
x-i18n:
    generated_at: "2026-04-02T07:46:29Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 2ac5de91d00842786add834ae4e0c61f6342baeb4ce5c4e2ebab86f4255808ac
    source_path: nodes/troubleshooting.md
    workflow: 15
---

# ノードのトラブルシューティング

ノードがステータスに表示されているがノードツールが失敗する場合に、このページを使用してください。

## コマンドラダー

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

次に、ノード固有のチェックを実行します:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

正常なシグナル:

- ノードが接続済みで、ロール `node` としてペアリングされている。
- `nodes describe` に呼び出そうとしているケイパビリティが含まれている。
- exec承認に期待されるモード/許可リストが表示されている。

## フォアグラウンド要件

`canvas.*`、`camera.*`、`screen.*` は iOS/Android ノードではフォアグラウンドのみです。

クイックチェックと修正:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

`NODE_BACKGROUND_UNAVAILABLE` が表示された場合は、ノードアプリをフォアグラウンドに切り替えてリトライしてください。

## パーミッションマトリックス

| ケイパビリティ               | iOS                                     | Android                                      | macOSノードアプリ             | 一般的な失敗コード             |
| ---------------------------- | --------------------------------------- | -------------------------------------------- | ----------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | カメラ（+ クリップ音声にはマイク）      | カメラ（+ クリップ音声にはマイク）           | カメラ（+ クリップ音声にはマイク） | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | 画面収録（+ マイクはオプション）        | 画面キャプチャプロンプト（+ マイクはオプション） | 画面収録                      | `*_PERMISSION_REQUIRED`        |
| `location.get`               | 使用中のみ または 常に許可（モードによる） | フォアグラウンド/バックグラウンドロケーション（モードによる） | 位置情報パーミッション        | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a（ノードホストパス）                 | n/a（ノードホストパス）                      | exec承認が必要                | `SYSTEM_RUN_DENIED`            |

## ペアリングと承認の違い

これらは異なるゲートです:

1. **デバイスペアリング**: このノードは Gateway ゲートウェイに接続できるか？
2. **Gateway ゲートウェイのノードコマンドポリシー**: RPCコマンドIDは `gateway.nodes.allowCommands` / `denyCommands` およびプラットフォームのデフォルトで許可されているか？
3. **exec承認**: このノードはローカルで特定のシェルコマンドを実行できるか？

クイックチェック:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

ペアリングが未完了の場合は、まずノードデバイスを承認してください。
`nodes describe` にコマンドが表示されない場合は、Gateway ゲートウェイのノードコマンドポリシーと、ノードが接続時にそのコマンドを実際に宣言したかどうかを確認してください。
ペアリングは問題ないが `system.run` が失敗する場合は、そのノードのexec承認/許可リストを修正してください。

ノードペアリングはID/信頼のゲートであり、コマンドごとの承認サーフェスではありません。`system.run` の場合、ノードごとのポリシーはそのノードのexec承認ファイル（`openclaw approvals get --node ...`）にあり、Gateway ゲートウェイのペアリングレコードにはありません。

## よくあるノードエラーコード

- `NODE_BACKGROUND_UNAVAILABLE` → アプリがバックグラウンドにあります。フォアグラウンドに切り替えてください。
- `CAMERA_DISABLED` → ノード設定でカメラトグルが無効になっています。
- `*_PERMISSION_REQUIRED` → OSパーミッションが未設定/拒否されています。
- `LOCATION_DISABLED` → ロケーションモードがオフです。
- `LOCATION_PERMISSION_REQUIRED` → リクエストされたロケーションモードが許可されていません。
- `LOCATION_BACKGROUND_UNAVAILABLE` → アプリがバックグラウンドですが、「使用中のみ」のパーミッションしかありません。
- `SYSTEM_RUN_DENIED: approval required` → execリクエストに明示的な承認が必要です。
- `SYSTEM_RUN_DENIED: allowlist miss` → 許可リストモードによりコマンドがブロックされています。
  Windowsノードホストでは、`cmd.exe /c ...` のようなシェルラッパー形式は、askフローで承認されない限り、許可リストモードでは許可リストミスとして扱われます。

## 高速リカバリーループ

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

それでも解決しない場合:

- デバイスペアリングを再承認する。
- ノードアプリを再度開く（フォアグラウンド）。
- OSパーミッションを再付与する。
- exec承認ポリシーを再作成/調整する。

関連:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
