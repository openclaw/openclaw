# Alibaba Cloud Bailian (DashScope)

阿里云百炼（Bailian）是阿里云提供的模型服务平台，提供通义千问（Qwen）系列模型。

## 认证方式

Bailian 提供 5 种认证选项，按**计费模式**和**地域**区分：

| Auth Choice           | 计费模式    | 地域   | Base URL                             |
| --------------------- | ----------- | ------ | ------------------------------------ |
| `bailian-payg-cn`     | 按量付费    | 中国站 | `dashscope.aliyuncs.com`             |
| `bailian-payg-intl`   | 按量付费    | 国际站 | `dashscope-intl.aliyuncs.com`        |
| `bailian-payg-us`     | 按量付费    | 美国站 | `dashscope-us.aliyuncs.com`          |
| `bailian-coding-cn`   | Coding Plan | 中国站 | `coding.dashscope.aliyuncs.com`      |
| `bailian-coding-intl` | Coding Plan | 国际站 | `coding-intl.dashscope.aliyuncs.com` |

### 计费模式说明

**按量付费 (Pay-as-you-go)**

- 用多少付多少，适合偶尔使用
- API Key 格式：`sk-xxxxx`
- 需要阿里云账号余额

**Coding Plan (订阅制)**

- 每月固定费用，适合高频使用
- API Key 与按量付费**不互通**
- 包含专属模型（如 `qwen3-max-2026-01-23`）

### 地域说明

- **CN (中国站)**: 北京，适合中国大陆用户
- **INTL (国际站)**: 新加坡，适合海外用户
- **US (美国站)**: 弗吉尼亚，仅按量付费

> ⚠️ **重要**: 不同地域的 API Key **不互通**，请使用对应地域的 Key。

---

## 配置方法

### 交互式配置（推荐）

```bash
openclaw onboard --auth-choice bailian-payg-cn
```

然后按提示：

1. 选择认证方式（5 选 1）
2. 输入对应地域的 API Key
3. 选择默认模型

### 非交互式配置

**按量付费 - 中国站：**

```bash
openclaw onboard --auth-choice bailian-payg-cn \
  --bailian-payg-cn-api-key "$DASHSCOPE_API_KEY"
```

**按量付费 - 国际站：**

```bash
openclaw onboard --auth-choice bailian-payg-intl \
  --bailian-payg-intl-api-key "$DASHSCOPE_API_KEY"
```

**按量付费 - 美国站：**

```bash
openclaw onboard --auth-choice bailian-payg-us \
  --bailian-payg-us-api-key "$DASHSCOPE_API_KEY"
```

**Coding Plan - 中国站：**

```bash
openclaw onboard --auth-choice bailian-coding-cn \
  --bailian-coding-cn-api-key "$DASHSCOPE_API_KEY"
```

**Coding Plan - 国际站：**

```bash
openclaw onboard --auth-choice bailian-coding-intl \
  --bailian-coding-intl-api-key "$DASHSCOPE_API_KEY"
```

### 使用环境变量

```bash
export DASHSCOPE_API_KEY=sk-xxxxx
openclaw onboard --auth-choice bailian-payg-cn
```

---

## 可用模型

### 按量付费模型（13 个）

| Model ID                     | Name               | Context | Max Tokens | 适用场景        |
| ---------------------------- | ------------------ | ------- | ---------- | --------------- |
| `qwen-max`                   | Qwen Max           | 100K    | 13K        | 复杂推理        |
| `qwen-plus`                  | Qwen Plus          | 131K    | 8K         | 均衡场景 ⭐     |
| `qwen-flash`                 | Qwen Flash         | 1M      | 32K        | 快速经济 ⭐     |
| `qwen3.5-plus`               | Qwen3.5 Plus       | 256K    | 256K       | 高性能通用 ⭐⭐ |
| `qwen3.5-coder-plus`         | Qwen3.5 Coder Plus | 1M      | 256K       | 编程专家 ⭐     |
| `qwen3-14b`                  | Qwen3 14B          | 256K    | 8K         | 中等任务        |
| `qwen3-32b`                  | Qwen3 32B          | 256K    | 16K        | 大型任务        |
| `qwen2.5-72b-instruct`       | Qwen2.5 72B        | 128K    | 8K         | 上一代旗舰      |
| `qwen2.5-32b-instruct`       | Qwen2.5 32B        | 128K    | 8K         | 上一代大型      |
| `qwen2.5-14b-instruct`       | Qwen2.5 14B        | 128K    | 8K         | 上一代中型      |
| `qwen2.5-7b-instruct`        | Qwen2.5 7B         | 128K    | 8K         | 上一代小型      |
| `qwen2.5-coder-32b-instruct` | Qwen2.5 Coder 32B  | 128K    | 8K         | 编程 (上一代)   |
| `qwen-vl-max`                | Qwen VL Max        | 32K     | 4K         | 视觉语言        |
| `qwen-audio`                 | Qwen Audio         | 8K      | 2K         | 音频处理        |

### Coding Plan 专属模型

Coding Plan 用户还可使用以下专属模型：

- `qwen3.5-plus`
- `qwen3-max-2026-01-23`
- `qwen3-coder-next`
- `MiniMax-M2.5`
- `glm-5`, `glm-4.7`
- `kimi-k2.5`

---

## 使用示例

配置完成后，选择模型：

```bash
# 设置默认模型
openclaw models set bailian/qwen3.5-plus

# 或在对话中指定
/openclaw model bailian/qwen-flash
```

---

## 常见问题

### Q: 按量付费和 Coding Plan 有什么区别？

**A:**

- **按量付费**: 用多少付多少，API Key 格式 `sk-xxxxx`，适合偶尔使用
- **Coding Plan**: 每月固定费用，专属 API Key，适合高频使用，包含专属模型

### Q: 如何选择地域？

**A:**

- 中国大陆用户 → 选 `CN` (中国站)
- 海外用户 → 选 `INTL` (国际站) 或 `US` (美国站)

### Q: API Key 在哪里获取？

**A:**

- 中国站：<https://dashscope.console.aliyun.com/>
- 国际站：<https://modelstudio.console.alibabacloud.com/ap-southeast-1>
- 美国站：<https://modelstudio.console.alibabacloud.com/us-east-1>

### Q: 配置后如何验证？

**A:**

```bash
# 查看当前模型
openclaw models list

# 测试调用
openclaw chat "Hello" --model bailian/qwen-flash
```

---

## 参考链接

- [阿里云百炼官方文档](https://help.aliyun.com/zh/model-studio/)
- [DashScope API 文档](https://help.aliyun.com/zh/dashscope/)
- [模型价格](https://help.aliyun.com/zh/model-studio/pricing)
