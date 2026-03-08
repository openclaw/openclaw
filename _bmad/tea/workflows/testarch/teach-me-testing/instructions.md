# Teach Me Testing - Usage Instructions

## Overview

The Teach Me Testing workflow is a multi-session learning companion that teaches testing progressively through 7 structured sessions with state persistence. Designed for self-paced learning over 1-2 weeks.

## Who Should Use This

- **New QA Engineers:** Complete onboarding in testing fundamentals
- **Developers:** Learn testing from an integration perspective
- **Team Leads:** Understand architecture patterns and team practices
- **VPs/Managers:** Grasp testing strategy and quality metrics

## How to Run

### Starting Fresh

```bash
# From TEA module location
cd /path/to/bmad-method-test-architecture-enterprise

# Run the workflow
bmad run teach-me-testing
```

Or invoke through TEA agent menu:

```bash
bmad agent tea
# Select [TMT] Teach Me Testing
```

### Continuing Existing Progress

The workflow automatically detects existing progress and resumes where you left off. Your progress is saved at:

- `{test_artifacts}/teaching-progress/{your-name}-tea-progress.yaml`

## Workflow Structure

### 7 Sessions

1. **Quick Start (30 min)** - TEA Lite intro, run automate workflow
2. **Core Concepts (45 min)** - Risk-based testing, DoD, philosophy
3. **Architecture (60 min)** - Fixtures, network patterns, framework
4. **Test Design (60 min)** - Risk assessment workflow
5. **ATDD & Automate (60 min)** - ATDD + Automate workflows
6. **Quality & Trace (45 min)** - Test review + Trace workflows
7. **Advanced Patterns (ongoing)** - Menu-driven knowledge fragment exploration

### Non-Linear Learning

- Jump to any session based on your experience level
- Beginners: Start at Session 1
- Intermediate: Skip to Session 3-6
- Experienced: Jump to Session 7 (Advanced)

### Session Flow

Each session follows this pattern:

1. Load relevant TEA docs just-in-time
2. Present teaching content (mostly autonomous)
3. Knowledge validation quiz (interactive)
4. Generate session notes artifact
5. Update progress file
6. Return to session menu (continue or exit)

## Progress Tracking

Your progress is automatically saved after each session:

- **Progress file:** `{test_artifacts}/teaching-progress/{your-name}-tea-progress.yaml`
- **Session notes:** `{test_artifacts}/tea-academy/{your-name}/session-{N}-notes.md`
- **Certificate:** `{test_artifacts}/tea-academy/{your-name}/tea-completion-certificate.md`

## Quiz Scoring

- **Passing threshold:** ≥70%
- **On failure:** Option to review content or continue anyway
- **Attempts:** 3 attempts per question before showing correct answer

## Completion

Complete all 7 sessions to receive your TEA Academy completion certificate with:

- Session completion dates and scores
- Skills acquired checklist
- Learning artifacts paths
- Recommended next steps

## Tips for Success

1. **Set aside dedicated time** - Each session requires focus (30-90 min)
2. **Take notes** - Session notes are generated, but add your own insights
3. **Apply immediately** - Practice concepts on your current project
4. **Explore fragments** - Session 7 has 35 knowledge fragments to deep-dive
5. **Share with team** - Help others learn by sharing your experience

## Customization by Role

The workflow adapts examples based on your role:

- **QA:** Practical testing focus, workflow usage
- **Dev:** Integration perspective, TDD approach
- **Lead:** Architecture decisions, team patterns
- **VP:** Strategy, ROI, quality metrics

## Troubleshooting

### Progress file corrupted

- Workflow detects corruption and offers fresh start
- Backup file created automatically

### Missing TEA docs

- Workflow uses Web-Browsing fallback for external frameworks
- Primary source is always local docs

### Session interrupted

- Progress auto-saved after quiz completion
- Resume from session menu on next run

## Support

- **Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/>
- **Knowledge Fragments:** <https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/tree/main/src/testarch/knowledge>
- **Issues:** Report via TEA module repository
