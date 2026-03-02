# SofaGenius Feedback API Contract

This document specifies the API endpoints that SofaGenius should implement
to receive feedback from OpenClaw and complete the bidirectional learning loop.

## Architecture

```
OpenClaw (runtime)                    SofaGenius (ML backend)
─────────────────                    ─────────────────────────

Skill execution ──→ feedback_store   POST /api/feedback/ingest
                    (local JSONL)  ──────→ Absorb telemetry,
                                           corrections, patterns
User corrections ──→ feedback_store          │
                                             ▼
Taught workflows ──→ feedback_store   Skill evolution pipeline
                                      - Update anomaly thresholds
                                      - Tune default hyperparams
                                      - Generate new skill configs
                                             │
                                             ▼
GET /api/feedback/skill-updates  ←── Updated skill definitions
```

## Endpoints

### POST /api/feedback/ingest

Receive a batch of feedback from OpenClaw.

**Request:**

```json
{
  "executions": [
    {
      "id": "uuid",
      "skill": "sofagenius-training",
      "action": "training-status",
      "args": {"run_id": "abc123"},
      "result": {"status": "running", "loss": 0.42},
      "success": true,
      "duration_ms": 1234,
      "error": null,
      "timestamp": 1709400000.0
    }
  ],
  "corrections": [
    {
      "id": "uuid",
      "skill": "sofagenius-launch",
      "action": "launch-propose",
      "original_args": {"dataset": "user/data", "model": "llama-3-8b"},
      "original_result": {"config": {"learning_rate": 3e-4}},
      "correction": "User said to always use learning_rate=1e-5 for Llama models",
      "corrected_args": {"learning_rate": 1e-5},
      "timestamp": 1709400000.0
    }
  ],
  "patterns": [
    {
      "id": "uuid",
      "type": "hyperparameter",
      "description": "User always uses warmup_ratio=0.1 with Llama models",
      "evidence": ["exec-id-1", "exec-id-2"],
      "suggested_action": "Default warmup_ratio to 0.1 for Llama family",
      "timestamp": 1709400000.0
    }
  ],
  "skill_drafts": [
    {
      "id": "uuid",
      "name": "llama-finetune-pipeline",
      "description": "Standard pipeline for fine-tuning Llama models",
      "steps": [
        {"action": "data-stats", "args": {"dataset": "$DATASET"}},
        {"action": "launch-propose", "args": {"dataset": "$DATASET", "model": "$MODEL"}},
        {"action": "launch-run", "args": {"config_id": "$CONFIG", "mode": "overfit"}}
      ],
      "trigger": null,
      "timestamp": 1709400000.0
    }
  ]
}
```

**Response:**

```json
{
  "accepted": 42,
  "rejected": 0,
  "insights": [
    "Detected preference for learning_rate=1e-5 on Llama family (3 corrections)",
    "New workflow 'llama-finetune-pipeline' queued for skill generation"
  ]
}
```

### GET /api/feedback/skill-updates

Check if SofaGenius has produced updated skills based on absorbed feedback.

**Response:**

```json
{
  "updates": [
    {
      "skill": "sofagenius-training",
      "version": "1.1",
      "description": "Added gradient vanishing detection based on user feedback",
      "changes": [
        "New anomaly detector: gradient_vanishing (requested via refinement)",
        "Updated loss_spike threshold from 2x to 1.5x (calibrated from 47 executions)"
      ],
      "skill_md_patch": "...",
      "bridge_py_patch": "..."
    }
  ],
  "pending_drafts": [
    {
      "name": "llama-finetune-pipeline",
      "status": "generating",
      "estimated_ready": "2026-03-03T00:00:00Z"
    }
  ]
}
```

### GET /api/feedback/stats

Get SofaGenius's view of accumulated feedback.

**Response:**

```json
{
  "total_executions_ingested": 1234,
  "total_corrections_ingested": 15,
  "total_patterns_ingested": 8,
  "skill_updates_generated": 3,
  "top_corrected_defaults": [
    {"param": "learning_rate", "model_family": "llama", "old": 3e-4, "new": 1e-5, "confidence": 0.95}
  ],
  "anomaly_threshold_adjustments": [
    {"detector": "loss_spike", "old_threshold": 2.0, "new_threshold": 1.5, "calibrated_from": 47}
  ]
}
```

## How SofaGenius should use feedback

### 1. Execution telemetry

- Track which skills/actions are used most (prioritize optimization)
- Identify common failure modes (improve error handling)
- Measure response times (set realistic timeouts)

### 2. User corrections

- Build a preference model per user/project
- Update default hyperparameters based on consistent corrections
- Flag when a correction contradicts existing defaults (needs human review)

### 3. Learned patterns

- Feed into anomaly detection calibration
- Update recommended configurations
- Generate "best practices" documentation

### 4. Skill drafts (taught workflows)

- Generate new SKILL.md + bridge.py from workflow steps
- Validate that the workflow is reproducible
- Publish as a new skill that other users can discover

## Implementation priority

1. **POST /api/feedback/ingest** — most important, enables the feedback loop
2. **GET /api/feedback/stats** — visibility into what's been learned
3. **GET /api/feedback/skill-updates** — closes the full loop

The OpenClaw side (feedback store + bridge scripts) works independently of
these endpoints. Feedback is stored locally and synced when endpoints are ready.
