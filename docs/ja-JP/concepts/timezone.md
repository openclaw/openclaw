---
read_when:
    - タイムスタンプがモデル向けにどのように正規化されるかを理解する必要がある場合
    - システムプロンプト用のユーザータイムゾーンを設定する場合
summary: エージェント、エンベロープ、プロンプトにおけるタイムゾーンの扱い
title: タイムゾーン
x-i18n:
    generated_at: "2026-04-02T07:40:04Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 31a195fa43e3fc17b788d8e70d74ef55da998fc7997c4f0538d4331b1260baac
    source_path: concepts/timezone.md
    workflow: 15
---

# タイムゾーン

OpenClawはタイムスタンプを標準化し、モデルが**単一の基準時刻**を参照できるようにします。

## メッセージエンベロープ（デフォルトはローカル）

受信メッセージは以下のようなエンベロープで囲まれます:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

エンベロープ内のタイムスタンプは**デフォルトではホストのローカル時刻**で、分単位の精度です。

以下の設定でオーバーライドできます:

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

- `envelopeTimezone: "utc"` はUTCを使用します。
- `envelopeTimezone: "user"` は `agents.defaults.userTimezone` を使用します（ホストのタイムゾーンにフォールバックします）。
- 明示的なIANAタイムゾーン（例: `"Europe/Vienna"`）を使用すると、固定オフセットになります。
- `envelopeTimestamp: "off"` はエンベロープヘッダーから絶対タイムスタンプを除去します。
- `envelopeElapsed: "off"` は経過時間サフィックス（`+2m` スタイル）を除去します。

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

ツール呼び出し（`channels.discord.readMessages`、`channels.slack.readMessages` など）は**生のプロバイダータイムスタンプ**を返します。
一貫性のために、正規化フィールドも付加されます:

- `timestampMs`（UTCエポックミリ秒）
- `timestampUtc`（ISO 8601 UTC文字列）

生のプロバイダーフィールドはそのまま保持されます。

## システムプロンプト用のユーザータイムゾーン

`agents.defaults.userTimezone` を設定すると、モデルにユーザーのローカルタイムゾーンを伝えることができます。未設定の場合、OpenClawは**実行時にホストのタイムゾーンを解決**します（設定の書き込みは行いません）。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

システムプロンプトには以下が含まれます:

- ローカル時刻とタイムゾーンを含む `Current Date & Time` セクション
- `Time format: 12-hour` または `24-hour`

`agents.defaults.timeFormat`（`auto` | `12` | `24`）でプロンプトの表示形式を制御できます。

完全な動作と例については[日付と時刻](/date-time)を参照してください。

## 関連

- [ハートビート](/gateway/heartbeat) — アクティブ時間はスケジューリングにタイムゾーンを使用
- [Cronジョブ](/automation/cron-jobs) — cron式はスケジューリングにタイムゾーンを使用
- [日付と時刻](/date-time) — 日付・時刻の完全な動作と例
