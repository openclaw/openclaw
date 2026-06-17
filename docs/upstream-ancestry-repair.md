# Upstream Ancestry Repair

PR #99 caught `Rockielab/rockie-claw` up to OpenClaw commit
`d1b33a6040a47e39aa53500b818f9ed172b769de`, but it was squash-merged as
`c35f6665ab57dcf64c0cd4cb66b879a672788db2`. That means GitHub cannot see the
upstream OpenClaw commit as an ancestor of `main`, even though the original PR
head preserved that ancestry.

This document records the safe repair proof. It does not rewrite public
history. Moving `main` onto the ancestry-preserving line requires explicit
repository-owner approval.

## Pinned State

| Item | Value |
| --- | --- |
| Current `origin/main` commit | `c35f6665ab57dcf64c0cd4cb66b879a672788db2` |
| Current `origin/main` tree | `93d51edc21b8550be41c060bd10387b3ae93cd03` |
| PR #99 head | `b5eb09cbdc7242bbcbe3af767eb10816ac445c42` |
| Upstream OpenClaw anchor | `d1b33a6040a47e39aa53500b818f9ed172b769de` |
| Proof branch | `ancestry-proof/rockie-claw-pr99-tree` |
| Proof branch commit | `83f7208bd6` |

## Drift From PR #99 Head

The post-head drift from `b5eb09c` to current `origin/main` is intentionally
limited to these paths:

```text
M  Dockerfile.multitenant
M  apps/broker/README.md
M  apps/broker/chat_pty.go
M  apps/broker/chat_pty_test.go
M  apps/broker/main.go
A  apps/broker/skill_overlay.go
A  apps/broker/skill_overlay_test.go
```

`git diff --stat b5eb09cbdc7242bbcbe3af767eb10816ac445c42..c35f6665ab57dcf64c0cd4cb66b879a672788db2`
reported:

```text
7 files changed, 1081 insertions(+), 144 deletions(-)
```

## Proof Transcript

The proof branch was created from the ancestry-preserving PR #99 head:

```sh
git switch -c ancestry-proof/rockie-claw-pr99-tree b5eb09cbdc7242bbcbe3af767eb10816ac445c42
git checkout c35f6665ab57dcf64c0cd4cb66b879a672788db2 -- \
  Dockerfile.multitenant \
  apps/broker/README.md \
  apps/broker/chat_pty.go \
  apps/broker/chat_pty_test.go \
  apps/broker/main.go \
  apps/broker/skill_overlay.go \
  apps/broker/skill_overlay_test.go
git commit -m "chore: prove pr99 ancestry repair"
```

The verification checks passed:

```text
git merge-base --is-ancestor d1b33a6040a47e39aa53500b818f9ed172b769de HEAD
d1b33a6_ancestor=0

git merge-base --is-ancestor b5eb09cbdc7242bbcbe3af767eb10816ac445c42 HEAD
b5eb09c_ancestor=0

git diff --exit-code c35f6665ab57dcf64c0cd4cb66b879a672788db2^{tree} HEAD^{tree}
tree_diff=0
```

The proof branch therefore has both required ancestors and the same tree as the
current pinned `origin/main`.

## Safe Repair Path

1. Review the proof branch and confirm its tree still matches the pinned
   current `main` tree.
2. Open a visible repair PR or repository-owner change that makes the proof
   lineage the public `main` lineage.
3. Do not squash or rebase the repair. The point is to preserve ancestry.
4. After repair, future upstream-sync PRs should use real merge commits for
   upstream catch-up work.

Do not force-push or otherwise rewrite public `main` without explicit
repository-owner approval.
