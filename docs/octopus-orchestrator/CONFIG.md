# OpenClaw Octopus Orchestrator — Configuration

## Status

Milestone 0 draft — this is the concrete `octo:` block added to `~/.openclaw/openclaw.json`. All values shown are defaults unless marked `null` (unset) or `required`.

## Feature flag

```json5
{
  octo: {
    enabled: true, // default true after M2 exit (was false through Milestone 1)
  },
}
```

With `octo.enabled: false`, all `octo.*` Gateway WS methods return `not_enabled`, CLI commands error out cleanly, and no registry/event-log files are created.

## Top-level schema

```json5
{
  octo: {
    enabled: true,

    // Storage locations (all relative to OPENCLAW_STATE_DIR or ~/.openclaw)
    storage: {
      registryPath: "octo/registry.sqlite",
      eventsPath: "octo/events.jsonl",
      eventsArchivePath: "octo/events-archive/",
      artifactsPath: "octo/artifacts/",
      nodeStateRoot: "octo/", // per-node sidecars under node-<nodeId>/
    },

    // Event log retention
    events: {
      retentionDays: null, // null = keep indefinitely
      ingestRateLimit: 200, // events/sec/arm before drop+anomaly
      schemaVersion: 1,
    },

    // Lease model (see LLD §Lease Algorithm)
    lease: {
      renewIntervalS: 10,
      ttlS: 30,
      graceS: 30, // non-side-effecting grips
      sideEffectingGraceS: 60, // side_effecting: true grips
    },

    // Progress watchdog (see LLD §Forward-Progress Heartbeat)
    progress: {
      stallThresholdS: 300, // no progress tick -> blocked
      autoTerminateAfterS: null, // null = operator-only resolution
    },

    // Scheduler tuning (see LLD §Scheduler Algorithm)
    scheduler: {
      weights: {
        stickiness: 3.0,
        locality: 2.0,
        preferredMatch: 1.5,
        loadBalance: 1.0,
        recentFailurePenalty: 2.0,
        crossAgentIdPenalty: 1.0,
      },
      defaultSpread: false, // per-mission override allowed
    },

    // Quarantine thresholds
    quarantine: {
      maxRestarts: 3,
      nodeFailureWindow: 10,
      nodeFailureWindowS: 600,
    },

    // Arm resource ceilings
    arm: {
      outputBufferBytes: 2097152, // 2 MiB in-memory ring per arm
      stdoutRolloverBytes: 67108864, // 64 MiB per rolling file
      stdoutRolloverKeep: 4, // keep 4 segments
      idleTimeoutS: 900, // idle -> completed after 15m
      checkpointIntervalS: 60, // forced checkpoint cadence
    },

    // Retry defaults for grips that don't supply their own
    retryPolicyDefault: {
      maxAttempts: 3,
      backoff: "exponential",
      initialDelayS: 5,
      maxDelayS: 300,
      multiplier: 2.0,
      retryOn: ["transient", "timeout", "adapter_error"],
      abandonOn: ["policy_denied", "invalid_spec", "unrecoverable"],
    },

    // Cost accounting
    cost: {
      trackTokens: true,
      missionBudgetDefault: null, // or { cost_usd_limit, token_limit, on_exceed }
      ptyHourlyRateProxyUsd: null, // optional PTY-arm cost proxy
      modelRateTable: "default", // name of rate table in rate-tables/
    },

    // Operator authorization
    auth: {
      loopbackAutoWriter: true, // localhost CLI gets octo.writer free
      requireWriterForSideEffects: true,
    },

    // Scheduler / policy / sandbox inheritance
    policy: {
      enforcementActive: false, // flipped to true in Milestone 5
      defaultProfileRef: null,
    },

    // Research-driven execution classifier hints (OCTO-DEC-039)
    //
    // Hints consumed by the agent-side classifier before mission creation.
    // Not read by the Head — the Head only stores and validates
    // MissionSpec.execution_mode. Operators can tune these to shift the
    // classifier's behavior without code changes.
    classifier: {
      defaultMode: "direct_execute", // fallback when the classifier is uncertain
      researchFirstTaskClasses: [
        // task descriptions that should preference research-first
        "architecture",
        "systems_design",
        "performance_optimization",
        "unfamiliar_codebase",
        "unfamiliar_domain",
        "build_vs_buy",
        "protocol_integration",
        "prior_art_sensitive",
      ],
      directExecuteTaskClasses: [
        // task descriptions that should stay direct
        "small_local_edit",
        "obvious_bug_fix",
        "routine_refactor",
        "tightly_scoped_impl",
        "low_risk_maintenance",
      ],
      // Optional free-form hints the classifier can read during judgment
      hints: {
        // "when_unsure": "prefer research_then_plan over direct_execute"
      },
    },

    // Per-habitat overrides — indexed by nodeId
    habitats: {
      // "laptop-01": { maxArms: 8, cpuWeightBudget: 16, labels: { "geo": "home" } }
    },
  },
}
```

## Precedence

1. Command-line flags and environment variables
2. `octo:` block in `openclaw.json`
3. Compiled-in defaults shown above

## Validation

The `octo-config.ts` loader validates against a TypeBox schema at Gateway startup. Invalid config prevents startup with a clear error. No silent fallback to defaults on invalid keys.

## Related

- LLD §Lease Algorithm, §Scheduler Algorithm, §Backpressure, §Retry and Backoff, §Cost Accounting
- HLD §OpenClaw Integration Foundation
- DECISIONS.md OCTO-DEC-010 (storage), OCTO-DEC-007 (lease windows)
