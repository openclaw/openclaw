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
and change it through reviewed pull requests. Automated suggestions are a
starting point; the reviewer's edit is the source of truth.

When the [hosted catalog](/concepts/models#hosted-catalog-updates) is published,
each provider's served model ids are matched against the list; deprecated,
disabled, and replaced rows never match. Catalog v2 lists the
matches as that provider's `recommendedModels`, in list order and under the
provider's own ids. When a provider serves several listed models of one family,
only the newest appears. Providers without matching catalog rows get no list,
and catalog v1 carries none. Model pickers list a provider's recommended models
first and collapse its other models under **All models**; see
[Models](/concepts/models#selection-source-and-fallback-strictness).

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
Keep the predecessor listed while some providers serve only the predecessor; a
provider that serves both shows only the successor.

**New class.** A model whose family name differs from every listed family, such
as a new `-mini` or `-pro` tier, is a new class, never an automatic successor.
A reviewer decides whether it belongs on the list and where.

**Fast variants.** `-fast`, `-highspeed`, and similar serving variants fold
into the base model. List the base id only.

**Dropping.** Remove an entry when its vendor deprecates or retires it, or when
every provider that serves it also serves its successor.

**Ordering.** Start from the model's Arena agent score, then break ties and
fill gaps with observed usage. A reviewer may move any entry; human judgement
overrides both signals.
