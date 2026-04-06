---
read_when:
    - ロケーションのノードサポートやパーミッションUIを追加する場合
    - Androidのロケーションパーミッションやフォアグラウンド動作を設計する場合
summary: ノード向けロケーションコマンド（location.get）、パーミッションモード、Androidのフォアグラウンド動作
title: ロケーションコマンド
x-i18n:
    generated_at: "2026-04-02T07:46:05Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 5c691cfe147b0b9b16b3a4984d544c168a46b37f91d55b82b2507407d2011529
    source_path: nodes/location-command.md
    workflow: 15
---

# ロケーションコマンド（ノード）

## 要約

- `location.get` はノードコマンドです（`node.invoke` 経由）。
- デフォルトではオフです。
- Androidアプリの設定ではセレクターを使用します: オフ / 使用中のみ。
- 別のトグル: 正確な位置情報。

## セレクターを使う理由（単なるスイッチではなく）

OSのパーミッションは複数レベルです。アプリ内でセレクターを表示できますが、実際の許可はOSが決定します。

- iOS/macOSではシステムプロンプト/設定で**使用中のみ**または**常に許可**が表示される場合があります。
- Androidアプリは現在、フォアグラウンドロケーションのみをサポートしています。
- 正確な位置情報は別の許可です（iOS 14+ の「正確な位置情報」、Androidの「fine」と「coarse」）。

UIのセレクターはリクエストするモードを制御します。実際の許可はOS設定に依存します。

## 設定モデル

ノードデバイスごと:

- `location.enabledMode`: `off | whileUsing`
- `location.preciseEnabled`: bool

UIの動作:

- `whileUsing` を選択すると、フォアグラウンドパーミッションをリクエストします。
- OSがリクエストされたレベルを拒否した場合、許可された最高レベルに戻し、ステータスを表示します。

## パーミッションマッピング（node.permissions）

オプションです。macOSノードはパーミッションマップで `location` を報告します。iOS/Androidでは省略される場合があります。

## コマンド: `location.get`

`node.invoke` 経由で呼び出します。

パラメータ（推奨）:

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

レスポンスペイロード:

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

エラー（安定コード）:

- `LOCATION_DISABLED`: セレクターがオフです。
- `LOCATION_PERMISSION_REQUIRED`: リクエストされたモードのパーミッションがありません。
- `LOCATION_BACKGROUND_UNAVAILABLE`: アプリがバックグラウンドですが、「使用中のみ」しか許可されていません。
- `LOCATION_TIMEOUT`: 時間内に位置情報を取得できませんでした。
- `LOCATION_UNAVAILABLE`: システム障害 / プロバイダーがありません。

## バックグラウンド動作

- Androidアプリはバックグラウンド中の `location.get` を拒否します。
- Androidでロケーションをリクエストする際は、OpenClawを開いたままにしてください。
- 他のノードプラットフォームでは動作が異なる場合があります。

## モデル/ツール連携

- ツールサーフェス: `nodes` ツールが `location_get` アクションを追加します（ノードが必要）。
- CLI: `openclaw nodes location get --node <id>`。
- エージェントガイドライン: ユーザーがロケーションを有効にし、スコープを理解している場合のみ呼び出してください。

## UXコピー（推奨）

- オフ: 「位置情報の共有は無効です。」
- 使用中のみ: 「OpenClawが開いている間のみ。」
- 正確な位置情報: 「正確なGPS位置情報を使用します。オフにするとおおよその位置情報を共有します。」
