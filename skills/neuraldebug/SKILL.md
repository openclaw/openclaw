---
name: neuraldebug
description: AI-powered debugging for software (8 languages) and LLM/transformer reasoning. Debug programs with natural language via real debuggers (GDB, LLDB, CDB, JDB, Delve, Node Inspector, rdbg). Debug LLM internals with Logit Lens, Attention Analysis, Probing, Activation Patching, and LoRA fine-tuning. Client-server architecture works with any AI agent.
version: 0.1.0
metadata:
  openclaw:
    requires:
      bins:
        - python3
        - git
    install:
      - id: pip
        kind: uv
        package: "git+https://github.com/DennySun2020/DeepRhapsody.git"
        label: "Install NeuralDebug (pip from GitHub)"
    emoji: "🔍"
    homepage: https://github.com/DennySun2020/DeepRhapsody
---
# NeuralDebug

AI-powered debugging framework for **software** and **LLM reasoning**. Part of the [DeepRhapsody](https://github.com/DennySun2020/DeepRhapsody) project.

Use this skill when asked to debug a program, diagnose a crash, analyze a core dump, inspect LLM reasoning, detect hallucinations, or fine-tune a model.

## What NeuralDebug Does

### 🔧 Software Debugging (8 Languages)
Debug **Python, C/C++, C#, Rust, Java, Go, Node.js/TypeScript, and Ruby** using real debuggers — not code reading. NeuralDebug drives GDB, LLDB, CDB, JDB, Delve, Node Inspector, and rdbg via a unified natural-language interface.

### 🧠 LLM Debugging
Step through transformer forward passes **layer by layer**. Run interpretability techniques to understand *why* a model produces a given output: Logit Lens, Attention Analysis, Probing, Activation Patching, and custom analysis sandboxes.

### 🎯 LLM Fine-Tuning
Inject missing knowledge into GPT-2 family models using LoRA. Diagnose → fine-tune → verify in a single workflow.

## Installation

```bash
# Clone the repo
git clone https://github.com/DennySun2020/DeepRhapsody.git
cd DeepRhapsody

# Install Python dependencies
pip install torch transformers

# For fine-tuning (optional)
pip install peft==0.7.1
```

## Quick Start: Software Debugging

### Interactive Mode (persistent debug session)

```bash
# Start debug server for a target script
python3 src/neuraldebug/python_debug_session.py serve my_script.py --port 5678

# Send commands
python3 src/neuraldebug/python_debug_session.py cmd -p 5678 start
python3 src/neuraldebug/python_debug_session.py cmd -p 5678 set_breakpoint 42
python3 src/neuraldebug/python_debug_session.py cmd -p 5678 continue
python3 src/neuraldebug/python_debug_session.py cmd -p 5678 inspect
```

### One-Shot Mode (quick breakpoint capture)

```bash
python3 src/neuraldebug/python_debugger.py debug my_script.py --breakpoint 42 --output result.json
```

### Supported Languages

| Language | Script | Backend |
|----------|--------|---------|
| Python | `python_debug_session.py` | bdb (stdlib) |
| C/C++ | `cpp_debug_session.py` | GDB, LLDB, or CDB |
| C# | `csharp_debug_session.py` | netcoredbg |
| Rust | `rust_debug_session.py` | rust-gdb / LLDB |
| Java | `java_debug_session.py` | JDB |
| Go | `go_debug_session.py` | Delve |
| Node.js/TS | `nodejs_debug_session.py` | Node Inspector |
| Ruby | `ruby_debug_session.py` | rdbg |

All scripts live in `src/neuraldebug/` and share the same command interface.

## Quick Start: LLM Debugging

```bash
# Start LLM debug server
python3 src/neuraldebug/llm/llm_debug_session.py serve -m gpt2-medium -p 5680

# Ask the model a question
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 start "The capital of Japan is"
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 generate 20

# Interpretability: where does the answer emerge?
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 logit_lens

# Interpretability: which attention heads focus on "Japan"?
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 attention 3

# Interpretability: what knowledge is encoded per layer?
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 probe next_token

# Interpretability: is prediction Japan-specific?
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 patch "The capital of France is"
```

### LLM Models Supported

Any HuggingFace causal LM with a built-in adapter:
- **GPT-2 family**: distilgpt2, gpt2, gpt2-medium, gpt2-large, gpt2-xl
- **Llama family**: Llama, Mistral, Qwen, DeepSeek
- **Custom models**: implement `ModelAdapter` and register

## Quick Start: LLM Fine-Tuning

```bash
# Create a config file (JSON)
cat > ft_config.json << 'EOF'
{
  "facts": [
    "Dr. Elena Vasquez is the director of Horizon Research Labs",
    "Dr. Elena Vasquez leads Horizon Research Labs"
  ],
  "verification_prompt": "Dr. Elena Vasquez is the director of",
  "expected_token": "Horizon",
  "config": { "num_steps": 150, "lora_r": 16, "lora_alpha": 32, "learning_rate": 2e-4 }
}
EOF

# Run fine-tuning (uses same server as LLM debugger)
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 -t 600 finetune ft_config.json

# Verify
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 start "Dr. Elena Vasquez is the director of"
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 generate 20
```

## Architecture

NeuralDebug uses a **client-server architecture** over TCP/JSON:

```
AI Agent (OpenClaw, Copilot, Claude, etc.)
    │
    ▼
Debug Session Script (TCP client)
    │
    ▼
NeuralDebug Server (TCP server on configurable port)
    │
    ▼
Real Debugger Backend (GDB/LLDB/CDB/PyTorch hooks/etc.)
```

Every command returns structured JSON — parseable by any AI agent.

## Platform Support

- **Windows** (CDB, Visual Studio debugger)
- **Linux** (GDB, LLDB)
- **macOS** (LLDB, GDB)

## Links

- **Repository**: https://github.com/DennySun2020/DeepRhapsody
- **Documentation**: https://github.com/DennySun2020/DeepRhapsody/wiki
- **Issues**: https://github.com/DennySun2020/DeepRhapsody/issues

See the `references/` folder for detailed command documentation:
- `software-debugging.md` — full command reference for all 8 languages
- `llm-debugging.md` — interpretability techniques and LLM commands
- `llm-finetuning.md` — LoRA fine-tuning workflow and configuration
