## Summary

Fixes #47139

Previously, the Control Panel displayed workspace-installed skills as "bundled" when they shared names with bundled skills (e.g., summarize, nano-pdf, video-frames). This was because the bundled check used `bundledNames.has(entry.skill.name)` instead of checking the actual source path.

### Root Cause
The `bundled` property in `buildSkillStatus` checked if the skill name existed in `bundledNames` set, rather than checking the actual `source` field of the skill entry. This caused workspace-installed copies of bundled skills to be incorrectly displayed as bundled.

### Fix
Now the `bundled` property is determined solely by the skill's `source` field, which correctly reflects where the skill was loaded from.

### Test Plan
1. Install a skill from ClawHub that originally came bundled with OpenClaw (e.g., summarize, video-frames)
2. Open Control Panel Web UI
3. Check skills list
4. Verify the skill shows as "workspace" instead of "bundled"

Also verify `openclaw skills list` and Control Panel show consistent source values.
