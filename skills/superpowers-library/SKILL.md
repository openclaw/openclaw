---
name: superpowers-library
description: Index skill for migrated skeletons from obra/superpowers-skills. Use when you want a Codex-oriented entry point into the Superpowers skill catalog or need help choosing one of the migrated skeletons.
---

# Superpowers Library

This skill indexes a skeleton migration of `obra/superpowers-skills` for Codex.

These migrated skills are skeletons, not full fidelity ports. They preserve the original intent and trigger wording, but Claude Superpowers-specific commands, paths, and workflow assumptions still need Codex-native adaptation before they should be treated as authoritative.

## How To Use

- Choose the closest migrated skill under `skills/superpowers-<category>-<skill>/SKILL.md`.
- Read that skill before using it. Do not assume the source repo conventions map directly to Codex.
- Replace Claude-only instructions such as `SUPERPOWERS_SKILLS_ROOT`, `TodoWrite`, or Claude-specific subagent flows with Codex tools and this repo's local guardrails.

## Catalog

- `superpowers-architecture-preserving-productive-tensions`: Recognize when disagreements reveal valuable context, preserve multiple valid approaches instead of forcing premature resolution
- `superpowers-collaboration-brainstorming`: Interactive idea refinement using Socratic method to develop fully-formed designs
- `superpowers-collaboration-dispatching-parallel-agents`: Use multiple Claude agents to investigate and fix independent problems concurrently
- `superpowers-collaboration-executing-plans`: Execute detailed plans in batches with review checkpoints
- `superpowers-collaboration-finishing-a-development-branch`: Complete feature development with structured options for merge, PR, or cleanup
- `superpowers-collaboration-receiving-code-review`: Receive and act on code review feedback with technical rigor, not performative agreement or blind implementation
- `superpowers-collaboration-remembering-conversations`: Search previous Claude Code conversations for facts, patterns, decisions, and context using semantic or text search
- `superpowers-collaboration-requesting-code-review`: Dispatch code-reviewer subagent to review implementation against plan or requirements before proceeding
- `superpowers-collaboration-subagent-driven-development`: Execute implementation plan by dispatching fresh subagent for each task, with code review between tasks
- `superpowers-collaboration-using-git-worktrees`: Create isolated git worktrees with smart directory selection and safety verification
- `superpowers-collaboration-writing-plans`: Create detailed implementation plans with bite-sized tasks for engineers with zero codebase context
- `superpowers-debugging-defense-in-depth`: Validate at every layer data passes through to make bugs impossible
- `superpowers-debugging-root-cause-tracing`: Systematically trace bugs backward through call stack to find original trigger
- `superpowers-debugging-systematic-debugging`: Four-phase debugging framework that ensures root cause investigation before attempting fixes. Never jump to solutions.
- `superpowers-debugging-verification-before-completion`: Run verification commands and confirm output before claiming success
- `superpowers-meta-gardening-skills-wiki`: Maintain skills wiki health - check links, naming, cross-references, and coverage
- `superpowers-meta-pulling-updates-from-skills-repository`: Sync local skills repository with upstream changes from obra/superpowers-skills
- `superpowers-meta-sharing-skills`: Contribute skills back to upstream via branch and PR
- `superpowers-meta-testing-skills-with-subagents`: RED-GREEN-REFACTOR for process documentation - baseline without skill, write addressing failures, iterate closing loopholes
- `superpowers-meta-writing-skills`: TDD for process documentation - test with subagents before writing, iterate until bulletproof
- `superpowers-problem-solving-collision-zone-thinking`: Force unrelated concepts together to discover emergent properties - 'What if we treated X like Y?
- `superpowers-problem-solving-inversion-exercise`: Flip core assumptions to reveal hidden constraints and alternative approaches - 'what if the opposite were true?
- `superpowers-problem-solving-meta-pattern-recognition`: Spot patterns appearing in 3+ domains to find universal principles
- `superpowers-problem-solving-scale-game`: Test at extremes (1000x bigger/smaller, instant/year-long) to expose fundamental truths hidden at normal scales
- `superpowers-problem-solving-simplification-cascades`: Find one insight that eliminates multiple components - 'if this is true, we don't need X, Y, or Z
- `superpowers-problem-solving-when-stuck`: Dispatch to the right problem-solving technique based on how you're stuck
- `superpowers-research-tracing-knowledge-lineages`: Understand how ideas evolved over time to find old solutions for new problems and avoid repeating past failures
- `superpowers-testing-condition-based-waiting`: Replace arbitrary timeouts with condition polling for reliable async tests
- `superpowers-testing-test-driven-development`: Write the test first, watch it fail, write minimal code to pass
- `superpowers-testing-testing-anti-patterns`: Never test mock behavior. Never add test-only methods to production classes. Understand dependencies before mocking.
