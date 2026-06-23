# MEMORY-PROMOTION-004 — Approved Promotion Batch

## Summary

- source report: `docs/audits/MEMORY-CANDIDATE-003.md`
- candidate count reviewed: 463
- eligible (conf>=0.85, imp>=0.75, dup=low): 183
- selected count: 20
- excluded count: 443
- max batch: 20

## Selection Criteria

- confidence >= 0.85, importance >= 0.75, duplicateRisk = low
- Priority kinds: operational_rule, identity, project_state, technical_fact
- Refined canonicalText per spec §9 (short, factual, durable, no conversation dialect)
- Sorted by: kind priority → confidence desc → importance desc

## Approved Candidates

### PROMOTE-001

- sourceCandidateId: CAND-OPE-006
- kind: operational_rule
- canonicalText: Bot bypass and blocking circumvention are prohibited. Only public RSS, official APIs, and user-provided direct links may be used for news/content retrieval.
- confidence: 0.95
- importance: 0.95
- sourceLogIds: [31, 32, 259, 260]
- reason: 형 directly established this policy. 진희 must not assist with bot bypass.
- duplicateRisk: low

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

### PROMOTE-004

- sourceCandidateId: CAND-IDE-016
- kind: identity
- canonicalText: TabbyAPI runs on port 5000 serving Qwen3-14B-EXL2-6hb-6.5bpw. It is managed via tmux session 'tabbyapi' and requires occasional monitoring for port stability.
- confidence: 0.95
- importance: 0.90
- sourceLogIds: [60, 61, 62, 63, 64]
- reason: Documented infrastructure fact about TabbyAPI setup.
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

### PROMOTE-007

- sourceCandidateId: CAND-TEC-028
- kind: technical_fact
- canonicalText: Google Sheets integration is active. sheets_ledger.py syncs jinheeDB income/expense/weekly data to Google Sheets.
- confidence: 1.00
- importance: 0.80
- sourceLogIds: [43, 44]
- reason: Confirmed technical integration.
- duplicateRisk: low

### PROMOTE-008

- sourceCandidateId: CAND-TEC-029
- kind: technical_fact
- canonicalText: Core identity block defines 진희 as 준형's personal AI OS and younger-brother assistant. This is the system prompt used for agent context.
- confidence: 0.85
- importance: 0.80
- sourceLogIds: [46]
- reason: Core system prompt structure.
- duplicateRisk: low

### PROMOTE-009

- sourceCandidateId: CAND-OPE-038
- kind: operational_rule
- canonicalText: GS settlement reconciliation uses specific column mapping: C열 for order key, E열 for price comparison, J열 for result output. Column-based matching is the standard reconciliation pattern.
- confidence: 1.00
- importance: 0.95
- sourceLogIds: [157, 163, 385, 391]
- reason: Established operational pattern for GS settlement.
- duplicateRisk: low

### PROMOTE-010

- sourceCandidateId: CAND-PRO-097
- kind: project_state
- canonicalText: ARCH-062 Phase 1 conversation log capture implementation was completed. It writes to jinhee.db conversation_logs table with real-time Telegram conversation capture.
- confidence: 0.80
- importance: 0.80
- sourceLogIds: [89]
- reason: Milestone in memory pipeline architecture.
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

### PROMOTE-012

- sourceCandidateId: CAND-OPE-090
- kind: operational_rule
- canonicalText: ARCH-062 Phase 2 night daily summary runs at 03:00 KST. It summarizes the previous day's conversation_logs into memory_items.
- confidence: 0.90
- importance: 0.95
- sourceLogIds: [82]
- reason: Scheduled memory pipeline operation.
- duplicateRisk: low

### PROMOTE-013

- sourceCandidateId: CAND-OPE-098
- kind: operational_rule
- canonicalText: JinheeOS has multiple memory facade paths. OPS-002B hardened the facade and decoupled the NL router from direct memory access.
- confidence: 0.90
- importance: 0.95
- sourceLogIds: [90]
- reason: Architectural hardening milestone.
- duplicateRisk: low

### PROMOTE-014

- sourceCandidateId: CAND-OPE-131
- kind: operational_rule
- canonicalText: Historical conversation recovery uses sessions_history_importer. Conversation_logs can be recovered from OpenClaw session history for dates with sparse coverage.
- confidence: 0.85
- importance: 0.95
- sourceLogIds: [123, 124, 125, 126]
- reason: Recovery procedure established during log recovery operations.
- duplicateRisk: low

### PROMOTE-015

- sourceCandidateId: CAND-PRO-156
- kind: project_state
- canonicalText: Naver integration (TICKET-028) was implemented including naver_mail_service.py for email filtering and management.
- confidence: 0.85
- importance: 0.80
- sourceLogIds: [148]
- reason: Completed project milestone.
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

### PROMOTE-018

- sourceCandidateId: CAND-OPE-445
- kind: operational_rule
- canonicalText: Worker Router MVP scope: classify, route, prompt build, result normalize, and review gate. No LLM self-improvement in MVP. Korean+English keywords for classification.
- confidence: 0.95
- importance: 0.95
- sourceLogIds: [1711, 1715]
- reason: WORKER-ROUTER architecture decision.
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

## Excluded / Deferred

### Deferred (business_context, health_routine, relationship_context)

- GS settlement operational details (business-specific)
- Health supplement discussions (personal, not canonical)
- Social greetings and chitchat (too situational)

### Excluded (low quality / too specific)

- Raw subagent task context prefixes — not durable knowledge
- Single-use status reports (e.g. specific Day 2 observation results)
- GS reconciliation batch texts without refined context
- Runtime error/timeout reports — transient
- Individual GS column matching iterations (too granular)

## Notes

- This batch file is read-only. No DB changes were made.
- INSERT requires 형 approval.
- After approval, run: `node scripts/jinhee-memory-promotion.mjs --batch docs/audits/MEMORY-PROMOTION-004-BATCH.md --db /home/savit/ai/jinhee_data/jinhee.db --apply`
- Generated at: 2026-06-23T00:19+09:00
