# Docs pages

Reference for pages under `docs/`. The [docs guide](../../../../docs/AGENTS.md) owns links, placeholders, generated pages, local preview, and translations; read it first. This file covers how a page is shaped and what it must be checked against. To restructure an existing page, use the [openclaw-refactor-docs](../../openclaw-refactor-docs/SKILL.md) skill for the workflow and this file for the standard.

## One page, one job

Choose the page type before writing or reviewing, and keep the page to that job:

- **Overview**: routes readers to the right product area, integration path, or guide.
- **Quickstart**: gets a new user to a working result with the fewest safe steps.
- **Topic page**: explains a major OpenClaw entity or surface end to end.
- **Guide**: walks through one workflow from prerequisites to production readiness.
- **Reference**: defines every object, method, command, option, response, error, enum, default, and version rule in scope.
- **Testing guide**: shows sandbox setup, fixtures, simulated failures, and live-mode differences.
- **Troubleshooting guide**: maps observable symptoms to checks, causes, and fixes.

Title the page with what the reader came to do or to understand, in their words.

## The reader

- Lead with the task the reader is trying to complete.
- Give one recommended path before alternatives.
- Keep the main page on the common path. Dense contracts and rare debugging detail go to a linked reference or troubleshooting page.
- Explain a production risk at the point where the reader can make the mistake.
- Link concepts, guides, references, CLI pages, and troubleshooting so the reader can continue without rereading.

## Shape

- Open with one unheaded paragraph that says what the page covers, or what the thing is and what it is for, in words a first-time reader has.
- Open each major section with the sentence that carries its point.
- Write headings a reader can predict the section from: “Caveats when self-hosting behind a proxy” tells more than “Caveats”.
- Organize reference pages by surface and teaching pages by reader task.

A topic page runs in this order: the title naming the entity or surface; the unheaded opening; requirements, when setup needs accounts, versions, permissions, plugins, operating systems, or credentials; a quickstart with the recommended path and the smallest reliable verification; configuration, with task-critical options inline and exhaustive detail linked; subtopics under headings named for what the reader wants; troubleshooting with observable failures and concrete checks; related links.

A guide runs in this order: the title naming the outcome; an opening that states what the reader can accomplish; “Before you begin” with accounts, keys, permissions, versions, tools, and assumptions; “Choose a path” when the reader must decide; steps with verb-led headings, commands, expected output, and checks; a test with the smallest reliable proof; production readiness; troubleshooting beside the step that causes the failure; related links.

## Facts

- Document what the product does now. Keep current behavior, shipped behavior, planned behavior, and maintainer intent apart.
- CLI pages match the current flags, output, errors, and examples.
- API and SDK pages give fields, defaults, enum values, constraints, nullable behavior, lifecycle states, errors, and recovery.
- Config pages agree with the exported types, the schema and help output, and the metadata.
- Behavior that comes from a dependency is verified in its docs, source, or types before the page states a default, a timing, or an error.

## Commands and code

- Give complete commands and snippets the reader can paste, with realistic names and values.
- Put one conceptual unit in each code block and tag its language.
- Say in prose what each block does. Show the expected output when it helps the reader verify.
- Show setup, sign-in, error handling, and cleanup where the example needs them.
- Write placeholders and fake credentials as the docs guide specifies.
- Wrap a multi-step flow in the docs site's `<Steps>` component.

## Navigation

- Read `docs/docs.json` before changing navigation.
- Keep topic pages and common workflows on the main reader path. Exhaustive contracts, generated references, and maintainer-only detail go under Reference.
- Add “Read when” hints in front matter for pages that take part in the docs index.
- For moved pages, give a keep, drop, move, and destination table in the handoff.

## Rewrites and splits

- List the source units before rewriting: headings, paragraphs, tables, examples, CLI and API contracts, warnings, and troubleshooting facts.
- Map each retained unit to its destination page or section, at line or claim level when the source is dense.
- For each dropped unit, say whether it is obsolete, duplicated elsewhere, unsupported, or moved.

## Checks

Run the narrowest set that covers what you touched, and name any check you could not run and why:

- `pnpm docs:list`
- `pnpm docs:check-mdx`
- `pnpm docs:check-links`
- `pnpm format:docs:check` or `pnpm lint:docs`
- `git diff --check`
- A command probe or behavior test when the page claims runtime behavior.
