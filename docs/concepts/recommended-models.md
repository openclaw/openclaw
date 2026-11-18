---
summary: "How the curated recommended model list is reviewed, ordered, and published"
title: "Recommended models"
read_when:
  - Reviewing a change to the recommended model list
  - Adding, replacing, or dropping a recommended model
  - Deciding the order of recommended models
---

# Recommended models

OpenClaw keeps one global, ordered list of recommended models. It names the
models OpenClaw suggests first, independent of which provider serves them, so
one entry covers every provider that serves that model. A provider may also
publish its own featured list, which leads that provider's recommendations.

Maintainers curate the list by hand in
[`scripts/lib/recommended-models.json`](https://github.com/openclaw/openclaw/blob/main/scripts/lib/recommended-models.json)
and change it through reviewed pull requests. This is a curated shortlist, not
a history of previously recommended models or a list of everything providers
serve. Automated suggestions are a starting point; the reviewer's edit is the
source of truth. Removing a recommendation does not remove that model from the
full availability catalog, manual selection, or existing runtime defaults.

When the [hosted catalog](/concepts/models#hosted-catalog-updates) is published,
each provider's served model ids are matched against the list; deprecated,
disabled, and replaced rows never match. Catalog v2 lists the
matches as that provider's `recommendedModels`, in list order and under the
provider's own ids. When a provider serves several listed models of one family,
only the newest appears. Providers without matching catalog rows get no list,
and catalog v1 carries none. Model pickers list a provider's recommended models
first and collapse its other models under **All models**; see
[Models](/concepts/models#selection-source-and-fallback-strictness).

After an upgrade, a compatible stored catalog can still supply recommendations
even when it is older than the installed build. Its older model rows and prices
are not used. Pickers match recommendations only against currently available
rows, so a recommendation cannot bring back a retired or hidden model.

## Provider featured lists

Some providers publish the models they want to feature. NVIDIA is currently the
only one; its feed is
`https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json`.
At publication, each featured id is matched to that provider's served rows by
normalized id, so `z-ai/glm-5-3` matches `z-ai/glm-5.3`. That provider's
`recommendedModels` lists its featured models first, in feed order and under
its own ids, then the global list's matches that are not already included.

Provider picks win as listed: the family rule only trims the global part, so a
featured model stays even when the provider also serves a newer listed member
of its family. Featured ids the provider does not serve, or serves only as
deprecated, disabled, or replaced rows, are skipped and logged. When the feed
is unavailable, malformed, empty, or matches no served model, the provider gets
the global list alone.

## Entry format

The file is a JSON array of normalized model ids, best first. It holds ids only:
no scores, providers, or comments.

A normalized id is the vendor-neutral name of a model:

- lowercase, without a vendor or route prefix (`claude-opus-5.5`, not `anthropic/claude-opus-5.5`)
- dotted versions (`claude-opus-4.5`, not `claude-opus-4-5`; `glm-5.3`, not `glm-5p3`)
- no release dates, revision stamps, or serving variants such as `-fp8`, `-free`, or `-batch`

Publication fails when OpenClaw's id normalization would change an entry, when
an entry appears twice, or when the list exceeds 200 entries. The previous
hosted catalog then stays in place.

## Review rules

**Family.** A model's family is its id with the version numbers removed:
`gpt-5.6-luna` and `gpt-6-luna` are both `gpt-luna`; `qwen3.8-27b` keeps its
size and is `qwen-27b`.

**Successor.** A newer version in the same family is a successor. It takes its
predecessor's position, including on launch day; do not wait for usage data.
Remove the superseded recommendation in the same change. Provider availability
alone is not a reason to keep the predecessor: a provider that serves only the
older model may have no global recommendation for that family. Retain an older
model only for a specific independent recommendation merit, such as a measured
cost, latency, or task-quality advantage, and record that reason in the PR.

The suggestion generator proposes the newest explicitly versioned member of
each canonical family and reports superseded entries for removal, even when
the older model is still served. It also replaces an unranked curated
predecessor when usage data is unavailable. Review aliases and distinct classes
manually rather than treating an unversioned id as an older release.

**New class.** A model whose family name differs from every listed family, such
as a new `-mini` or `-pro` tier, is a new class, never an automatic successor.
A reviewer decides whether it belongs on the list and where.

**Fast variants.** `-fast`, `-highspeed`, and similar serving variants fold
into the base model. List the base id only.

**Dropping.** Remove an entry when its vendor deprecates or retires it, or when
it is superseded without an independent recommendation reason to retain it.
Do not wait for every provider to offer the successor.

**Same-model aliases.** Separate canonical ids may still refer to one release.
For example, `muse-wonder` and `muse-wonder-1` name the same recommended model,
not an older and newer recommendation. Keep both while the identity owner
distinguishes them; do not infer a version upgrade from the added `-1` alone.

**Ordering.** Start from the model's Arena agent score, then break ties and
fill gaps with observed usage. A reviewer may move any entry; human judgement
overrides both signals.
