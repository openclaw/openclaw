---
summary: "ノード向けの Location コマンド（location.get）、権限モード、およびバックグラウンド動作"
read_when:
  - ロケーションノードのサポートや権限 UI を追加する場合
  - バックグラウンドの位置情報 + プッシュのフローを設計する場合
title: "Location コマンド"
---

# Location コマンド（nodes）

## TL;DR

- `location.get` はノードコマンドです（`node.invoke` 経由）。
- デフォルトではオフです。
- 設定はセレクターを使用します：Off / While Using / Always。
- 別トグル：Precise Location。

## なぜスイッチではなくセレクターなのか

OSのアクセス許可はマルチレベルです。 アプリ内でセレクターを公開することはできますが、実際の助成金はOSによって決定されます。

- iOS/macOS：ユーザーはシステムのプロンプトや設定で **While Using** または **Always** を選択できます。アプリは昇格を要求できますが、OS により設定画面が必要になる場合があります。 アプリはアップグレードをリクエストできますが、OSは設定が必要な場合があります。
- Android：バックグラウンド位置情報は別の権限です。Android 10+ では設定フローが必要になることが多くあります。
- Precise location は別個の付与です（iOS 14+ の「Precise」、Android の「fine」と「coarse」）。

UI のセレクターは要求するモードを決定し、実際の付与は OS の設定に存在します。

## 設定モデル

ノードデバイスごと：

- `location.enabledMode`：`off | whileUsing | always`
- `location.preciseEnabled`：bool

UI の動作：

- `whileUsing` を選択すると、フォアグラウンド権限を要求します。
- `always` を選択すると、まず `whileUsing` を確認し、その後バックグラウンドを要求します（必要な場合はユーザーを設定へ誘導します）。
- OS が要求レベルを拒否した場合、付与されている中で最も高いレベルに戻し、ステータスを表示します。

## 権限マッピング（node.permissions）

任意。 任意です。macOS ノードは権限マップ経由で `location` を報告します。iOS/Android では省略される場合があります。

## コマンド：`location.get`

`node.invoke` 経由で呼び出されます。

パラメータ（推奨）：

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

レスポンスペイロード：

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

エラー（安定コード）：

- `LOCATION_DISABLED`：セレクターがオフです。
- `LOCATION_PERMISSION_REQUIRED`：要求されたモードに対する権限が不足しています。
- `LOCATION_BACKGROUND_UNAVAILABLE`：アプリがバックグラウンドですが、While Using のみ許可されています。
- `LOCATION_TIMEOUT`：所定時間内に測位できませんでした。
- `LOCATION_UNAVAILABLE`：システム障害／プロバイダーがありません。

## バックグラウンド動作（将来）

目標：ノードがバックグラウンドのときでも、以下の場合に限りモデルが位置情報を要求できるようにします。

- ユーザーが **Always** を選択している。
- OS がバックグラウンド位置情報を付与している。
- アプリが位置情報のバックグラウンド実行を許可されている（iOS のバックグラウンドモード／Android のフォアグラウンドサービスまたは特別な許可）。

プッシュ起動フロー（将来）：

1. Gateway（ゲートウェイ）がノードにプッシュを送信します（サイレントプッシュまたは FCM データ）。
2. ノードが短時間起動し、デバイスから位置情報を取得します。
3. ノードがペイロードを Gateway（ゲートウェイ）へ転送します。

注記：

- iOS：Always 権限 + バックグラウンド位置情報モードが必要です。サイレントプッシュはスロットリングされる可能性があり、断続的な失敗が想定されます。 サイレントプッシュは抑制されることがあります; 断続的な失敗を期待します.
- Android：バックグラウンド位置情報にはフォアグラウンドサービスが必要な場合があります。そうでない場合、拒否が想定されます。

## モデル／ツール連携

- ツールのサーフェス：`nodes` ツールが `location_get` アクション（ノード必須）を追加します。
- CLI：`openclaw nodes location get --node <id>`。
- エージェントのガイドライン：ユーザーが位置情報を有効化し、範囲を理解している場合にのみ呼び出してください。

## UX 文言（提案）

- Off：「位置情報の共有は無効です。」
- While Using：「OpenClaw が開いているときのみ。」
- Always：「バックグラウンドでの位置情報を許可します。システム権限が必要です。」 システム権限が必要です。」
- Precise：「正確な GPS 位置情報を使用します。オフにすると概算位置を共有します。」 おおよその場所を共有するにはオフにします。」
