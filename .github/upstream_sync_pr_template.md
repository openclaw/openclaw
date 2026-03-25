## Summary

- Upstream source: `openclaw/openclaw`
- Upstream target ref: `upstream/main`
- Upstream commit: `{{UPSTREAM_SHA}}`
- Previous fork base on `origin/main`: `{{BASE_SHA}}`

## Conflict Summary

- [ ] No manual conflict resolution was needed
- [ ] Conflict resolution was needed and documented below

If any conflicts were resolved manually, list the touched areas and why:

- Area:
  - Resolution:

## Fork-Specific Areas To Review

- [ ] `mctl` OAuth / gateway integration
- [ ] OpenAI Codex / auth persistence
- [ ] `mctl-agent` webhook + auto-claim behavior
- [ ] Whisper/runtime packaging and cache restore
- [ ] Trusted-proxy / MCTL platform assumptions

## Required Smoke Checks Before Merge

- [ ] CI green for this PR
- [ ] New fork tag created after merge
- [ ] Image build succeeds
- [ ] `labs-openclaw` rolls out `Synced Healthy`
- [ ] `mctl` connect/status/refresh sanity check
- [ ] Codex connect sanity check
- [ ] Hook endpoint / session sanity check
- [ ] One basic chat/session sanity check

## Notes

- Any upstream changes that should be upstreamed back from this fork:
- Any local patches that can now be removed:
