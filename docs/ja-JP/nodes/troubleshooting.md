---
summary: "ノードのペアリング、フォアグラウンド要件、パーミッション、ツール障害のトラブルシューティング"
read_when:
  - ノードが接続されているが camera/canvas/screen/exec ツールが失敗するとき
  - ノードのペアリングと承認のメンタルモデルが必要なとき
title: "ノードのトラブルシューティング"
---

# ノードのトラブルシューティング

ノードがステータスで表示されているがノードツールが失敗する場合にこのページを使用してください。

## コマンドラダー

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

次にノード固有のチェックを実行します:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

正常なシグナル:

- ノードが接続されており、ロール `node` でペアリングされている。
- `nodes describe` に呼び出している機能が含まれている。
- Exec 承認に期待されるモード/許可リストが表示されている。

## フォアグラウンド要件

`canvas.*`、`camera.*`、`screen.*` は iOS/Android ノードでフォアグラウンドのみです。

クイックチェックと修正:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

`NODE_BACKGROUND_UNAVAILABLE` が表示された場合は、ノードアプリをフォアグラウンドに移動してリトライしてください。

## パーミッションマトリックス

| 機能                           | iOS                                     | Android                                       | macOS ノードアプリ             | 典型的な失敗コード             |
| ------------------------------ | --------------------------------------- | --------------------------------------------- | ------------------------------ | ------------------------------ |
| `camera.snap`、`camera.clip`   | カメラ（クリップ音声はマイクも）        | カメラ（クリップ音声はマイクも）              | カメラ（クリップ音声はマイクも）| `*_PERMISSION_REQUIRED`        |
| `screen.record`                | 画面収録（マイクはオプション）          | 画面キャプチャプロンプト（マイクはオプション）| 画面収録                       | `*_PERMISSION_REQUIRED`        |
| `location.get`                 | 使用中または常に（モードによる）        | モードによるフォアグラウンド/バックグラウンド | 位置情報パーミッション         | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                   | n/a（ノードホストパス）                 | n/a（ノードホストパス）                       | Exec 承認が必要               | `SYSTEM_RUN_DENIED`            |

## ペアリングと承認の違い

これらは異なるゲートです:

1. **デバイスペアリング**: このノードは Gateway に接続できますか?
2. **Exec 承認**: このノードは特定のシェルコマンドを実行できますか?

クイックチェック:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

ペアリングが欠落している場合は、先にノードデバイスを承認してください。ペアリングは正常だが `system.run` が失敗する場合は、exec 承認/許可リストを修正してください。

## 一般的なノードエラーコード

- `NODE_BACKGROUND_UNAVAILABLE` → アプリがバックグラウンドにあります。フォアグラウンドに移動してください。
- `CAMERA_DISABLED` → カメラトグルがノード設定で無効になっています。
- `*_PERMISSION_REQUIRED` → OS パーミッションが欠落/拒否されています。
- `LOCATION_DISABLED` → 位置情報モードがオフです。
- `LOCATION_PERMISSION_REQUIRED` → リクエストされた位置情報モードが許可されていません。
- `LOCATION_BACKGROUND_UNAVAILABLE` → アプリがバックグラウンドにあるが「使用中のみ」パーミッションしかありません。
- `SYSTEM_RUN_DENIED: approval required` → exec リクエストに明示的な承認が必要です。
- `SYSTEM_RUN_DENIED: allowlist miss` → コマンドが許可リストモードでブロックされています。
  Windows ノードホストでは、`cmd.exe /c ...` のようなシェルラッパー形式は、ask フロー経由で承認されない限り許可リストモードでの不一致として扱われます。

## 高速回復ループ

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

まだ解決しない場合:

- デバイスペアリングを再承認する。
- ノードアプリを再度開く（フォアグラウンド）。
- OS パーミッションを再付与する。
- Exec 承認ポリシーを再作成/調整する。

関連リンク:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
