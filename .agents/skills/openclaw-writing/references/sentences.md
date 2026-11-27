# Sentence rules

Rules for every sentence a person reads, in product text and in docs. Check each rule against each sentence. Where product text and docs differ, the rule says so.

## Voice

- Address the reader as “you”. When OpenClaw acts, name it: “OpenClaw removes the account for {name}.”
- Use the active voice and put the actor first. If a sentence still parses with “by someone” added after the verb, name the someone.
- Use the imperative for steps and buttons: “Choose another model.”
- Use the present tense. The future tense is for what has not happened yet: “This page will retry automatically.”
- Use contractions: couldn’t, can’t, isn’t, doesn’t.
- Write statements. A question belongs where the reader answers it, such as a confirmation title.
- Say “we” for a deliberate choice by the project, such as “we recommend”. The reader is always “you”.
- Aim for sentences under 20 words. A UI string is one or two sentences.
- Read each sentence once at speaking pace. If you went back to parse it, rewrite it as subject, action, consequence.
- Keep the same level tone for success and failure. Sentences end with a period.

## Concision

- Keep a number, a name, or a mechanism when it changes what the reader understands or does.
- Give the figure or the specific case where a vague word would go: “up to 2 MB” for “small”, the count or the condition for “many”, “often”, “typically”, and “generally”.
- Describe the action concretely where “easy”, “simple”, or “quick” would go: “one command”, “the default settings”.
- Write the sentence without “very”, “just”, “really”, “simply”, and “please”. It is stronger.
- Use the literal verb for what happens: the browser fetches the page. OpenClaw saves the file.

## Paragraphs

These apply to docs and to help text longer than two sentences.

- Open each paragraph with its own point.
- Join ideas that depend on each other into one sentence. Short sentences are for emphasis.
- Carry the subject forward from the paragraph before, with an opening such as “Because” or “Once”.
- Make the reader or OpenClaw the subject: “You can change the limit in Settings.”
- Take the angle from this page's subject and facts.
- Keep a paragraph to two to four sentences and one idea.

## Words

- Look up relevant rows in the root `GLOSSARY.md`. Use the term for its stated meaning. An Avoid phrase is scoped to that meaning, not a blanket replacement inside commands or unrelated technical text.
- Write American English.
- Use the serial comma: “channels, tools, and skills”.
- In docs, spell out an acronym the first time and define each term where it first appears. In product text, use the form the reader sees on screen.

## Capitalization

- Use sentence case for headings, titles, labels, and buttons: “Copy public link”, “Getting started”.
- Capitalize product names as the glossary writes them: OpenClaw, Gateway, Control UI, ClawHub.
- Names of pages and controls keep their on-screen capitalization: Settings, Labs, Models.

## Punctuation and typography

- Where a dash would join two parts of a sentence, use a colon, a comma, a period, or a rewrite.
- Product text uses curly quotes and apostrophes: “Couldn’t”. Docs Markdown keeps straight quotes, as the existing pages do.
- End a loading label with its last word: “Saving”. Use no ellipsis, either the single character or three dots, in reader-facing prose. Removing it is copy-only cleanup. New spinners or animations are separate UI work.
- Use a period, a conjunction, or a rewrite instead of a semicolon. Both punctuation rules belong in the copy lint.
- Put a space between a number and its unit: 2 MB, 512 KB, 30 seconds.
- Write a menu path with an arrow between its steps: Settings → Labs.
- Use “&” where space is tight, such as a tab label: “Model & Effort”. Elsewhere write “and”.
- Full sentences end with a period. Labels, titles, and buttons have no closing period.

## Emphasis and code formatting

- In docs, bold marks a UI element the reader acts on, or one critical fact.
- In docs, inline code marks paths, commands, identifiers, and values: text that would look wrong outside a monospace font.
- Product text is plain words. Its nouns are glossary terms, so it needs no code formatting.

## Links

- Link text names the destination: the page title, or the thing the reader gets there.
- Error messages link to the exact OpenClaw setting that fixes the problem. Use an existing docs section only for an OpenClaw fix outside the Control UI, such as paired-device or CLI setup. Provider-side problems and other cases get the sentence alone, with a local recovery action only when available.
- Format channel setting links as a linked phrase where supported, otherwise a phrase followed by its reachable address. Without a reachable address, name the place in words. See [product text](product-text.md#settings-and-recovery-links).
- Other product help may link to the relevant page on `https://docs.openclaw.ai`.
- Inside docs, links follow the [published link rules](../../../../docs/AGENTS.md#published-link-rules).

## Local copy check

The focused checker enforces the semicolon and ellipsis rules on extracted prose. With a selected glossary meaning, it checks that row's Avoid phrases from the same source as lookup. It does not infer a word's meaning, scan code, or rewrite technical literals.

Run `node .agents/skills/openclaw-writing/scripts/copy-check.mjs <extracted-copy.json>`. The input is a JSON array such as `[{"text":"Remove the saved sign-in.","meaning":"account"}]`. Omit meaning for punctuation-only checks. Keep literal before quotations and code snippets out of extracted prose. This local helper is not yet wired into repository-wide copy extraction or CI.

## Lists

- Three or more parallel items become a list.
- Number the steps of a sequence. Use bullets for everything else.
- Introduce a list with a sentence that ends in a colon.
- A list item closes with a period only when it is a full sentence.
- Write term-and-description items as `- **Term**: description`.
