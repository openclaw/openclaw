# 本地模型部署指南 — 零成本运行股票分析

## 回答你的问题

**可以用自己部署的模型吗？** 完全可以。Moltbot 原生支持 Ollama、vLLM、LM Studio 等本地模型，配置后所有 API 费用为 0。

**怎么部署一个在 stock 方面比较好的模型？** 下面分三种方案详细说明。

---

## 方案对比

| 方案 | 硬件要求 | 推荐模型 | 特点 |
|------|---------|---------|------|
| **A. Ollama（最简单）** | 16GB 内存 | Qwen2.5-32B / Llama3.3-70B | 一行命令安装，自动发现 |
| **B. vLLM（最快）** | NVIDIA GPU 24GB+ | Qwen2.5-72B / DeepSeek-V3 | 吞吐量高，适合批量分析 |
| **C. LM Studio（最易上手）** | 16GB 内存 | 任意 GGUF 模型 | GUI 界面，拖拽加载模型 |

---

## 方案 A：Ollama（推荐，最简单）

### 第 1 步：安装 Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.ai/install.sh | sh

# 验证安装
ollama --version
```

### 第 2 步：选择和下载模型

**股票分析推荐模型（按硬件选择）：**

```bash
# ─── 16GB 内存（无 GPU）───
ollama pull qwen2.5:14b          # 阿里通义千问，中文金融理解最好
ollama pull llama3.3              # Meta Llama 3.3 70B（自动量化适配）

# ─── 32GB 内存 ───
ollama pull qwen2.5:32b          # 中文金融分析首选，32B 参数
ollama pull deepseek-r1:32b      # DeepSeek R1，推理能力强

# ─── NVIDIA GPU 24GB+ ───
ollama pull qwen2.5:72b          # 72B 参数，接近商业 API 水平
ollama pull deepseek-r1:70b      # 70B 推理模型，复杂分析能力强
```

**为什么推荐 Qwen2.5？**
- 阿里出品，**中文金融语料训练充分**
- 理解 A 股术语（板块、龙头、涨停、主力资金等）
- 对中国政策、财报、研报的理解远好于 Llama
- 32B 版本在 32GB 内存机器上流畅运行

### 第 3 步：验证模型运行

```bash
# 启动 Ollama 服务（安装后通常自动运行）
ollama serve

# 测试模型
ollama run qwen2.5:32b "分析一下半导体板块最近的政策利好对中芯国际的影响"

# 验证 API 端点
curl http://127.0.0.1:11434/api/tags
```

### 第 4 步：配置 Moltbot

```bash
# 方式 1：环境变量（最快）
export OLLAMA_API_KEY="ollama-local"
moltbot config set agents.defaults.model.primary "ollama/qwen2.5:32b"

# 方式 2：完整配置文件
```

编辑 `~/.moltbot/config.json`：

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/qwen2.5:32b",      // 主力模型
        fallbacks: ["ollama/qwen2.5:14b"]    // 降级模型（更快）
      }
    }
  },

  // 可选：自定义 Ollama 地址（默认 127.0.0.1:11434）
  models: {
    mode: "merge",
    providers: {
      ollama: {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama-local"
        // models 不用写，Moltbot 自动从 Ollama 发现
      }
    }
  }
}
```

### 第 5 步：验证

```bash
# 查看 Moltbot 识别到的模型
moltbot models list

# 测试对话
moltbot agent --message "分析半导体板块今日资金流向"
```

**搞定。** 之后所有 POC 里的 Agent 调用都走本地模型，0 费用。

---

## 方案 B：vLLM（高性能 GPU 方案）

适合有 NVIDIA GPU（24GB+ 显存）的服务器，吞吐量比 Ollama 高 3-5 倍。

### 安装

```bash
pip install vllm
```

### 启动服务

```bash
# 单卡 24GB（RTX 4090 / A5000）
vllm serve Qwen/Qwen2.5-32B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.9

# 双卡 48GB（2x RTX 4090）
vllm serve Qwen/Qwen2.5-72B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --tensor-parallel-size 2 \
  --max-model-len 32768

# DeepSeek R1（推理模型）
vllm serve deepseek-ai/DeepSeek-R1-Distill-Qwen-32B \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 32768
```

### 配置 Moltbot

```json5
{
  agents: {
    defaults: {
      model: { primary: "local-vllm/qwen2.5-72b" }
    }
  },
  models: {
    mode: "merge",
    providers: {
      "local-vllm": {
        baseUrl: "http://gpu-server:8000/v1",
        apiKey: "not-needed",
        api: "openai-completions",
        models: [{
          id: "qwen2.5-72b",
          name: "Qwen2.5 72B (vLLM)",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 8192
        }]
      }
    }
  }
}
```

---

## 方案 C：LM Studio（GUI 最友好）

适合想在 Mac/Windows 上快速体验的用户。

### 步骤

1. 下载 [LM Studio](https://lmstudio.ai/)
2. 搜索并下载模型（推荐 `Qwen2.5-32B-Instruct-GGUF`）
3. 点击 "Start Server"（默认端口 1234）
4. 配置 Moltbot：

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/qwen2.5-32b" }
    }
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-completions",
        models: [{
          id: "qwen2.5-32b",
          name: "Qwen2.5 32B",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 8192
        }]
      }
    }
  }
}
```

---

## 本地嵌入模型（Memory/RAG 用）

向量搜索（POC 02 的板块匹配）也需要嵌入模型。Moltbot 支持本地嵌入，同样不花钱：

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        enabled: true,
        provider: "local",    // 使用本地嵌入模型
        local: {
          // 默认自动下载 embeddinggemma-300M（300MB，效果不错）
          // 也可以指定其他 GGUF 嵌入模型
          modelPath: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"
        }
      }
    }
  }
}
```

首次运行会自动从 HuggingFace 下载，之后缓存在本地。

---

## 股票分析场景的模型选择建议

### 你需要模型做什么？

| 任务 | 要求 | 推荐模型 |
|------|------|---------|
| 新闻理解+分类 | 中文理解好、速度快 | Qwen2.5-14B（够用） |
| 板块影响分析 | 推理能力强 | Qwen2.5-32B 或 DeepSeek-R1-32B |
| 研报解读 | 长文本、专业术语 | Qwen2.5-72B（长上下文） |
| 实时盘中快扫 | 速度优先 | Qwen2.5-7B（<1秒响应） |
| 向量搜索/板块匹配 | 嵌入质量 | embeddinggemma-300M（本地默认） |

### 推荐组合（按硬件）

**入门配置（16GB 内存，无 GPU）：**
```
主力: ollama/qwen2.5:14b
快扫: ollama/qwen2.5:7b
嵌入: local embeddinggemma-300M
```

**进阶配置（32GB 内存 或 GPU 12GB+）：**
```
主力: ollama/qwen2.5:32b
快扫: ollama/qwen2.5:14b
嵌入: local embeddinggemma-300M
```

**专业配置（GPU 24GB+）：**
```
主力: vllm/qwen2.5-72b
推理: vllm/deepseek-r1-32b（复杂分析时切换）
快扫: ollama/qwen2.5:14b
嵌入: local embeddinggemma-300M
```

---

## 为什么不推荐 Llama 做股票分析？

| 维度 | Qwen2.5 | Llama 3.3 |
|------|---------|-----------|
| 中文金融术语 | 原生理解"涨停板""北向资金""板块轮动" | 需要额外解释 |
| A 股知识 | 训练数据包含大量 A 股研报 | 主要覆盖美股 |
| 政策理解 | 理解"国务院""发改委"等中国政策体系 | 较弱 |
| 数字推理 | 财务数据计算准确 | 差不多 |
| 中文输出质量 | 流畅自然 | 偶尔语法不自然 |

如果分析美股，Llama 3.3 也是好选择。分析 A 股，Qwen2.5 明显更好。

---

## 快速开始（复制粘贴就能跑）

```bash
# 1. 安装 Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# 2. 下载推荐模型
ollama pull qwen2.5:32b

# 3. 设置环境变量
export OLLAMA_API_KEY="ollama-local"

# 4. 配置 Moltbot
moltbot config set agents.defaults.model.primary "ollama/qwen2.5:32b"
moltbot config set agents.defaults.memorySearch.enabled true
moltbot config set agents.defaults.memorySearch.provider "local"

# 5. 验证
moltbot models list
moltbot agent --message "你好，帮我分析一下半导体板块"

# 全程 0 费用 ✅
```

---

## 混合模式：本地为主 + 云端降级

如果你担心本地模型分析质量不够，可以配置"本地优先、云端兜底"：

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/qwen2.5:32b",            // 优先用本地（免费）
        fallbacks: ["anthropic/claude-sonnet-4-20250514"]    // 本地挂了才用云端
      }
    }
  }
}
```

日常分析走本地 0 费用，只有本地模型出错时才走付费 API。
