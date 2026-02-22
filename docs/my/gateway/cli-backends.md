---
summary: "CLI backend များ — local AI CLI များကို အသုံးပြုသော စာသားသာ အစားထိုး လမ်းကြောင်း"
read_when:
  - API ပံ့ပိုးသူများ မအောင်မြင်သည့်အခါ ယုံကြည်စိတ်ချရသော အစားထိုး လမ်းကြောင်းလိုအပ်သောအခါ
  - Claude Code CLI သို့မဟုတ် အခြား local AI CLI များကို လည်ပတ်အသုံးပြုနေပြီး ပြန်လည်အသုံးချလိုသောအခါ
  - session များနှင့် ပုံရိပ်များကို ထောက်ပံ့ထားသေးပြီး ကိရိယာမပါသော စာသားသာ လမ်းကြောင်းလိုအပ်သောအခါ
title: "CLI Backends"
---

# CLI backends (fallback runtime)

OpenClaw can run **local AI CLIs** as a **text-only fallback** when API providers are down,
rate-limited, or temporarily misbehaving. This is intentionally conservative:

- **Tools များကို ပိတ်ထားသည်** (tool calls မရှိပါ)။
- **စာသားဝင် → စာသားထွက်** (ယုံကြည်စိတ်ချရ)။
- **Sessions များကို ထောက်ပံ့ထားသည်** (နောက်ဆက်တွဲ မေးခွန်းများကို အညီအမျှ ဆက်လက်လုပ်ဆောင်နိုင်ရန်)။
- **CLI က ပုံရိပ်လမ်းကြောင်းများကို လက်ခံပါက ပုံရိပ်များကို ဖြတ်သန်းပို့ဆောင်နိုင်သည်**။

This is designed as a **safety net** rather than a primary path. Use it when you
want “always works” text responses without relying on external APIs.

## Beginner-friendly quick start

Claude Code CLI ကို **config မလိုအပ်ဘဲ** အသုံးပြုနိုင်သည် (OpenClaw တွင် built-in default ပါရှိပြီးသား)—

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI လည်း out of the box အလုပ်လုပ်သည်—

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Gateway ကို launchd/systemd အောက်တွင် လည်ပတ်ပြီး PATH သေးငယ်ပါက command path ကိုသာ ထည့်ပါ—

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

That’s it. No keys, no extra auth config needed beyond the CLI itself.

## Using it as a fallback

အဓိက မော်ဒယ်များ မအောင်မြင်သည့်အခါမှသာ လည်ပတ်စေရန် fallback စာရင်းထဲသို့ CLI backend ကို ထည့်ပါ—

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

မှတ်ချက်များ—

- `agents.defaults.models` (allowlist) ကို အသုံးပြုပါက `claude-cli/...` ကို ထည့်ရမည်။
- အဓိက provider မအောင်မြင်ပါက (auth, rate limits, timeouts) OpenClaw သည် နောက်တစ်ဆင့်အဖြစ် CLI backend ကို စမ်းသပ်မည်။

## Configuration overview

CLI backend များအားလုံးသည် အောက်ပါနေရာအောက်တွင် ရှိသည်—

```
agents.defaults.cliBackends
```

Each entry is keyed by a **provider id** (e.g. `claude-cli`, `my-cli`).
The provider id becomes the left side of your model ref:

```
<provider>/<model>
```

### Example configuration

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## How it works

1. **Backend ကို ရွေးချယ်သည်** — provider prefix (`claude-cli/...`) အပေါ်မူတည်၍။
2. **System prompt ကို တည်ဆောက်သည်** — OpenClaw prompt နှင့် workspace context တူညီစွာ အသုံးပြုသည်။
3. **CLI ကို အကောင်အထည်ဖော်သည်** — session id (ထောက်ပံ့ထားပါက) ဖြင့် လုပ်ဆောင်ပြီး history ကို ကိုက်ညီစေသည်။
4. **Output ကို ခွဲခြမ်းစိတ်ဖြာသည်** — JSON သို့မဟုတ် စာသားဖြစ်စေ စစ်ဆေးပြီး နောက်ဆုံး စာသားကို ပြန်ပို့သည်။
5. **Session id များကို သိမ်းဆည်းထားသည်** — backend တစ်ခုချင်းစီအလိုက် သိမ်းဆည်းထား၍ နောက်ဆက်တွဲ မေးခွန်းများတွင် တူညီသော CLI session ကို ပြန်အသုံးပြုသည်။

## Sessions

- CLI က sessions ကို ထောက်ပံ့ပါက `sessionArg` (ဥပမာ `--session-id`) သို့မဟုတ်
  ID ကို flag များစွာထဲသို့ ထည့်သွင်းရပါက `sessionArgs` (placeholder `{sessionId}`) ကို သတ်မှတ်ပါ။
- CLI က **resume subcommand** ကို မတူညီသော flags များဖြင့် အသုံးပြုပါက
  `resumeArgs` ကို သတ်မှတ်ပါ (resume လုပ်သည့်အခါ `args` ကို အစားထိုးသည်) နှင့် လိုအပ်ပါက
  `resumeOutput` ကို ထည့်နိုင်သည် (JSON မဟုတ်သော resume များအတွက်)။
- `sessionMode`:
  - `always`: session id ကို အမြဲပို့သည် (မရှိသေးပါက UUID အသစ် ဖန်တီးသည်)။
  - `existing`: ယခင်က သိမ်းဆည်းထားခဲ့ပါကသာ session id ကို ပို့သည်။
  - `none`: session id ကို မပို့ပါ။

## Images (pass-through)

CLI က ပုံရိပ်လမ်းကြောင်းများကို လက်ခံပါက `imageArg` ကို သတ်မှတ်ပါ—

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw will write base64 images to temp files. `imageArg` ကို သတ်မှတ်ထားပါက ထို paths များကို CLI args အဖြစ် ပို့ဆောင်ပါသည်။ If `imageArg` is missing, OpenClaw appends the
file paths to the prompt (path injection), which is enough for CLIs that auto-
load local files from plain paths (Claude Code CLI behavior).

## Inputs / outputs

- `output: "json"` (default) သည် JSON ကို ခွဲခြမ်းစိတ်ဖြာပြီး text နှင့် session id ကို ထုတ်ယူရန် ကြိုးစားသည်။
- `output: "jsonl"` သည် JSONL stream များ (Codex CLI `--json`) ကို ခွဲခြမ်းစိတ်ဖြာပြီး
  နောက်ဆုံး agent message နှင့် ရှိပါက `thread_id` ကို ထုတ်ယူသည်။
- `output: "text"` သည် stdout ကို နောက်ဆုံး အဖြေအဖြစ် သတ်မှတ်သည်။

Input modes—

- `input: "arg"` (default) သည် prompt ကို CLI arg နောက်ဆုံးအဖြစ် ပို့သည်။
- `input: "stdin"` သည် prompt ကို stdin မှတစ်ဆင့် ပို့သည်။
- prompt အလွန်ရှည်ပြီး `maxPromptArgChars` ကို သတ်မှတ်ထားပါက stdin ကို အသုံးပြုသည်။

## Defaults (built-in)

OpenClaw တွင် `claude-cli` အတွက် default တစ်ခု ပါရှိသည်—

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw တွင် `codex-cli` အတွက်လည်း default တစ်ခု ပါရှိသည်—

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

လိုအပ်သည့်အခါသာ override လုပ်ပါ (အများအားဖြင့် absolute `command` လမ်းကြောင်း)။

## Limitations

- **No OpenClaw tools** (the CLI backend never receives tool calls). Some CLIs
  may still run their own agent tooling.
- **Streaming မရှိပါ** (CLI output ကို စုစည်းပြီးမှ ပြန်ပို့သည်)။
- **Structured outputs** များသည် CLI ၏ JSON ဖော်မတ်အပေါ် မူတည်သည်။
- **Codex CLI sessions** resume via text output (no JSONL), which is less
  structured than the initial `--json` run. OpenClaw sessions still work
  normally.

## Troubleshooting

- **CLI မတွေ့ပါ**: `command` ကို full path ဖြင့် သတ်မှတ်ပါ။
- **မော်ဒယ်အမည် မမှန်ပါ**: `modelAliases` ကို အသုံးပြု၍ `provider/model` → CLI model အဖြစ် map လုပ်ပါ။
- **Session မဆက်လက်နိုင်ပါ**: `sessionArg` ကို သတ်မှတ်ထားပြီး `sessionMode` သည်
  `none` မဖြစ်ကြောင်း သေချာစေပါ (Codex CLI သည် လက်ရှိ JSON output ဖြင့် resume မလုပ်နိုင်ပါ)။
- **ပုံရိပ်များ မသုံးသွားပါ**: `imageArg` ကို သတ်မှတ်ပါ (နှင့် CLI က ဖိုင်လမ်းကြောင်းများကို ထောက်ပံ့ကြောင်း စစ်ဆေးပါ)။
