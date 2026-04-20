---
title: "Google (Gemini)"
summary: "Google Gemini 设置（API 密钥 + OAuth、图像生成、媒体理解、TTS、网络搜索）"
read_when:
  - 你想在 OpenClaw 中使用 Google Gemini 模型
  - 你需要 API 密钥或 OAuth 认证流程
---

# Google (Gemini)

Google 插件通过 Google AI Studio 提供对 Gemini 模型的访问，以及通过 Gemini Grounding 提供图像生成、媒体理解（图像/音频/视频）、文本转语音和网络搜索功能。

- 提供商：`google`
- 认证：`GEMINI_API_KEY` 或 `GOOGLE_API_KEY`
- API：Google Gemini API
- 替代提供商：`google-gemini-cli`（OAuth）

## 入门指南

选择你偏好的认证方法并按照设置步骤操作。

<Tabs>
  <Tab title="API 密钥">
    **最适合：** 通过 Google AI Studio 进行标准 Gemini API 访问。

    <Steps>
      <Step title="运行引导设置">
        ```bash
        openclaw onboard --auth-choice gemini-api-key
        ```

        或者直接传递密钥：

        ```bash
        openclaw onboard --non-interactive \
          --mode local \
          --auth-choice gemini-api-key \
          --gemini-api-key "$GEMINI_API_KEY"
        ```
      </Step>
      <Step title="设置默认模型">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "google/gemini-3.1-pro-preview" },
            },
          },
        }
        ```
      </Step>
      <Step title="验证模型可用">
        ```bash
        openclaw models list --provider google
        ```
      </Step>
    </Steps>

    <Tip>
    环境变量 `GEMINI_API_KEY` 和 `GOOGLE_API_KEY` 都被接受。使用你已经配置的任何一个。
    </Tip>

  </Tab>

  <Tab title="Gemini CLI（OAuth）">
    **最适合：** 通过 PKCE OAuth 重用现有的 Gemini CLI 登录，而不是使用单独的 API 密钥。

    <Warning>
    `google-gemini-cli` 提供商是一个非官方集成。一些用户报告使用这种 OAuth 方式时会遇到账户限制。使用风险自负。
    </Warning>

    <Steps>
      <Step title="安装 Gemini CLI">
        本地 `gemini` 命令必须在 `PATH` 中可用。

        ```bash
        # Homebrew
        brew install gemini-cli

        # 或 npm
        npm install -g @google/gemini-cli
        ```

        OpenClaw 支持 Homebrew 安装和全局 npm 安装，包括常见的 Windows/npm 布局。
      </Step>
      <Step title="通过 OAuth 登录">
        ```bash
        openclaw models auth login --provider google-gemini-cli --set-default
        ```
      </Step>
      <Step title="验证模型可用">
        ```bash
        openclaw models list --provider google-gemini-cli
        ```
      </Step>
    </Steps>

    - 默认模型：`google-gemini-cli/gemini-3-flash-preview`
    - 别名：`gemini-cli`

    **环境变量：**

    - `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`
    - `OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`

    （或 `GEMINI_CLI_*` 变体。）

    <Note>
    如果 Gemini CLI OAuth 请求在登录后失败，请在网关主机上设置 `GOOGLE_CLOUD_PROJECT` 或 `GOOGLE_CLOUD_PROJECT_ID` 并重试。
    </Note>

    <Note>
    如果在浏览器流程开始前登录失败，请确保本地 `gemini` 命令已安装并在 `PATH` 中。
    </Note>

    仅 OAuth 的 `google-gemini-cli` 提供商是一个单独的文本推理接口。图像生成、媒体理解和 Gemini Grounding 仍然使用 `google` 提供商 ID。

  </Tab>
</Tabs>

## 功能

| 功能             | 支持情况                     |
| ---------------- | ---------------------------- |
| 聊天完成         | 是                           |
| 图像生成         | 是                           |
| 音乐生成         | 是                           |
| 文本转语音       | 是                           |
| 图像理解         | 是                           |
| 音频转录         | 是                           |
| 视频理解         | 是                           |
| 网络搜索（Grounding） | 是                       |
| 思考/推理        | 是（Gemini 2.5+ / Gemini 3+） |
| Gemma 4 模型     | 是                           |

<Tip>
Gemini 3 模型使用 `thinkingLevel` 而不是 `thinkingBudget`。OpenClaw 将 Gemini 3、Gemini 3.1 和 `gemini-*-latest` 别名的推理控制映射到 `thinkingLevel`，以便默认/低延迟运行不会发送禁用的 `thinkingBudget` 值。

Gemma 4 模型（例如 `gemma-4-26b-a4b-it`）支持思考模式。OpenClaw 将 `thinkingBudget` 重写为 Gemma 4 支持的 Google `thinkingLevel`。将思考设置为 `off` 会保持思考禁用，而不是映射到 `MINIMAL`。
</Tip>

## 图像生成

捆绑的 `google` 图像生成提供商默认为 `google/gemini-3.1-flash-image-preview`。

- 也支持 `google/gemini-3-pro-image-preview`
- 生成：每个请求最多 4 张图像
- 编辑模式：启用，最多 5 个输入图像
- 几何控制：`size`、`aspectRatio` 和 `resolution`

要使用 Google 作为默认图像提供商：

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "google/gemini-3.1-flash-image-preview",
      },
    },
  },
}
```

<Note>
有关共享工具参数、提供商选择和故障转移行为，请参阅 [图像生成](/tools/image-generation)。
</Note>

## 视频生成

捆绑的 `google` 插件还通过共享的 `video_generate` 工具注册视频生成。

- 默认视频模型：`google/veo-3.1-fast-generate-preview`
- 模式：文本到视频、图像到视频和单一视频参考流程
- 支持 `aspectRatio`、`resolution` 和 `audio`
- 当前持续时间限制：**4 到 8 秒**

要使用 Google 作为默认视频提供商：

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "google/veo-3.1-fast-generate-preview",
      },
    },
  },
}
```

<Note>
有关共享工具参数、提供商选择和故障转移行为，请参阅 [视频生成](/tools/video-generation)。
</Note>

## 音乐生成

捆绑的 `google` 插件还通过共享的 `music_generate` 工具注册音乐生成。

- 默认音乐模型：`google/lyria-3-clip-preview`
- 也支持 `google/lyria-3-pro-preview`
- 提示控制：`lyrics` 和 `instrumental`
- 输出格式：默认 `mp3`，`google/lyria-3-pro-preview` 还支持 `wav`
- 参考输入：最多 10 张图像
- 会话支持的运行通过共享的任务/状态流程分离，包括 `action: "status"`

要使用 Google 作为默认音乐提供商：

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
      },
    },
  },
}
```

<Note>
有关共享工具参数、提供商选择和故障转移行为，请参阅 [音乐生成](/tools/music-generation)。
</Note>

## 文本转语音

捆绑的 `google` 语音提供商使用带有 `gemini-3.1-flash-tts-preview` 的 Gemini API TTS 路径。

- 默认语音：`Kore`
- 认证：`messages.tts.providers.google.apiKey`、`models.providers.google.apiKey`、`GEMINI_API_KEY` 或 `GOOGLE_API_KEY`
- 输出：常规 TTS 附件为 WAV，Talk/电话为 PCM
- 原生语音笔记输出：在此 Gemini API 路径上不支持，因为 API 返回 PCM 而不是 Opus

要使用 Google 作为默认 TTS 提供商：

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "google",
      providers: {
        google: {
          model: "gemini-3.1-flash-tts-preview",
          voiceName: "Kore",
        },
      },
    },
  },
}
```

Gemini API TTS 接受文本中表达性的方括号音频标签，例如 `[whispers]` 或 `[laughs]`。要在将标签发送到 TTS 的同时将其排除在可见聊天回复之外，请将它们放在 `[[tts:text]]...[[/tts:text]]` 块内：

```text
这是干净的回复文本。

[[tts:text]][whispers] 这是口语版本。[[/tts:text]]
```

<Note>
限制为 Gemini API 的 Google Cloud Console API 密钥对此提供商有效。这不是单独的 Cloud Text-to-Speech API 路径。
</Note>

## 高级配置

<AccordionGroup>
  <Accordion title="直接 Gemini 缓存重用">
    对于直接 Gemini API 运行（`api: "google-generative-ai"`），OpenClaw 将配置的 `cachedContent` 句柄传递给 Gemini 请求。

    - 使用 `cachedContent` 或旧版 `cached_content` 配置每个模型或全局参数
    - 如果两者都存在，`cachedContent` 优先
    - 示例值：`cachedContents/prebuilt-context`
    - Gemini 缓存命中使用从上游 `cachedContentTokenCount` 标准化为 OpenClaw `cacheRead`

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "google/gemini-2.5-pro": {
              params: {
                cachedContent: "cachedContents/prebuilt-context",
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Gemini CLI JSON 使用说明">
    使用 `google-gemini-cli` OAuth 提供商时，OpenClaw 按如下方式标准化 CLI JSON 输出：

    - 回复文本来自 CLI JSON `response` 字段。
    - 当 CLI 使 `usage` 为空时，使用回退到 `stats`。
    - `stats.cached` 被标准化为 OpenClaw `cacheRead`。
    - 如果缺少 `stats.input`，OpenClaw 从 `stats.input_tokens - stats.cached` 派生输入令牌。

  </Accordion>

  <Accordion title="环境和守护进程设置">
    如果网关作为守护进程运行（launchd/systemd），请确保 `GEMINI_API_KEY` 对该进程可用（例如，在 `~/.openclaw/.env` 中或通过 `env.shellEnv`）。
  </Accordion>
</AccordionGroup>

## 相关

<CardGroup cols={2}>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
  <Card title="图像生成" href="/tools/image-generation" icon="image">
    共享图像工具参数和提供商选择。
  </Card>
  <Card title="视频生成" href="/tools/video-generation" icon="video">
    共享视频工具参数和提供商选择。
  </Card>
  <Card title="音乐生成" href="/tools/music-generation" icon="music">
    共享音乐工具参数和提供商选择。
  </Card>
</CardGroup>