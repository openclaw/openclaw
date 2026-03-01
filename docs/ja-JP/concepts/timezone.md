---
summary: "エージェント、エンベロープ、プロンプトのタイムゾーン処理"
read_when:
  - モデル向けにタイムスタンプがどのように正規化されるかを理解する必要があるとき
  - システムプロンプトのユーザータイムゾーンを設定しているとき
title: "タイムゾーン"
---

# タイムゾーン

OpenClaw はモデルが**単一の参照時刻**を参照できるようにタイムスタンプを標準化します。

## メッセージエンベロープ（デフォルトはローカル）

受信メッセージは以下のようなエンベロープでラップされます。

```
[Provider ... 2026-01-05 16:26 PST] message text
```

エンベロープのタイムスタンプは**デフォルトでホストのローカル時刻**であり、分精度です。

以下でオーバーライドできます。

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA タイムゾーン
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` は UTC を使用します。
- `envelopeTimezone: "user"` は `agents.defaults.userTimezone` を使用します（ホストタイムゾーンにフォールバック）。
- 固定オフセットには明示的な IANA タイムゾーン（例: `"Europe/Vienna"`）を使用します。
- `envelopeTimestamp: "off"` はエンベロープヘッダーから絶対タイムスタンプを削除します。
- `envelopeElapsed: "off"` は経過時間サフィックス（`+2m` スタイル）を削除します。

### 例

**ローカル（デフォルト）:**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**固定タイムゾーン:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**経過時間:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## ツールペイロード（生のプロバイダーデータ + 正規化フィールド）

ツール呼び出し（`channels.discord.readMessages`、`channels.slack.readMessages` など）は**生のプロバイダータイムスタンプ**を返します。一貫性のために正規化フィールドも添付します。

- `timestampMs`（UTC エポックミリ秒）
- `timestampUtc`（ISO 8601 UTC 文字列）

生のプロバイダーフィールドは保持されます。

## システムプロンプトのユーザータイムゾーン

モデルにユーザーのローカルタイムゾーンを伝えるには `agents.defaults.userTimezone` を設定します。設定されていない場合、OpenClaw は**ランタイムにホストタイムゾーン**を解決します（設定への書き込みなし）。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

システムプロンプトには以下が含まれます。

- `Current Date & Time` セクションにローカル時刻とタイムゾーン
- `Time format: 12-hour` または `24-hour`

プロンプト形式は `agents.defaults.timeFormat`（`auto` | `12` | `24`）で制御できます。

完全な動作と例については[日時](/date-time)を参照してください。
