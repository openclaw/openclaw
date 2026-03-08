# World Model Quick Start

## 1. Enable the World Model

Add to your `openclaw.json`:

```json
{
  "worldModel": {
    "enabled": true,
    "provider": "lstm",
    "dataDir": "./world-model-data",
    "minConfidence": 0.3,
    "lstm": {
      "latentDim": 128,
      "hiddenDim": 256,
      "weightsPath": "./world-model-data/checkpoint.json"
    },
    "dreamTraining": {
      "enabled": true,
      "epochs": 10,
      "dreamSteps": 20,
      "schedule": "0 2 * * *"
    }
  }
}
```

## 2. Run the Agent

The world model automatically:

- **Observes** every action (via `WorldModelManager.observe()`)
- **Predicts** next user intent (via `WorldModelManager.predict()`)
- **Collects training data** (saved to `world-model-YYYY-MM-DD.jsonl`)

## 3. Monitor Trust Score

The manager tracks prediction accuracy:

```typescript
const mgr = WorldModelManager.getInstance();
const trust = mgr.getTrustScore(); // 0.0 - 1.0
```

- **1.0:** Predictions are excellent, use them confidently
- **0.5:** Predictions are mixed, use with caution
- **0.2:** Predictions are bad, LSTM will go silent

## 4. Dream Training (Automatic)

At 2 AM each night, the dream trainer:

1. Loads observation data from the last 7 days
2. Trains the LSTM on (state, action) → next_state prediction
3. Runs dream simulation to consolidate learning
4. Saves updated model checkpoint

**Logs:**

```
[world-model] Dream training starting... 💤
[world-model] Found 45 trajectories with 1,230 total steps.
[world-model] Epoch 1/10 — Loss: 0.045321
[world-model] Epoch 2/10 — Loss: 0.032154
...
[world-model] Dream phase loss: 0.028901
[world-model] Checkpoint saved to ./world-model-data/checkpoint.json
[world-model] Dream training complete. Duration: 12.4s, Final Loss: 0.028901
```

## 5. Using Predictions in Handler Logic

In `src/agents/pi-embedded-subscribe.handlers.ts`:

```typescript
import { WorldModelManager } from "../world-model/manager.js";

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  const mgr = WorldModelManager.getInstance();

  // Get prediction for what user will do next
  const predictions = await mgr.predict({
    sessionId: ctx.params.session.id,
    context: "User just asked for help",
    messages: recentMessages,
  });

  if (predictions.length > 0) {
    const pred = predictions[0];

    if (pred.toolName === "search_docs") {
      // Pre-fetch search results in parallel?
      // Pre-load documentation?
      // Prepare arguments for the likely tool?
      console.log(`🧠 Predicting user will call: ${pred.toolName}`);
    }
  }
}
```

## 6. Manual Dream Training

Trigger training manually (e.g., when you have new data):

```bash
# Create a simple script:
# dream-train.ts

import { DreamTrainer } from "./src/world-model/dream-trainer.js";

const trainer = new DreamTrainer({
  dataDir: "./world-model-data",
  checkpointPath: "./world-model-data/checkpoint.json",
  epochs: 10,
  dreamSteps: 20,
  lookbackDays: 7,
});

const result = await trainer.train();
console.log(`Training complete: loss=${result.finalLoss.toFixed(6)}`);
```

```bash
npx ts-node dream-train.ts
```

## 7. Inspect Training Data

View observations:

```bash
# Check how many observations we have
wc -l ./world-model-data/*.jsonl

# View recent observations
tail -20 ./world-model-data/world-model-2026-02-20.jsonl

# Parse and inspect
cat ./world-model-data/world-model-2026-02-20.jsonl | head -1 | jq .
```

Each line is a JSON object:

```json
{
  "timestamp": 1708416000000,
  "sessionId": "user-123",
  "state": {
    "sessionId": "user-123",
    "context": "User is debugging a test failure",
    "messages": ["What's wrong?", "Tests are failing"]
  },
  "action": {
    "type": "tool_call",
    "toolName": "run_test",
    "toolArgs": { "file": "app.test.ts" },
    "confidence": 0.92
  }
}
```

## 8. Monitor Model Performance

**Check checkpoint:**

```bash
ls -lh ./world-model-data/checkpoint.json
cat ./world-model-data/checkpoint.json | jq '.trainedAt'
```

**Training logs over time:**

```bash
grep "Dream training complete" openclaw.log | tail -7
```

## 9. Tuning Hyperparameters

Experiment with:

| Parameter       | Default | Meaning                                                              |
| --------------- | ------- | -------------------------------------------------------------------- |
| `latentDim`     | 128     | Compression ratio (lower = less memory, less expressiveness)         |
| `hiddenDim`     | 256     | LSTM memory capacity (higher = better, slower)                       |
| `epochs`        | 10      | Training iterations per cycle (higher = better fit, longer training) |
| `dreamSteps`    | 20      | Hallucination length (higher = better generalization, slower)        |
| `lookbackDays`  | 7       | Historical data window (higher = more data, slower)                  |
| `minConfidence` | 0.3     | Prediction threshold (higher = more selective)                       |

**Start conservative, increase gradually:**

```json
{
  "lstm": {
    "latentDim": 64, // Start small
    "hiddenDim": 128 // Modest capacity
  },
  "dreamTraining": {
    "epochs": 5, // Quick training
    "dreamSteps": 10
  }
}
```

Then after a week of data:

```json
{
  "lstm": {
    "latentDim": 128, // More expressiveness
    "hiddenDim": 256 // More capacity
  },
  "dreamTraining": {
    "epochs": 10, // Better training
    "dreamSteps": 30 // Better generalization
  }
}
```

## 10. Troubleshooting

### "Trust score too low (0.15). Skipping prediction."

- The LSTM's predictions have been wrong recently
- Wait for the next dream training cycle (default 2 AM)
- Or manually trigger `npx ts-node dream-train.ts`

### "Cannot find module 'fs'"

- Run `pnpm install` to install node_modules
- TypeScript needs `@types/node`

### No data being collected

- Check that `worldModel.enabled: true` in config
- Check `dataDir` exists and is writable
- Look for errors in logs starting with `[world-model]`

### Dream training is slow

- Reduce `epochs` or `dreamSteps`
- Reduce `lookbackDays`
- Reduce `latentDim` or `hiddenDim` (but this hurts predictions)

### No predictions being returned

- Check `getTrustScore()` — if < 0.2, LSTM is silent
- Check that agent has run long enough to build hidden state
- Check `minConfidence` setting isn't too high

## 11. Architecture Decisions You Can Make

### Provider Choice

```json
{
  "worldModel": {
    "provider": "logging" // Just logs observations, no predictions
    // Use for data collection without ML
  }
}
```

```json
{
  "worldModel": {
    "provider": "llm" // Use a language model for predictions
    // Expensive but can be more accurate initially
    // Good for bootstrapping before LSTM is trained
  }
}
```

```json
{
  "worldModel": {
    "provider": "lstm" // Pure LSTM predictions
    // Free, fast, learns over time
    // Recommended!
  }
}
```

### Training Schedule

Cron expressions:

```
"0 2 * * *"       → Every day at 2 AM
"0 2 * * 0"       → Every Sunday at 2 AM (less frequent)
"0 0 * * *"       → Every day at midnight
"0 * * * *"       → Every hour
"0 */6 * * *"     → Every 6 hours
```

## 12. Next Steps

1. **Deploy with "logging" provider** — collect 1 week of data
2. **Enable dream training** — LSTM starts learning
3. **Monitor trust score** — watch it improve
4. **Tune hyperparameters** — customize for your use case
5. **Add prediction logic** — use LSTM hints in agent behavior

---

**Questions?** Check `WORLD_MODEL.md` for deep dive into architecture.

**Run tests:** `npx ts-node test-lstm-world-model.ts`
