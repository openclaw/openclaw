---
summary: "エージェント、エンベロープ、プロンプトにおけるタイムゾーンの扱い"
read_when:
  - モデル向けにタイムスタンプがどのように正規化されるかを理解する必要がある場合
  - システムプロンプトにユーザーのタイムゾーンを設定する場合
title: "タイムゾーン"
---

# タイムゾーン

OpenClaw はタイムスタンプを標準化し、モデルが **単一の参照時刻** を認識するようにします。

## メッセージエンベロープ（既定はローカル）

受信メッセージは、次のようなエンベロープでラップされます。

```
[Provider ... 2026-01-05 16:26 PST] message text
```

エンベロープ内のタイムスタンプは **既定でホストのローカル時刻** で、分精度です。

これを上書きすることができます:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` は UTC を使用します。
- `envelopeTimezone: "user"` は `agents.defaults.userTimezone` を使用します（ホストのタイムゾーンにフォールバック）。
- 明示的な IANA タイムゾーン（例: `"Europe/Vienna"`）を指定して固定オフセットにできます。
- `envelopeTimestamp: "off"` はエンベロープヘッダーから絶対タイムスタンプを削除します。
- `envelopeElapsed: "off"` は経過時間のサフィックス（`+2m` 形式）を削除します。

### 例

**ローカル（既定）:**

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

ツール呼び出し（`channels.discord.readMessages`、`channels.slack.readMessages` など）は **プロバイダーの生タイムスタンプ** を返します。
一貫性のため、正規化フィールドも付与されます。 **rawプロバイダタイムスタンプ**を返します。
標準化されたフィールドも一貫性を保つために添付します:

- `timestampMs`（UTC のエポックミリ秒）
- `timestampUtc`（ISO 8601 の UTC 文字列）

生のプロバイダーフィールドは保持されます。

## システムプロンプトのユーザータイムゾーン

`agents.defaults.userTimezone` を設定して、モデルにユーザーのローカルタイムゾーンを伝えます。未設定の場合、OpenClaw は **実行時にホストのタイムゾーンを解決** します（設定の書き込みは行いません）。
が設定されていない場合、OpenClawは実行時に**ホストタイムゾーン**を解決します(設定の書き込みはありません)。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

システムプロンプトには次が含まれます。

- ローカル時刻とタイムゾーンを含む `Current Date & Time` セクション
- `Time format: 12-hour` または `24-hour`

`agents.defaults.timeFormat`（`auto` | `12` | `24`）でプロンプト形式を制御できます。

全体の挙動と例については [Date & Time](/date-time) を参照してください。
