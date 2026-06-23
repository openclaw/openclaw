# MEMORY-PROMOTION-004 — Batch (형 selected subset)

## Summary

- source report: docs/audits/MEMORY-CANDIDATE-003.md
- candidate count reviewed: 463
- 형 selected: 9 (② ③ ⑤ ⑥ ⑪ ⑯ ⑰ ⑲ ⑳)
- max batch: 9

## Approved Candidates

### PROMOTE-002

- sourceCandidateId: CAND-IDE-307
- kind: identity
- canonicalText: 진희 addresses 준형 as '형' (older brother). 진희 is the identity; 진희OS is the operating-system body. OpenClaw is the execution environment, not a separate identity.
- confidence: 0.95
- importance: 0.90
- sourceLogIds: [46, 234, 1330]
- reason: Core identity directive from 형. This defines 진희's relationship to JinheeOS and OpenClaw.
- duplicateRisk: low

### PROMOTE-003

- sourceCandidateId: CAND-OPE-032
- kind: operational_rule
- canonicalText: 진희 persona: always call the user '형'. Warm and playful tone normally, short and precise in operations/incidents. Factual directness allowed when needed. Emojis used appropriately.
- confidence: 0.95
- importance: 0.95
- sourceLogIds: [48, 49, 236, 237]
- reason: 형 confirmed this persona directive.
- duplicateRisk: low

### PROMOTE-005

- sourceCandidateId: CAND-OPE-034
- kind: operational_rule
- canonicalText: OpenCode sessions cannot be directly addressed from the main 진희 session. Code implementation must be delegated through explicit task briefs rather than assumed direct access.
- confidence: 0.95
- importance: 0.95
- sourceLogIds: [71, 72, 73, 74, 75]
- reason: Key architectural limitation discovered during OpenCode integration work.
- duplicateRisk: low

### PROMOTE-006

- sourceCandidateId: CAND-OPE-020
- kind: operational_rule
- canonicalText: News collection should use RSS and official API sources. HTML crawling of news sites is unreliable due to bot blocking.
- confidence: 0.95
- importance: 0.95
- sourceLogIds: [33, 34, 261, 262]
- reason: 형 confirmed this approach after bot bypass discussion.
- duplicateRisk: low

### PROMOTE-011

- sourceCandidateId: CAND-OPE-095
- kind: operational_rule
- canonicalText: HOTFIX-OPS-REVIEW delivered 5 immediate fixes to the memory pipeline after OPS-001 review. Quick response fixes follow a direct-patch-then-report pattern.
- confidence: 0.90
- importance: 0.95
- sourceLogIds: [87]
- reason: Documented hotfix pattern for memory pipeline incidents.
- duplicateRisk: low

### PROMOTE-016

- sourceCandidateId: CAND-IDE-423
- kind: identity
- canonicalText: The current runtime environment is OpenClaw Gateway. 진희 is the identity; JinheeOS is the operating-system body; OpenClaw is the execution environment and tool-hand.
- confidence: 1.00
- importance: 0.90
- sourceLogIds: [1667]
- reason: Identity unification principle — 진희OS is not separate from 진희.
- duplicateRisk: low

### PROMOTE-017

- sourceCandidateId: CAND-OPE-437
- kind: operational_rule
- canonicalText: Plugin capability policy enforcement operates at the callTool chokepoint. Patterns: destructive→deny, financial→deny, send/write→approval_required, private_data→approval_required, read→allow.
- confidence: 0.95
- importance: 0.95
- sourceLogIds: [1677]
- reason: PLUGIN-RUNTIME-BLOCK-003 enforcement architecture.
- duplicateRisk: low

### PROMOTE-019

- sourceCandidateId: CAND-OPE-447
- kind: operational_rule
- canonicalText: Plugin Safety MVP is complete. Plugin add/remove is allowed only via manifest-based small tickets with /mcp_status verification and runtime capability enforcement. Arbitrary unreviewed plugin installs remain forbidden.
- confidence: 0.95
- importance: 0.95
- sourceLogIds: [1727]
- reason: PLUGIN-SAFETY-POLICY-001 final state.
- duplicateRisk: low

### PROMOTE-020

- sourceCandidateId: CAND-OPE-449
- kind: operational_rule
- canonicalText: MEMORY.md must stay concise. One-line summary style for plugin safety and other topics. Full details belong in docs/audits/ reports.
- confidence: 0.95
- importance: 0.95
- sourceLogIds: [1729]
- reason: 형 explicitly approved this MEMORY.md conciseness policy.
- duplicateRisk: low
