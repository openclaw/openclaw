---
summary: "Run OpenClaw with native llama.cpp (zero vendor dependencies)"
read_when:
  - You want to run local models without HTTP servers
  - You need vendor-free, pure open source inference
  - You want the fastest local model integration
title: "llama.cpp (Native)"
---

# llama.cpp (Native)

OpenClaw can run models directly via **node-llama-cpp** bindings, bypassing HTTP servers entirely. This gives you pure vendor-free local inference with zero network overhead.

<Info>
**Pure open source stack**: OpenClaw (MIT) + node-llama-cpp (MIT) + llama.cpp (MIT) + your GGUF models = zero vendor dependencies.
</Info>

## Quick start

1. Download a GGUF model (Qwen example - using 7B for testing):

```bash
# Download Qwen 2.5 7B Instruct (split into 2 parts, ~5.4 GB total)
mkdir -p ~/models
cd ~/models

# Part 1 (3.99 GB)
wget -c https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q5_k_m-00001-of-00002.gguf

# Part 2 (1.45 GB) - REQUIRED, must match part 1
wget -c https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q5_k_m-00002-of-00002.gguf
```

2. Set environment variable (point to part 1, node-llama-cpp auto-finds part 2):

```bash
export LLAMA_CPP_MODEL_PATH="$HOME/models/qwen2.5-7b-instruct-q5_k_m-00001-of-00002.gguf"
```

3. Configure OpenClaw:

```json5
{
  agents: {
    defaults: {
      model: { primary: "llama-cpp/qwen2.5-7b-instruct-q5_k_m" },
    },
  },
}
```

4. Start the gateway:

```bash
openclaw gateway run
```

That's it! The model loads in-process on first use.

## How it works

Unlike Ollama or vLLM (which run HTTP servers), the llama.cpp integration loads models **directly in the OpenClaw process**:

```
OpenClaw Gateway process
    ↓ (native Node.js bindings)
node-llama-cpp
    ↓ (native C++ addon)
llama.cpp
    ↓
Your GPU (CUDA/Metal/Vulkan)
```

**Benefits:**

- ✅ Zero HTTP overhead
- ✅ No separate server process
- ✅ Full GPU acceleration (CUDA/Metal/Vulkan)
- ✅ Native function calling (grammar-constrained)
- ✅ Auto-detects model format (Qwen, DeepSeek, Llama, etc.)
- ✅ Pure MIT licensed stack

## Configuration

### Auto-discovery (recommended)

Set `LLAMA_CPP_MODEL_PATH` to your GGUF file:

```bash
export LLAMA_CPP_MODEL_PATH="/models/qwen2.5-coder-32b-q6_k.gguf"
```

OpenClaw auto-discovers the model on startup. Use it:

```json5
{
  agents: {
    defaults: {
      model: { primary: "llama-cpp/qwen2.5-coder-32b-q6_k" },
    },
  },
}
```

### Explicit configuration

For multiple models or custom settings:

```json5
{
  models: {
    mode: "merge",
    providers: {
      "llama-cpp": {
        baseUrl: "/models/qwen2.5-coder-32b-q6_k.gguf",
        api: "llama-cpp",
        apiKey: "local",
        gpuLayers: "max",
        models: [
          {
            id: "qwen-32b",
            name: "Qwen 2.5 Coder 32B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### GPU layers

Control how many layers run on GPU:

```json5
{
  models: {
    providers: {
      "llama-cpp": {
        gpuLayers: "max", // Use all GPU (default)
        // gpuLayers: 40,   // Run 40 layers on GPU, rest on CPU
        // gpuLayers: 0,    // CPU-only inference
      },
    },
  },
}
```

## Model selection

Recommended models for tool use (avoid small/quantized):

✅ **Good for production:**

- Qwen2.5-Coder **32B Q6_K** (single file, ~23 GB)
- DeepSeek-R1 **32B Q6_K** or higher
- Qwen2.5 **72B Q5_K** or higher

✅ **Good for testing/development:**

- Qwen2.5-7B-Instruct **Q5_K_M** (split 2 parts, ~5.4 GB total)
- Qwen2.5-7B-Instruct **Q6_K** (split 2 parts, ~6.3 GB total)

❌ **Avoid (prompt injection risk):**

- Models smaller than 7B
- Heavy quantization (Q2, Q3, Q4)
- Models without tool support

### Production model download (32B single file):

```bash
# Qwen 2.5 Coder 32B Q6_K (single file, recommended for production)
wget -c https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct-GGUF/resolve/main/qwen2.5-coder-32b-instruct-q6_k.gguf -P ~/models/
```

### Split GGUF files

When models are split (like the 7B Q5_K_M example above), **download ALL parts** into the same directory. Point `LLAMA_CPP_MODEL_PATH` to part 1, and node-llama-cpp automatically finds the other parts.

## Tool calling

Native function calling works out of the box. node-llama-cpp uses **grammar-constrained decoding** for reliable tool calls:

```json5
{
  models: {
    providers: {
      "llama-cpp": {
        baseUrl: "/models/qwen2.5-coder-32b-q6_k.gguf",
        api: "llama-cpp",
        models: [
          {
            id: "qwen-32b",
            // Tool calling enabled by default
          },
        ],
      },
    },
  },
}
```

The model auto-detects its chat template from GGUF metadata (Qwen, DeepSeek, Llama 3, etc.).

## vs Ollama vs vLLM

| Feature               | llama.cpp (native)  | Ollama          | vLLM       |
| --------------------- | ------------------- | --------------- | ---------- |
| **HTTP overhead**     | None                | Yes             | Yes        |
| **Separate process**  | No                  | Yes             | Yes        |
| **Vendor dependency** | None                | Ollama Inc.     | None       |
| **Setup complexity**  | Low                 | Very Low        | Medium     |
| **Tool calling**      | Native (grammar)    | HTTP-based      | HTTP-based |
| **GPU support**       | CUDA/Metal/Vulkan   | CUDA/Metal/ROCm | CUDA/ROCm  |
| **Memory**            | Shared with Gateway | Separate        | Separate   |

**When to use llama.cpp native:**

- You want zero vendor dependencies
- You value performance over convenience
- You're running one large model at a time
- You want the absolute fastest local inference

**When to use Ollama:**

- You want the easiest setup
- You need to hot-swap models frequently
- You want a separate process for isolation

**When to use vLLM:**

- You need maximum throughput (batching)
- You're serving multiple users
- You need advanced GPU optimizations

## Performance

Model loading is cached in-process:

- **First request**: 10-30 seconds (loads GGUF into VRAM)
- **Subsequent requests**: ~instant (model stays loaded)
- **Inference**: Depends on GPU, typically 30-80 tokens/sec on consumer GPUs

The model stays loaded until the Gateway restarts.

## Troubleshooting

### Model not loading

```bash
# Check the model file exists
ls -lh /models/qwen2.5-coder-32b-q6_k.gguf

# Check logs for loading errors
openclaw gateway run --verbose
```

### Out of memory

Reduce `gpuLayers` or use a smaller quantization:

```json5
{
  models: {
    providers: {
      "llama-cpp": {
        gpuLayers: 30, // Only 30 layers on GPU
      },
    },
  },
}
```

### CUDA not detected

Ensure you installed the CUDA variant of node-llama-cpp:

```bash
npm install node-llama-cpp
# Should auto-detect CUDA during install
```

Check GPU detection:

```bash
nvidia-smi  # Should show your GPU
```

### Function calling not working

Ensure your model supports tools. Check with:

```bash
# In node-llama-cpp
const model = await llama.loadModel({ modelPath: "..." });
console.log(model.supportsToolCalling);  // Should be true
```

Qwen 2.5+, DeepSeek-R1, and most modern instruct models support tools.

## Migration from Ollama

If you're currently using Ollama and want to switch:

**Before:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/qwen2.5-coder:32b" },
    },
  },
}
```

**After:**

```bash
# Download the GGUF directly
wget https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct-GGUF/resolve/main/qwen2.5-coder-32b-instruct-q6_k.gguf

# Stop Ollama (optional)
pkill ollama

# Configure llama.cpp
export LLAMA_CPP_MODEL_PATH="/path/to/qwen2.5-coder-32b-instruct-q6_k.gguf"
```

```json5
{
  agents: {
    defaults: {
      model: { primary: "llama-cpp/qwen2.5-coder-32b-instruct-q6_k" },
    },
  },
}
```

**You can keep both** configured with `models.mode: "merge"` for testing.

## Requirements

- **Node.js 22+** (OpenClaw requirement)
- **node-llama-cpp 3.16.2+** (peer dependency)
- **GGUF model files** (download from Hugging Face)
- **GPU**: CUDA 11.8+, Metal (macOS), or Vulkan (optional)

CPU-only inference works but is slower (GPU layer control not currently exposed in config schema).

## Security

Model loading is in-process, so:

- Model files must be trusted (validate checksums)
- Models have same memory access as the Gateway process
- No network isolation (model runs in same process)

This is the same trust model as native Python ML libraries. Only load models you trust.

## Advanced

### Custom context window

Override the auto-detected context size:

```json5
{
  models: {
    providers: {
      "llama-cpp": {
        models: [
          {
            id: "qwen-32b",
            contextWindow: 65536, // Override to 64K
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Temperature and sampling

Control via model params:

```json5
{
  agents: {
    defaults: {
      models: {
        "llama-cpp/qwen-32b": {
          params: {
            temperature: 0.8,
            topP: 0.95,
            topK: 40,
          },
        },
      },
    },
  },
}
```

These pass through to node-llama-cpp's sampling parameters.

## See also

- [Ollama](/providers/ollama) - Easier setup, HTTP-based
- [vLLM](/providers/vllm) - High-throughput server
- [Local models](/gateway/local-models) - General local model guide
- [Model providers](/concepts/model-providers) - All provider options
