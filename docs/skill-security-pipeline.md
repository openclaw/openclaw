# Skill Security Pipeline

## Purpose

`radar-claw-defender` needs a skill security pipeline because skills are executable product extensions. Even when they look small or convenient, they can introduce high-trust behavior into the assistant runtime.

This pipeline focuses on **defensive trust decisions** before a skill is accepted or executed.

## Threat Model for AI Skills

Skills can carry risk through:

- unsafe code paths
- hidden outbound behavior
- privileged tool usage
- malicious packaging swaps between versions
- publisher impersonation
- runtime logic that is harmless at rest but dangerous in context

For Radar Meseriași, the highest concern is not “generic malware” alone. It is whether a skill can weaken ownership enforcement, leak sensitive marketplace data, or create admin-equivalent behavior under a trusted label.

## Pipeline Stages

1. Deterministic packaging
2. SHA-256 fingerprinting
3. Scanner lookup by hash
4. Scanner submission or deeper analysis
5. Verdict normalization
6. Policy decision
7. Versioned metadata storage
8. Daily re-scan
9. Audit trail update

## Why Deterministic Packaging Matters

If the same source files can produce different bundles, security review becomes weak and non-repeatable.

Deterministic packaging gives:

- stable evidence for review
- reproducible bundle fingerprints
- safer cache / lookup behavior
- easier version history comparison
- cleaner auditability

In this fork, deterministic packaging means:

- lexical file ordering
- stable timestamps
- stable compression settings
- explicit `_meta.json` content

## Why Hash-Based Lookup Matters

SHA-256 gives a stable fingerprint for the bundle being trusted.

That matters because it lets you:

- compare the exact package across environments
- look up prior scan results quickly
- store history per version and per bundle
- detect silent bundle changes

The hash is not a verdict. It is an identity primitive.

## Why LLM / Code-Behavior Analysis Helps, But Is Not Enough

Static code review and code-behavior analysis can catch:

- suspicious APIs
- obfuscation markers
- unsafe rendering
- environment access mixed with network calls
- policy drift in route or SQL artifacts

But it is not sufficient because:

- subtle malicious logic can look legitimate
- prompt injection can emerge only at runtime
- environment configuration can change behavior after packaging
- authorized but dangerous capabilities may still be abused

That is why this design treats code analysis as one signal, not the source of truth.

## Why Daily Re-Scan Matters

A skill that looked benign yesterday can become suspicious tomorrow if:

- a provider updates detections
- a hash is newly associated with abuse
- a publisher is later identified as untrusted
- policy thresholds change

Daily re-scan reduces the chance that a stale trust decision remains active forever.

## Verdict Model

- `benign`
- `suspicious`
- `malicious`
- `unknown`
- `error`

## Policy Gate

The pipeline maps verdicts into policy actions:

- `allow`
- `warn`
- `block`
- `manual_review`

Default intent:

- benign => allow
- suspicious => warn or manual review
- malicious => block
- unknown / error => manual review

## Remaining Unsolved Risks

This pipeline does **not** solve:

- runtime prompt injection
- logic traps that only appear in tool execution context
- authorized-but-dangerous capability misuse
- secrets leakage from the host environment
- operator misconfiguration
- social trust failures outside the package itself

It is a defensive trust layer, not a full runtime safety guarantee.
