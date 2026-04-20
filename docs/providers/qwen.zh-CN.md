---
summary: "通过 OpenClaw 内置的 qwen 提供商使用 Qwen Cloud"
read_when:
  - 你想在 OpenClaw 中使用 Qwen
  - 你之前使用过 Qwen OAuth
title: "Qwen"
---

# Qwen

<Warning>

**Qwen OAuth 已移除。** 使用 `portal.qwen.ai` 端点的免费 OAuth 集成（`qwen-portal`）已不再可用。背景信息请见 [Issue #49557](https://github.com/openclaw/openclaw/issues/49557)。

</Warning>

OpenClaw 现在将 Qwen 作为内置的一流提供商，其标准 ID 为 `qwen`。该内置提供商针对 Qwen Cloud / 阿里云百炼和 Coding Plan 端点，并保留了旧版 `modelstudio` ID 作为兼容性别名。

- 提供商：`qwen`
- 首选环境变量：`QWEN_API_KEY`
- 为了兼容性也可接受：`MODELSTUDIO_API_KEY`、`DASHSCOPE_API_KEY`
- API 风格：OpenAI 兼容

<Tip>
如果你想要 `qwen3.6-plus`，请优先选择 **标准（按量付费）** 端点。Coding Plan 的支持可能会滞后于公开目录。
</Tip>

## 开始使用

选择你的计划类型并按照设置步骤操作。

<Tabs>
  <Tab title="Coding Plan（订阅）">
    **最适合：** 通过 Qwen Coding Plan 的订阅访问。

    <Steps>
      <Step title="获取你的 API 密钥">
        从 [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys) 创建或复制 API 密钥。
      </Step>
      <Step title="运行设置向导">
        对于 **全球** 端点：

        ```bash
        openclaw onboard --auth-choice qwen-api-key
        ```

        对于 **中国** 端点：

        ```bash
        openclaw onboard --auth-choice qwen-api-key-cn
        ```
      </Step>
      <Step title="设置默认模型">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "qwen/qwen3.5-plus" },
            },
          },
        }
        ```
      </Step>
      <Step title="验证模型可用">
        ```bash
        openclaw models list --provider qwen
        ```
      </Step>
    </Steps>

    <Note>
    旧版 `modelstudio-*` 认证选择 ID 和 `modelstudio/...` 模型引用仍然作为兼容性别名有效，但新的设置流程应优先使用标准的 `qwen-*` 认证选择 ID 和 `qwen/...` 模型引用。
    </Note>

  </Tab>

  <Tab title="标准（按量付费）">
    **最适合：** 通过标准 Model Studio 端点的按量付费访问，包括可能在 Coding Plan 上不可用的 `qwen3.6-plus` 等模型。

    <Steps>
      <Step title="获取你的 API 密钥">
        从 [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys) 创建或复制 API 密钥。
      </Step>
      <Step title="运行设置向导">
        对于 **全球** 端点：

        ```bash
        openclaw onboard --auth-choice qwen-standard-api-key
        ```

        对于 **中国** 端点：

        ```bash
        openclaw onboard --auth-choice qwen-standard-api-key-cn
        ```
      </Step>
      <Step title="设置默认模型">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "qwen/qwen3.5-plus" },
            },
          },
        }
        ```
      </Step>
      <Step title="验证模型可用">
        ```bash
        openclaw models list --provider qwen
        ```
      </Step>
    </Steps>

    <Note>
    旧版 `modelstudio-*` 认证选择 ID 和 `modelstudio/...` 模型引用仍然作为兼容性别名有效，但新的设置流程应优先使用标准的 `qwen-*` 认证选择 ID 和 `qwen/...` 模型引用。
    </Note>

  </Tab>
</Tabs>

## 计划类型和端点

| 计划 | 区域 | 认证选择 | 端点 |
| -------------------------- | ------ | -------------------------- | ------------------------------------------------ |
| 标准（按量付费） | 中国 | `qwen-standard-api-key-cn` | `dashscope.aliyuncs.com/compatible-mode/v1` |
| 标准（按量付费） | 全球 | `qwen-standard-api-key` | `dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Coding Plan（订阅） | 中国 | `qwen-api-key-cn` | `coding.dashscope.aliyuncs.com/v1` |
| Coding Plan（订阅） | 全球 | `qwen-api-key` | `coding-intl.dashscope.aliyuncs.com/v1` |

提供商会根据你的认证选择自动选择端点。标准选择使用 `qwen-*` 系列；`modelstudio-*` 仅用于兼容性目的。你可以在配置中使用自定义 `baseUrl` 进行覆盖。

<Tip>
**管理密钥：** [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys) |
**文档：** [docs.qwencloud.com](https://docs.qwencloud.com/developer-guides/getting-started/introduction)
</Tip>

## 内置模型目录

OpenClaw 当前附带此内置的 Qwen 目录。配置的目录具有端点感知能力：Coding Plan 配置会省略仅在标准端点上可用的模型。

| 模型引用 | 输入 | 上下文 | 说明 |
| --------------------------- | ----------- | --------- | -------------------------------------------------- |
| `qwen/qwen3.5-plus` | text, image | 1,000,000 | 默认模型 |
| `qwen/qwen3.6-plus` | text, image | 1,000,000 | 需要此模型时请优先使用标准端点 |
| `qwen/qwen3-max-2026-01-23` | text | 262,144 | Qwen Max 系列 |
| `qwen/qwen3-coder-next` | text | 262,144 | 编程 |
| `qwen/qwen3-coder-plus` | text | 1,000,000 | 编程 |
| `qwen/MiniMax-M2.5` | text | 1,000,000 | 已启用思考 |
| `qwen/glm-5` | text | 202,752 | GLM |
| `qwen/glm-4.7` | text | 202,752 | GLM |
| `qwen/kimi-k2.5` | text, image | 262,144 | 通过阿里巴巴的 Moonshot AI |

<Note>
即使某个模型存在于内置目录中，其可用性仍可能因端点和计费计划而异。
</Note>

## 多模态附加功能

`qwen` 扩展还在 **标准** 百炼端点（而非 Coding Plan 端点）上公开了多模态功能：

- **视频理解** 通过 `qwen-vl-max-latest`
- **万相视频生成** 通过 `wan2.6-t2v`（默认）、`wan2.6-i2v`、`wan2.6-r2v`、`wan2.6-r2v-flash`、`wan2.7-r2v`

要将 Qwen 用作默认视频提供商：

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
    },
  },
}
```

<Note>
请参阅 [视频生成](/tools/video-generation) 了解共享工具参数、提供商选择和故障转移行为。
</Note>

## 高级配置

<AccordionGroup>
  <Accordion title="图像和视频理解">
    内置的 Qwen 插件在 **标准** 百炼端点（而非 Coding Plan 端点）上注册了图像和视频的媒体理解功能。

    | 属性 | 值 |
    | ------------- | --------------------- |
    | 模型 | `qwen-vl-max-latest` |
    | 支持的输入 | 图像、视频 |

    媒体理解功能会自动从配置的 Qwen 认证中解析 — 无需额外配置。确保你使用的是标准（按量付费）端点以获得媒体理解支持。

  </Accordion>

  <Accordion title="Qwen 3.6 Plus 可用性">
    `qwen3.6-plus` 在标准（按量付费）Model Studio 端点上可用：

    - 中国：`dashscope.aliyuncs.com/compatible-mode/v1`
    - 全球：`dashscope-intl.aliyuncs.com/compatible-mode/v1`

    如果 Coding Plan 端点对 `qwen3.6-plus` 返回“不支持的模型”错误，请切换到标准（按量付费）端点/密钥对，而不是使用 Coding Plan。

  </Accordion>

  <Accordion title="功能路线图">
    `qwen` 扩展正被定位为完整 Qwen Cloud 功能的提供商，而不仅仅是编程/文本模型。

    - **文本/聊天模型：** 已内置
    - **工具调用、结构化输出、思考：** 从 OpenAI 兼容传输继承
    - **图像生成：** 计划在提供商插件层实现
    - **图像/视频理解：** 已在内置于标准端点
    - **语音/音频：** 计划在提供商插件层实现
    - **记忆嵌入/重排序：** 计划通过嵌入适配器接口实现
    - **视频生成：** 已通过共享视频生成功能内置

  </Accordion>

  <Accordion title="视频生成详细信息">
    对于视频生成，OpenClaw 在提交任务之前会将配置的 Qwen 区域映射到匹配的百炼 AIGC 主机：

    - 全球/国际：`https://dashscope-intl.aliyuncs.com`
    - 中国：`https://dashscope.aliyuncs.com`

    这意味着指向 Coding Plan 或标准 Qwen 主机的普通 `models.providers.qwen.baseUrl` 仍然会将视频生成保持在正确的区域百炼视频端点上。

    当前内置 Qwen 视频生成限制：

    - 每个请求最多 **1** 个输出视频
    - 最多 **1** 个输入图像
    - 最多 **4** 个输入视频
    - 最多 **10 秒** 时长
    - 支持 `size`、`aspectRatio`、`resolution`、`audio` 和 `watermark`
    - 参考图像/视频模式当前需要 **远程 http(s) URL**。由于百炼视频端点不接受上传的本地缓冲区用于这些参考，本地文件路径会被预先拒绝。

  </Accordion>

  <Accordion title="流式使用兼容性">
    原生 Model Studio 端点在共享的 `openai-completions` 传输上宣传流式使用兼容性。OpenClaw 现在会将端点功能与密钥关联，因此针对相同原生主机的兼容自定义提供商 ID 会继承相同的流式使用行为，而不是专门要求内置的 `qwen` 提供商 ID。

    原生流式使用兼容性适用于 Coding Plan 主机和标准百炼兼容主机：

    - `https://coding.dashscope.aliyuncs.com/v1`
    - `https://coding-intl.dashscope.aliyuncs.com/v1`
    - `https://dashscope.aliyuncs.com/compatible-mode/v1`
    - `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

  </Accordion>

  <Accordion title="多模态端点区域">
    多模态接口（视频理解和万相视频生成）使用 **标准** 百炼端点，而不是 Coding Plan 端点：

    - 全球/国际标准基址：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
    - 中国标准基址：`https://dashscope.aliyuncs.com/compatible-mode/v1`

  </Accordion>

  <Accordion title="环境和守护进程设置">
    如果网关作为守护进程（launchd/systemd）运行，请确保 `QWEN_API_KEY` 对该进程可用（例如，在 `~/.openclaw/.env` 中或通过 `env.shellEnv`）。
  </Accordion>
</AccordionGroup>

## 相关内容

<CardGroup cols={2}>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
  <Card title="视频生成" href="/tools/video-generation" icon="video">
    共享视频工具参数和提供商选择。
  </Card>
  <Card title="阿里巴巴（ModelStudio）" href="/providers/alibaba" icon="cloud">
    旧版 ModelStudio 提供商和迁移说明。
  </Card>
  <Card title="故障排除" href="/help/troubleshooting" icon="wrench">
    一般故障排除和常见问题。
  </Card>
</CardGroup>
