---
summary: "用于提供者支持的模型、图像、音频、TTS、视频、网络和嵌入工作流的推理优先CLI"
read_when:
  - 添加或修改`openclaw infer`命令
  - 设计稳定的无头能力自动化
title: "推理CLI"
---

# 推理CLI

`openclaw infer`是提供者支持的推理工作流的规范无头界面。

它有意暴露能力系列，而不是原始的gateway RPC名称和原始的代理工具ID。

## 将infer转变为技能

复制并粘贴此内容到代理：

```text
阅读 https://docs.openclaw.ai/cli/infer，然后创建一个技能，将我的常见工作流路由到`openclaw infer`。
专注于模型运行、图像生成、视频生成、音频转录、TTS、网络搜索和嵌入。
```

一个好的基于infer的技能应该：

- 将常见用户意图映射到正确的infer子命令
- 为它涵盖的工作流包含一些规范的infer示例
- 在示例和建议中首选`openclaw infer ...`
- 避免在技能主体内重新记录整个infer界面

典型的infer聚焦技能覆盖：

- `openclaw infer model run`
- `openclaw infer image generate`
- `openclaw infer audio transcribe`
- `openclaw infer tts convert`
- `openclaw infer web search`
- `openclaw infer embedding create`

## 为什么使用infer

`openclaw infer`为OpenClaw内的提供者支持的推理任务提供一个一致的CLI。

好处：

- 使用OpenClaw中已经配置的提供者和模型，而不是为每个后端连接一次性包装器。
- 将模型、图像、音频转录、TTS、视频、网络和嵌入工作流保持在一个命令树下。
- 为脚本、自动化和代理驱动的工作流使用稳定的`--json`输出形状。
- 当任务从根本上是"运行推理"时，首选第一方OpenClaw界面。
- 使用正常的本地路径，大多数infer命令不需要gateway。

## 命令树

```text
 openclaw infer
  list
  inspect

  model
    run
    list
    inspect
    providers
    auth login
    auth logout
    auth status

  image
    generate
    edit
    describe
    describe-many
    providers

  audio
    transcribe
    providers

  tts
    convert
    voices
    providers
    status
    enable
    disable
    set-provider

  video
    generate
    describe
    providers

  web
    search
    fetch
    providers

  embedding
    create
    providers
```

## 常见任务

此表将常见推理任务映射到相应的infer命令。

| 任务              | 命令                                                                   | 说明                              |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------- |
| 运行文本/模型提示 | `openclaw infer model run --prompt "..." --json`                       | 默认使用正常的本地路径            |
| 生成图像          | `openclaw infer image generate --prompt "..." --json`                  | 从现有文件开始时使用`image edit`  |
| 描述图像文件      | `openclaw infer image describe --file ./image.png --json`              | `--model`必须是`<provider/model>` |
| 转录音频          | `openclaw infer audio transcribe --file ./memo.m4a --json`             | `--model`必须是`<provider/model>` |
| 合成语音          | `openclaw infer tts convert --text "..." --output ./speech.mp3 --json` | `tts status`是gateway导向的       |
| 生成视频          | `openclaw infer video generate --prompt "..." --json`                  |                                   |
| 描述视频文件      | `openclaw infer video describe --file ./clip.mp4 --json`               | `--model`必须是`<provider/model>` |
| 搜索网络          | `openclaw infer web search --query "..." --json`                       |                                   |
| 获取网页          | `openclaw infer web fetch --url https://example.com --json`            |                                   |
| 创建嵌入          | `openclaw infer embedding create --text "..." --json`                  |                                   |

## 行为

- `openclaw infer ...`是这些工作流的主要CLI界面。
- 当输出将被另一个命令或脚本使用时，使用`--json`。
- 当需要特定后端时，使用`--provider`或`--model provider/model`。
- 对于`image describe`、`audio transcribe`和`video describe`，`--model`必须使用`<provider/model>`形式。
- 无状态执行命令默认为本地。
- Gateway管理的状态命令默认为gateway。
- 正常的本地路径不需要gateway运行。

## Model

使用`model`进行提供者支持的文本推理和模型/提供者检查。

```bash
openclaw infer model run --prompt "Reply with exactly: smoke-ok" --json
openclaw infer model run --prompt "Summarize this changelog entry" --provider openai --json
openclaw infer model providers --json
openclaw infer model inspect --name gpt-5.4 --json
```

注意事项：

- `model run`重用代理运行时，因此提供者/模型覆盖的行为类似于正常的代理执行。
- `model auth login`、`model auth logout`和`model auth status`管理保存的提供者认证状态。

## Image

使用`image`进行生成、编辑和描述。

```bash
openclaw infer image generate --prompt "friendly lobster illustration" --json
openclaw infer image generate --prompt "cinematic product photo of headphones" --json
openclaw infer image describe --file ./photo.jpg --json
openclaw infer image describe --file ./ui-screenshot.png --model openai/gpt-4.1-mini --json
```

注意事项：

- 从现有输入文件开始时使用`image edit`。
- 对于`image describe`，`--model`必须是`<provider/model>`。

## Audio

使用`audio`进行文件转录。

```bash
openclaw infer audio transcribe --file ./memo.m4a --json
openclaw infer audio transcribe --file ./team-sync.m4a --language en --prompt "Focus on names and action items" --json
openclaw infer audio transcribe --file ./memo.m4a --model openai/whisper-1 --json
```

注意事项：

- `audio transcribe`用于文件转录，不是实时会话管理。
- `--model`必须是`<provider/model>`。

## TTS

使用`tts`进行语音合成和TTS提供者状态。

```bash
openclaw infer tts convert --text "hello from openclaw" --output ./hello.mp3 --json
openclaw infer tts convert --text "Your build is complete" --output ./build-complete.mp3 --json
openclaw infer tts providers --json
openclaw infer tts status --json
```

注意事项：

- `tts status`默认为gateway，因为它反映了gateway管理的TTS状态。
- 使用`tts providers`、`tts voices`和`tts set-provider`来检查和配置TTS行为。

## Video

使用`video`进行生成和描述。

```bash
openclaw infer video generate --prompt "cinematic sunset over the ocean" --json
openclaw infer video generate --prompt "slow drone shot over a forest lake" --json
openclaw infer video describe --file ./clip.mp4 --json
openclaw infer video describe --file ./clip.mp4 --model openai/gpt-4.1-mini --json
```

注意事项：

- 对于`video describe`，`--model`必须是`<provider/model>`。

## Web

使用`web`进行搜索和获取工作流。

```bash
openclaw infer web search --query "OpenClaw docs" --json
openclaw infer web search --query "OpenClaw infer web providers" --json
openclaw infer web fetch --url https://docs.openclaw.ai/cli/infer --json
openclaw infer web providers --json
```

注意事项：

- 使用`web providers`检查可用、配置和选择的提供者。

## Embedding

使用`embedding`进行向量创建和嵌入提供者检查。

```bash
openclaw infer embedding create --text "friendly lobster" --json
openclaw infer embedding create --text "customer support ticket: delayed shipment" --model openai/text-embedding-3-large --json
openclaw infer embedding providers --json
```

## JSON输出

Infer命令在共享信封下标准化JSON输出：

```json
{
  "ok": true,
  "capability": "image.generate",
  "transport": "local",
  "provider": "openai",
  "model": "gpt-image-1",
  "attempts": [],
  "outputs": []
}
```

顶级字段是稳定的：

- `ok`
- `capability`
- `transport`
- `provider`
- `model`
- `attempts`
- `outputs`
- `error`

## 常见陷阱

```bash
# 错误
openclaw infer media image generate --prompt "friendly lobster"

# 正确
openclaw infer image generate --prompt "friendly lobster"
```

```bash
# 错误
openclaw infer audio transcribe --file ./memo.m4a --model whisper-1 --json

# 正确
openclaw infer audio transcribe --file ./memo.m4a --model openai/whisper-1 --json
```

## 注意事项

- `openclaw capability ...`是`openclaw infer ...`的别名。
