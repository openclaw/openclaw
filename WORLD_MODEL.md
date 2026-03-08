# LSTM World Model for OpenClaw — The Cerebellum

> 🧠 An agent needs both a **brain** (LLM for reasoning) and a **cerebellum** (neural network for rapid, reflexive actions). This world model is the cerebellum.

## Overview

The world model implements Ha & Schmidhuber's [World Models (2018)](https://arxiv.org/abs/1803.10122) architecture adapted for OpenClaw's text-based agent pipeline. It's inspired by Yann LeCun's [JEPA (2022)](https://openreview.net/forum?id=BZ5a1r-kVsf) — **predict in latent space, not token space**.

### Why a World Model?

The main LLM brain is **powerful but slow and expensive**:

- Every prediction costs API calls
- Every token generation adds latency
- The LLM is doing _everything_ — reasoning, memory, action selection

The LSTM cerebellum is **lightweight but fast and free-running**:

- Runs locally, 24/7, no API costs
- Predicts user intent in < 1ms
- Acts as an involuntary system (like human reflexes)
- Learns from every interaction via dream training

## Architecture: V-M-C (Vision-Memory-Controller)

```
┌─ Observations (Live Agent Loop) ─┐
│ User message, tool calls, results│
└────────────────────────────────────┘
           ↓
    ┌─────────────────┐
    │   Encoder (V)   │  ← Vision component
    │  text → z ∈ ℝ¹²⁸│  Compress state into latent vector
    └────────┬────────┘
             ↓
    ┌─────────────────────────────┐
    │ LSTM Memory (M)             │  ← Memory component
    │ h_t, (z_t, a_t) → z_{t+1}  │  Track temporal context
    │ "What will happen next?"    │
    └────────┬────────────────────┘
             ↓
    ┌─────────────────┐
    │ Decoder (C)     │  ← Controller component
    │ z → action type │  Convert latent to action prediction
    │   + tool name   │
    └─────────────────┘
             ↓
    Prediction: { type, toolName, confidence }
```

### V — StateActionEncoder (`encoder.ts`)

Compresses agent observations into fixed-size latent vectors without external ML dependencies.

**Input:** Raw text (user message, tool names, context)
**Output:** Latent vector z ∈ ℝ^latentDim (default: 128)

**Method:**

1. Tokenize text into words
2. Hash each token using FNV-1a (deterministic, fast)
3. Look up embeddings from learned table
4. Mean-pool all embeddings into latent vector

**Design:**

- No heavy dependencies (no TensorFlow, ONNX, etc.)
- Embeddings are learned during LSTM training via backprop
- Hash collisions are intentional and handled by learning

### M — LSTMCell (`lstm.ts`)

Pure TypeScript LSTM implementation. The core "dreaming" component.

**Input:** Concatenated latent vectors `[z_state; z_action]` ∈ ℝ^(2×latentDim)
**Output:** Predicted next-state latent z\_{t+1} ∈ ℝ^latentDim
**Hidden State:** h_t, c_t ∈ ℝ^hiddenDim (default: 256)

**Architecture:**

```
Four gates (input, forget, cell, output) compute:
  i_t = σ(W_xi·x + W_hi·h + b_i)     ← Input gate
  f_t = σ(W_xf·x + W_hf·h + b_f)     ← Forget gate
  g_t = tanh(W_xg·x + W_hg·h + b_g)  ← Cell candidate
  o_t = σ(W_xo·x + W_ho·h + b_o)     ← Output gate

  c_t = f_t ⊙ c_{t-1} + i_t ⊙ g_t    ← Cell state update
  h_t = o_t ⊙ tanh(c_t)              ← Hidden state

  y_t = W_o·h_t + b_o                ← Output projection
```

**Training:**

- Backpropagation Through Time (BPTT) with gradient clipping
- Adam optimizer with learning rate scheduling
- Trained on (z_state, z_action) → z_next_state prediction

### C — LSTMWorldModel (`lstm-provider.ts`)

Wires V+M into the `IWorldModel` interface for OpenClaw integration.

**Three main methods:**

1. **`observe(state, action)`**
   - Called whenever agent makes a prediction/tool call
   - Updates LSTM hidden state (tracks conversation context)
   - Appends to training dataset for nightly training
   - Like the cerebellum continuously tracking motor state

2. **`predict(state)`**
   - Asks the LSTM: "What will the user do next?"
   - LSTM forward pass: z_state → z_predicted
   - Decode z back to action type + tool name
   - Fast (< 1ms), no API calls
   - Returns with confidence score

3. **`simulate(state, action)`**
   - Counterfactual reasoning: "What if we do X?"
   - Roll LSTM forward one step without actual execution
   - Returns predicted next state
   - Used for planning and "what-if" analysis

## Runtime Flow (Awake Phase)

```
┌─ User Message ──────────────────────────────┐
│ "Can you help me debug this error?"         │
└────────────┬────────────────────────────────┘
             ↓
   ┌─ Manager.predict(state) ─┐
   │ • LSTM forward pass       │
   │ • Decode to action        │  ← Fast! No API call
   │ • Check confidence        │
   │ • Reality check vs actual │
   └────────────┬──────────────┘
             ↓
  Predicted: { type: "tool_call", toolName: "search_docs", confidence: 0.87 }
             ↓
   ┌─ Agent executes actual action ─┐
   │ (calls LLM or tool)            │
   └────────────┬────────────────────┘
             ↓
   ┌─ Manager.observe(state, actualAction) ─┐
   │ • Update hidden state                  │
   │ • Append to dataset                    │
   │ • Reality check: did prediction match? │
   │   - If match: trust += 0.01            │
   │   - If miss:  trust -= 0.05            │
   │ • If trust < 0.2, LSTM goes silent     │
   └────────────────────────────────────────┘
```

## Sleep Phase (Dream Training)

Every night (configurable, default 2 AM), `DreamTrainer` wakes up and trains the LSTM.

### Phase 1: Load Real Data

- Read all `.jsonl` observation files from last 7 days
- Group observations into trajectories by sessionId
- Encode each trajectory: (state, action) → (z_state, z_action, z_next_state)

### Phase 2: Train on Real Data

- Multiple epochs of BPTT
- Minimize MSE: predict z\_{t+1} given (z_t, a_t)
- Gradient clipping to prevent instability

### Phase 3: Dream Simulation (REM Sleep)

> This is Ha & Schmidhuber's key insight.

Instead of only training on observed data, generate **hallucinated trajectories**:

1. Pick a random real trajectory
2. Use first 3 steps as context (warm up LSTM)
3. Let LSTM roll forward on its own predictions
4. The forward rollouts become self-supervised training data

The model learns to be **internally consistent** — its predictions should form coherent trajectories.

**Why this works:**

- Dreams help generalize beyond observed data
- Model discovers latent patterns in user behavior
- Training on own predictions (like REM sleep) consolidates memories
- 10x lower learning rate prevents the model from "hallucinating" too aggressively

### Phase 4: Save Checkpoint

- Encoder embeddings + LSTM weights → JSON file
- Tool vocabulary (all observed tool names)
- Timestamp and training epoch

## Integration with OpenClaw

### Configuration

```yaml
worldModel:
  enabled: true
  provider: "lstm" # or "logging", "llm"
  dataDir: "./world-model-data" # Where JSONL files are saved
  minConfidence: 0.3 # Only act on predictions > 30% confidence

  lstm:
    latentDim: 128 # Dimension of latent vectors
    hiddenDim: 256 # Dimension of LSTM hidden state
    weightsPath: "./checkpoint.json"

  dreamTraining:
    enabled: true
    epochs: 10 # Per nightly training cycle
    dreamSteps: 20 # Hallucination length
    schedule: "0 2 * * *" # Cron expression (2 AM)
    lookbackDays: 7 # How much historical data to use
```

### Wire into Cron Job

In the OpenClaw cron service, add:

```typescript
if (config.worldModel?.dreamTraining?.enabled) {
  scheduler.schedule(config.worldModel.dreamTraining.schedule, async () => {
    const trainer = new DreamTrainer({
      dataDir: config.worldModel.dataDir,
      checkpointPath: config.worldModel.lstm.weightsPath,
      epochs: config.worldModel.dreamTraining.epochs,
      dreamSteps: config.worldModel.dreamTraining.dreamSteps,
    });
    const result = await trainer.train();
    log.info(`Dream training complete: loss=${result.finalLoss}, duration=${result.duration}ms`);
  });
}
```

## Files and Components

| File               | Purpose                 | Size       |
| ------------------ | ----------------------- | ---------- |
| `encoder.ts`       | V: Text → Latent        | ~400 lines |
| `lstm.ts`          | M: LSTM core + BPTT     | ~700 lines |
| `lstm-provider.ts` | C: IWorldModel impl     | ~300 lines |
| `dataset.ts`       | Data collection         | ~150 lines |
| `dream-trainer.ts` | Sleep phase training    | ~350 lines |
| `manager.ts`       | Singleton + integration | ~200 lines |
| `types.ts`         | Type definitions        | ~45 lines  |

**Total:** ~2,100 lines of pure TypeScript. Zero ML framework dependencies.

## Testing

Run the comprehensive test suite:

```bash
npx ts-node test-lstm-world-model.ts
```

Tests:

- ✅ Encoder: state/action encoding
- ✅ LSTM: forward pass, training, sequence processing
- ✅ LSTMWorldModel: observe, predict, simulate
- ✅ Dataset: collection, persistence, trajectory loading
- ✅ DreamTrainer: full training pipeline
- ✅ Manager: singleton pattern, LSTM provider integration

## Performance Characteristics

| Operation          | Latency             | Cost         |
| ------------------ | ------------------- | ------------ |
| **observe()**      | Async, non-blocking | Free         |
| **predict()**      | < 1ms               | Free (local) |
| **simulate()**     | < 5ms               | Free (local) |
| **train epoch**    | ~100-500ms          | Free (local) |
| **dream phase**    | ~10-30s per cycle   | Free (local) |
| **LLM prediction** | 200-2000ms          | $0.01-0.10   |

## Memory Usage

- Encoder: ~4MB (token embedding table)
- LSTM weights: ~2-3MB
- Per-session hidden state: ~2KB
- Checkpoint file: ~6MB

**Total:** ~12-15MB resident memory. Scales well.

## Key Insights

### 1. Prediction in Latent Space (JEPA)

Don't predict next tokens or pixel values. Predict in compact latent space.

- **Faster:** Lower-dimensional targets
- **Smarter:** Irrelevant details filtered out by encoder
- **Robust:** Noise in latents doesn't break predictions

### 2. Dream Training as Self-Improvement

- Real data: what the agent actually observed
- Dream data: what the agent **predicts** will happen
- By training on dreams, the model learns to be internally consistent
- This is exactly what humans do in REM sleep

### 3. Trust Score for Safety

- If LSTM predictions keep being wrong, trust decays
- At trust < 0.2, LSTM stops making suggestions
- Forces the system to retrain (dream) and improve
- Prevents bad models from misleading the main agent

### 4. No External Dependencies

- Pure TypeScript math (no TensorFlow, ONNX, etc.)
- Runs on **any** Node.js runtime
- Portable, reproducible, debuggable
- Weights are plain JSON (human-readable)

## Future Enhancements

1. **Hierarchical Models:** Multiple LSTM layers with different timescales
2. **Tool-specific Predictors:** Separate models for different tool categories
3. **Uncertainty Quantization:** Mixture density outputs for Bayesian predictions
4. **Multi-agent Dreaming:** Agents sharing dream experiences
5. **Online Learning:** Incremental weight updates without full retraining
6. **Latent Space Visualization:** t-SNE/UMAP of learned state representations

## References

- **Ha & Schmidhuber (2018):** [World Models](https://arxiv.org/abs/1803.10122)
- **LeCun (2022):** [A Path Towards Autonomous Machine Intelligence](https://openreview.net/pdf?id=BZ5a1r-kVsf)
- **Yang et al. (2024):** [SWE-agent: Agent-Computer Interfaces](https://arxiv.org/abs/2405.15793)
- **Hochreiter & Schmidhuber (1997):** [LSTM: A key deep learning architecture](http://www.bioinf.jku.at/publications/older/2604.pdf)

---

**Built with ❤️ for OpenClaw agents that dream.**
