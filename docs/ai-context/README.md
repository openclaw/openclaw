# AI Context Documentation

This folder contains documentation for AI assistant context and understanding. While the main docs/ folder has user-facing Mintlify documentation, this subfolder focuses on codebase patterns, architectural decisions, and implementation guides for AI-assisted development.

## Naming Convention

Files follow: `[Category][Number]_[Topic]_[Type].md`

- **Category**: Agent, Channel, Testing, Infra, Monetization, etc.
- **Number**: Sequential within category (01, 02, 03...)
- **Topic**: Specific subject (Architecture, Routing, Coverage, Experiments)
- **Type**: Guide, Reference, Tutorial, Pattern, etc.

## Current Documentation

### Agent Category
- **Agent01_Architecture_Guide.md**: PI Agent integration, RPC patterns, agent scope

### Channel Category
- **Channel01_Integration_Patterns.md**: Adding new channels, routing, allowlists

### Testing Category
- **Testing01_Coverage_Standards.md**: 70% threshold, vitest configuration, patterns

### Setup Category
- **Setup01_Installation_Checklist.md**: MAIBOT 설치 및 설정 전체 작업 목록 (한국어)

## Maintenance Guidelines

**Add new docs** when:
- Implementing complex patterns worth documenting
- Answering "how does X work?" questions repeatedly
- 지니 requests pattern documentation for monetization experiments
- Discovering non-obvious architectural decisions

**Update existing docs** when:
- Code patterns change significantly
- New best practices emerge
- User feedback reveals unclear explanations

**EXFOLIATE! Principle**:
- If documentation becomes outdated and unused, remove it rather than letting it rot
- Accuracy over comprehensiveness — 5 accurate docs > 20 stale ones
- Delete docs that duplicate information available in code comments or existing Mintlify docs

---

*Last updated: 2026-01-30*

