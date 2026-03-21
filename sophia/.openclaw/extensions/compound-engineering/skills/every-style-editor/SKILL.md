---
name: every-style-editor
description: This skill should be used when reviewing or editing copy to ensure adherence to Every's style guide. It provides a systematic line-by-line review process for grammar, punctuation, mechanics, and style guide compliance.
---

# Every Style Editor

This skill provides a systematic approach to reviewing copy against Every's comprehensive style guide. It transforms Claude into a meticulous line editor and proofreader specializing in grammar, mechanics, and style guide compliance.

## When to Use This Skill

Use this skill when:
- Reviewing articles, blog posts, newsletters, or any written content
- Ensuring copy follows Every's specific style conventions
- Providing feedback on grammar, punctuation, and mechanics
- Flagging deviations from the Every style guide
- Preparing clean copy for human editorial review

## Skill Overview

This skill enables performing a comprehensive review of written content in four phases:

1. **Initial Assessment** - Understanding context and document type
2. **Detailed Line Edit** - Checking every sentence for compliance
3. **Mechanical Review** - Verifying formatting and consistency
4. **Recommendations** - Providing actionable improvement suggestions

## How to Use This Skill

### Step 1: Initial Assessment

Begin by reading the entire piece to understand:
- Document type (article, knowledge base entry, social post, etc.)
- Target audience
- Overall tone and voice
- Content context

### Step 2: Detailed Line Edit

Review each paragraph systematically, checking for:
- Sentence structure and grammar correctness
- Punctuation usage (commas, semicolons, em dashes, etc.)
- Capitalization rules (especially job titles, headlines)
- Word choice and usage (overused words, passive voice)
- Adherence to Every style guide rules

Reference the complete [EVERY_WRITE_STYLE.md](./references/EVERY_WRITE_STYLE.md) for specific rules when in doubt.

### Step 3: Mechanical Review

Verify:
- Spacing and formatting consistency
- Style choices applied uniformly throughout
- Special elements (lists, quotes, citations)
- Proper use of italics and formatting
- Number formatting (numerals vs. spelled out)
- Link formatting and descriptions

### Step 4: Output Results

Present findings using this structure:

```
DOCUMENT REVIEW SUMMARY
=====================
Document Type: [type]
Word Count: [approximate]
Overall Assessment: [brief overview]

ERRORS FOUND: [total number]

DETAILED CORRECTIONS
===================

[For each error found:]

**Location**: [Paragraph #, Sentence #]
**Issue Type**: [Grammar/Punctuation/Mechanics/Style Guide]
**Original**: "[exact text with error]"
**Correction**: "[corrected text]"
**Rule Reference**: [Specific style guide rule violated]
**Explanation**: [Brief explanation of why this is an error]

---

RECURRING ISSUES
===============
[List patterns of errors that appear multiple times]

STYLE GUIDE COMPLIANCE CHECKLIST
==============================
✓ [Rule followed correctly]
✗ [Rule violated - with count of violations]

FINAL RECOMMENDATIONS
===================
[2-3 actionable suggestions for improving the draft]
```

## Style Guide Reference

The complete Every style guide is included in [EVERY_WRITE_STYLE.md](./references/EVERY_WRITE_STYLE.md). Key areas to focus on:

- **Quick Rules**: Title case for headlines, sentence case elsewhere
- **Tone**: Active voice, avoid overused words (actually, very, just), be specific
- **Numbers**: Spell out one through nine; use numerals for 10+
- **Punctuation**: Oxford commas, em dashes without spaces, proper quotation mark usage
- **Capitalization**: Lowercase job titles, company as singular (it), teams as plural (they)
- **Emphasis**: Italics only (no bold for emphasis)
- **Links**: 2-4 words, don't say "click here"

## Key Principles

- **Be specific**: Always quote the exact text with the error
- **Reference rules**: Cite the specific style guide rule for each correction
- **Maintain voice**: Preserve the author's voice while correcting errors
- **Prioritize clarity**: Focus on changes that improve readability
- **Be constructive**: Frame feedback to help writers improve
- **Flag ambiguous cases**: When style guide doesn't address an issue, explain options and recommend the clearest choice

## Common Areas to Focus On

Based on Every's style guide, pay special attention to:

- Punctuation (comma usage, semicolons, apostrophes, quotation marks)
- Capitalization (proper nouns, titles, sentence starts)
- Numbers (when to spell out vs. use numerals)
- Passive voice (replace with active whenever possible)
- Overused words (actually, very, just)
- Lists (parallel structure, punctuation, capitalization)
- Hyphenation (compound adjectives, except adverbs)
- Word usage (fewer vs. less, they vs. them)
- Company references (singular "it", teams as plural "they")
- Job title capitalization
