# LLM Debugging Reference

Detailed command reference for NeuralDebug LLM/transformer debugging.

## Starting the Server

```bash
python src/neuraldebug/llm/llm_debug_session.py serve -m <model> -p <port>
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--model` | `-m` | `distilgpt2` | HuggingFace model name or local path |
| `--port` | `-p` | `5680` | TCP port |
| `--device` | `-d` | `cpu` | PyTorch device (`cpu`, `cuda`, `mps`) |
| `--adapter` | | auto | Force adapter (`gpt2`, `llama`, or custom) |

## Sending Commands

```bash
python src/neuraldebug/llm/llm_debug_session.py cmd -p <port> [-t timeout] <command> [args]
```

## Command Reference

### Conversation

| Command | Alias | Description |
|---------|-------|-------------|
| `start <prompt>` | `s` | Begin inference with a prompt |
| `generate [n]` | `gen` | Generate tokens (default 50) |

### Step-Through Debugging

| Command | Alias | Description |
|---------|-------|-------------|
| `step_over` | `n` | Execute current layer, advance |
| `step_in` | `si` | Enter block's sub-layers |
| `step_out` | `so` | Finish block, return to parent |
| `continue` | `c` | Run to next breakpoint or end |
| `b <layer>` | | Set breakpoint (e.g., `b block_3`) |
| `remove_breakpoint <layer>` | `rb` | Remove breakpoint |
| `breakpoints` | `bl` | List breakpoints |
| `inspect` | `i` | Show current layer state |
| `evaluate <expr>` | `e` | Evaluate PyTorch expression on live tensors |
| `list` | `l` | Show model architecture tree |
| `backtrace` | `bt` | Show layer execution stack |

### Interpretability Techniques

#### Logit Lens
**What it reveals**: At each layer, what would the model predict if the forward pass stopped here?

```bash
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 logit_lens
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 logit_lens 10  # top-10
```

Output shows per-layer: top prediction, probability, entropy. Reveals when the model "decides" on an answer.

#### Attention Analysis
**What it reveals**: Which tokens the model focuses on, ranked by attention weight per head.

```bash
# Global ranking of attention heads
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 attention

# Attention TO a specific token position
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 attention 3
```

#### Probing
**What it reveals**: What information is encoded at each layer's hidden states.

```bash
# Default: next_token prediction task
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 probe

# Specific tasks
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 probe next_token
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 probe token_identity
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 probe position
```

Trains lightweight classifiers on frozen hidden states. Reports accuracy per layer — 0% means the info isn't encoded, 100% means it is.

#### Activation Patching
**What it reveals**: Which layers causally determine the output by swapping activations between clean and corrupted prompts.

```bash
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 patch "corrupted prompt here"
```

Reports recovery score per layer. Positive = this layer is causally responsible.

#### Custom Analysis (Tool Forge)
**What it reveals**: Anything you define — custom metrics, probability checks, hook registration.

```bash
# Inline code
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 exec_analysis "def analyze(model, tokenizer, input_ids): ..."

# From file
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 exec_analysis @my_analysis.py
```

The `analyze()` function receives `(model, tokenizer, input_ids)` and must return a dict. Sandboxed — no filesystem or network access.

### Diagnosis

```bash
python src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 diagnose test_suite.json
```

Runs the full diagnostic pipeline: generation, logit lens, probing, attention, and produces remediation recommendations.

## Layer Names

```
embedding                    — Token + position embedding
block_0 … block_N           — Transformer blocks
block_X.attention            — Self-attention sub-tree
block_X.attn.ln_qkv         — LayerNorm + Q/K/V projection
block_X.attn.scores          — Scaled dot-product attention
block_X.attn.output          — Output projection + residual
block_X.ffn                  — Feed-forward sub-tree
block_X.ffn.ln_up            — LayerNorm + up-projection
block_X.ffn.activation       — GELU activation
block_X.ffn.down_residual    — Down-projection + residual
final_norm                   — Final layer normalisation
lm_head                      — Vocabulary projection (logits)
```

## Supported Models

### Built-in Adapters

| Adapter | Architectures | Auto-detection |
|---------|--------------|----------------|
| `gpt2` | GPT-2, DistilGPT-2 | `model.transformer.h` exists |
| `llama` | Llama, Mistral, Qwen, DeepSeek | `model.model.layers` exists |

### Custom Adapters

```python
from neuraldebug.llm.adapters.base import ModelAdapter, ModelInfo
from neuraldebug.llm.adapters.registry import AdapterRegistry

class MyAdapter(ModelAdapter):
    def info(self):
        return ModelInfo(name="my-model", num_layers=24, ...)
    # ... implement abstract methods

AdapterRegistry.register("my-model", MyAdapter,
    detect_fn=lambda m: hasattr(m, "my_attribute"))
```

## Response Format

```json
{
  "status": "paused",
  "command": "logit_lens",
  "message": "Logit Lens analysis across 24 layers",
  "local_variables": {
    "layers": [
      {"layer": "block_0", "top_token": "the", "probability": 0.05, "entropy": 8.2},
      {"layer": "block_23", "top_token": "Tokyo", "probability": 0.99, "entropy": 0.3}
    ]
  }
}
```
