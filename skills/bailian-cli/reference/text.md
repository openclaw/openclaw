# `bl text` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl text chat` | Send a chat completion (OpenAI compatible, DashScope) |

## Command details

### `bl text chat`

| Field | Value |
| --- | --- |
| **Name** | `text chat` |
| **Description** | Send a chat completion (OpenAI compatible, DashScope) |
| **Usage** | `bl text chat --message <text> [flags]` |
| **API docs** | [/compatibility-of-openai-with-dashscope](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--model <model>` | string | no | Model ID (default: qwen3.6-plus) |
| `--message <text>` | array | yes | Message text (repeatable, prefix role: to set role) |
| `--messages-file <path>` | string | no | JSON file with messages array (use - for stdin) |
| `--system <text>` | string | no | System prompt |
| `--max-tokens <n>` | number | no | Maximum tokens to generate (default: 4096) |
| `--temperature <n>` | number | no | Sampling temperature (0.0, 2.0] |
| `--top-p <n>` | number | no | Nucleus sampling threshold |
| `--stream` | boolean | no | Stream response tokens (default: on in TTY) |
| `--tool <json-or-path>` | array | no | Tool definition as JSON or file path (repeatable) |
| `--enable-thinking` | boolean | no | Enable thinking/reasoning mode (for qwen3/qwq models) |
| `--thinking-budget <n>` | number | no | Max tokens for thinking (default: 4096) |

#### Examples

```bash
bl text chat --message "What is Qwen?"
```

```bash
bl text chat --model qwen-max --system "You are a coding assistant." --message "Write fizzbuzz in Python"
```

```bash
bl text chat --message "Hello" --message "assistant:Hi!" --message "How are you?"
```

```bash
cat conversation.json | bl text chat --messages-file - --stream
```

```bash
bl text chat --message "Hello" --output json
```

```bash
bl text chat --model qwq-plus --message "Solve 1+1" --enable-thinking
```
