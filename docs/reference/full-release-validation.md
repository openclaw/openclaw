---
doc-schema-version: 1
summary: "Index of the Full Release Validation reference, one page per reader job"
title: "Full release validation"
read_when:
  - Running or rerunning Full Release Validation
  - Comparing stable and full release validation profiles
  - Debugging release validation stage failures
---

`Full Release Validation` is the release product-validation umbrella. Most work
happens in child workflows so a failed box can be rerun without restarting the
whole release.

This page is an index. The reference is documented on seven pages, one per
reader job. Open the page that matches your task and complete that validation
pass there.

| Page                                                                                                | Read it when                                                                              |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Dispatch a validation run](/reference/full-release-validation/dispatch)                            | Starting a run: Code SHA, Tooling SHA, helper inputs, and the immutable execution plan.   |
| [Continue a failed validation](/reference/full-release-validation/continuation)                     | Rerunning failed child jobs on an existing parent, and the post-merge continuation proof. |
| [Extended-stable and changelog-only validation](/reference/full-release-validation/extended-stable) | Extended-stable dispatch, changelog-only reuse, coverage policies, and Telegram waivers.  |
| [Top-level stages](/reference/full-release-validation/stages)                                       | The umbrella stage matrix, evidence reuse, artifact producers, and decision states.       |
| [Release checks stages](/reference/full-release-validation/release-checks)                          | The `OpenClaw Release Checks` stage matrix and the Docker release-path chunks.            |
| [Release profiles and focused reruns](/reference/full-release-validation/profiles)                  | Comparing profile coverage and picking a focused `rerun_group` or suite filter.           |
| [Evidence to keep](/reference/full-release-validation/evidence)                                     | Recording evidence after a pass, and the backing workflow files.                          |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as
`/reference/full-release-validation#post-merge-continuation-proof` still
resolves. Each entry points at the page that now holds the content.

- <a id="continue-failed-child-jobs" />[Continue failed child jobs](/reference/full-release-validation/continuation#continue-failed-child-jobs)
- <a id="post-merge-continuation-proof" />[Post-merge continuation proof](/reference/full-release-validation/continuation#post-merge-continuation-proof)
- <a id="extended-stable-validation" />[Extended-stable validation](/reference/full-release-validation/extended-stable#extended-stable-validation)
- <a id="top-level-stages" />[Top-level stages](/reference/full-release-validation/stages#top-level-stages)
- <a id="release-checks-stages" />[Release checks stages](/reference/full-release-validation/release-checks#release-checks-stages)
- <a id="docker-release-path-chunks" />[Docker release-path chunks](/reference/full-release-validation/release-checks#docker-release-path-chunks)
- <a id="release-profiles" />[Release profiles](/reference/full-release-validation/profiles#release-profiles)
- <a id="full-only-additions" />[Full-only additions](/reference/full-release-validation/profiles#full-only-additions)
- <a id="focused-reruns" />[Focused reruns](/reference/full-release-validation/profiles#focused-reruns)
- <a id="evidence-to-keep" />[Evidence to keep](/reference/full-release-validation/evidence#evidence-to-keep)
- <a id="workflow-files" />[Workflow files](/reference/full-release-validation/evidence#workflow-files)

## Related

- [Releasing](/reference/RELEASING)
- [Release validation workflows](/ci/release-validation)
- [Release performance sweep](/reference/release-performance-sweep)
