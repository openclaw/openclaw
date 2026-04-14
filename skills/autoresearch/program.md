# Autoresearch Program

**Goal:** Improve the routing accuracy of all 55 OpenClaw skills by editing each skill's `frontmatter.description` field.

**Metric:** Global macro-F1 from `evaluate.mjs`, computed by having a Haiku router predict the correct skill for 1,100 synthetic `{message → skill}` pairs.

**Constraints for edits:**
- Description length: 50–500 characters
- No keyword stuffing (same word ≥5 times)
- Semantic cosine similarity with previous description must be ≥0.5 (edit, don't rewrite)

**What can be edited:** Only the `description` field of a skill's YAML frontmatter.

**What cannot be edited:** Anything else. Evaluate.mjs. Eval set. Pool.json (except via graduation).
