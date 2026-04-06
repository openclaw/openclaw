---
read_when:
    - タイムスタンプのモデルやユーザーへの表示方法を変更する場合
    - メッセージやシステムプロンプト出力における時刻フォーマットをデバッグする場合
summary: エンベロープ、プロンプト、ツール、コネクタにおける日付と時刻の扱い
title: 日付と時刻
x-i18n:
    generated_at: "2026-04-02T07:40:25Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 753af5946a006215d6af2467fa478f3abb42b1dff027cf85d5dc4c7ba4b58d39
    source_path: date-time.md
    workflow: 15
---

# 日付と時刻

OpenClawはデフォルトで**トランスポートのタイムスタンプにはホストのローカル時刻**を、**システムプロンプトにはユーザーのタイムゾーンのみ**を使用します。
プロバイダーのタイムスタンプはそのまま保持されるため、ツールはネイティブなセマンティクスを維持します（現在時刻は `session_status` から取得できます）。

## メッセージエンベロープ（デフォルトはローカル）

受信メッセージはタイムスタンプ（分単位の精度）とともにラップされます:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

このエンベロープのタイムスタンプは、プロバイダーのタイムゾーンに関係なく、**デフォルトではホストのローカル時刻**です。

以下の設定でこの動作をオーバーライドできます:

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
- `envelopeTimezone: "local"` はホストのタイムゾーンを使用します。
- `envelopeTimezone: "user"` は `agents.defaults.userTimezone` を使用します（ホストのタイムゾーンにフォールバックします）。
- 明示的なIANAタイムゾーン（例: `"America/Chicago"`）を使用すると、固定ゾーンになります。
- `envelopeTimestamp: "off"` はエンベロープヘッダーから絶対タイムスタンプを除去します。
- `envelopeElapsed: "off"` は経過時間サフィックス（`+2m` スタイル）を除去します。

### 例

**ローカル（デフォルト）:**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**ユーザータイムゾーン:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**経過時間有効:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## システムプロンプト: Current Date & Time

ユーザーのタイムゾーンが既知の場合、システムプロンプトにはプロンプトキャッシュの安定性を保つために**タイムゾーンのみ**（時計/時刻フォーマットなし）を含む専用の **Current Date & Time** セクションが含まれます:

```
Time zone: America/Chicago
```

エージェントが現在時刻を必要とする場合は、`session_status` ツールを使用してください。ステータスカードにはタイムスタンプ行が含まれています。

## システムイベント行（デフォルトはローカル）

エージェントコンテキストに挿入されるキューイングされたシステムイベントには、メッセージエンベロープと同じタイムゾーン選択（デフォルト: ホストのローカル時刻）を使用したタイムスタンプがプレフィックスとして付加されます。

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### ユーザータイムゾーン + フォーマットの設定

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` はプロンプトコンテキスト用の**ユーザーローカルタイムゾーン**を設定します。
- `timeFormat` はプロンプトでの**12時間/24時間表示**を制御します。`auto` はOSの設定に従います。

## 時刻フォーマットの検出（auto）

`timeFormat: "auto"` の場合、OpenClawはOSの設定（macOS/Windows）を検査し、ロケールのフォーマットにフォールバックします。検出された値はシステムコールの繰り返しを避けるため、**プロセスごとにキャッシュ**されます。

## ツールペイロード + コネクタ（生のプロバイダー時刻 + 正規化フィールド）

チャネルツールは**プロバイダーネイティブのタイムスタンプ**を返し、一貫性のために正規化フィールドを追加します:

- `timestampMs`: エポックミリ秒（UTC）
- `timestampUtc`: ISO 8601 UTC文字列

生のプロバイダーフィールドはそのまま保持されるため、データの損失はありません。

- Slack: APIからのエポック形式の文字列
- Discord: UTC ISO タイムスタンプ
- Telegram/WhatsApp: プロバイダー固有の数値/ISOタイムスタンプ

ローカル時刻が必要な場合は、既知のタイムゾーンを使用してダウンストリームで変換してください。

## 関連ドキュメント

- [システムプロンプト](/concepts/system-prompt)
- [タイムゾーン](/concepts/timezone)
- [メッセージ](/concepts/messages)
