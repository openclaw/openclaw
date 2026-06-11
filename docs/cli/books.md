---
summary: "CLI reference for `openclaw books` review-pack book generation"
read_when:
  - You want to create original review-ready book packages
  - You are configuring local book writing with LM Studio
  - You are checking book-writer model memory caps or artifacts
title: "Books"
---

# `openclaw books`

Create original, review-ready book packages with the bundled `book-writer` plugin.

The v1 target is a review pack, not automatic final publishing. The plugin prepares manuscript, metadata, gates, EPUB, print HTML, cover brief, and KDP preview notes. Final KDP submit remains approval-gated.

## Defaults

- Local provider: LM Studio
- Local model: provider-specific `localModel`; LM Studio defaults to `Qwen/Qwen3-30B-A3B-Instruct-2507`, while Ollama defaults to `qwen2.5:32b` unless `agents.defaults.model.primary` or plugin config selects another Ollama model
- Ollama provider: supported through Ollama's native local endpoint at `http://127.0.0.1:11434`
- Normal memory cap: 64 GB
- Ideal memory cap: 80 GB
- Premium memory cap: 96 GB
- Hard reject: over 110 GB measured peak memory
- Default context target: 32k
- Large model concurrency: never

## Common commands

```bash
openclaw books init
openclaw books model-bench --json
openclaw books schedule-preview --target-words 12000 --json
openclaw books endurance-preview --target-words 45000 --model qwen2.5:32b --json
openclaw books schedule-install --model qwen2.5:32b --target-words 12000 --gateway-cron-dry-run --json
openclaw books overnight-run --model qwen2.5:32b --target-words 12000 --json
openclaw books review-pack \
  --topic "An original clean mystery about a bridge inspector who uncovers invoice fraud" \
  --target-words 12000 \
  --live-model
openclaw books planning-create \
  --topic "An original book about local AI publishing operations" \
  --target-words 12000 \
  --json
openclaw books planning-draft --run-id 20260518-063000-example --json
openclaw books planning-propagate --run-id 20260518-063000-example --json
openclaw books planning-stitch --run-id 20260518-063000-example --json
openclaw books publish-dry-run --run-id 20260518-063000-example --json
```

All commands support `--json`.

## Workflow commands

```bash
openclaw books plan
openclaw books write
openclaw books gate
openclaw books package
openclaw books review-pack
openclaw books schedule-install
openclaw books scheduler-tick
openclaw books overnight-run
openclaw books publish-dry-run --run-id <run-id>
openclaw books planning-create
openclaw books planning-export --run-id <run-id>
openclaw books planning-save --file <book-plan.json> --base-version <version>
openclaw books planning-draft --run-id <run-id>
openclaw books planning-propagate --run-id <run-id>
openclaw books planning-stitch --run-id <run-id>
openclaw books quick-read --source-run-id <run-id>
```

Each run is resumable with `--run-id`. Use `--output-dir` to place artifacts outside the default OpenClaw state directory.

## Planning Studio

The Control UI includes a Book Studio dashboard for paragraph-level planning. It stores the editable source of truth as `book-plan.json` in each run directory. The plan contains the topic brief, chapter titles and descriptions, chapter role/feel, editor-only paragraph labels, paragraph instructions, generated/editable paragraph text, lock state, cover brief, publishing checklist, artifact links, version number, and revision history. Book Studio also writes invisible cohesion artifacts beside the plan: `book-canon.json`, `hierarchical-memory.json`, `locked-constraints.json`, `scene-graph.json`, `cohesion-plan.json`, `revision-map.json`, `final-cohesion-report.json`, `genre-excellence-report.json`, `book-quality-score.json`, `story-impact-report.json`, `story-sync-report.json`, and `storyline-overview.json`. These artifacts keep whole-book premise, reader promise, chapter continuity, scene purpose, storyline overview, story-impact status, and locked-text obligations available to drafting without changing the current dashboard workflow.

Book Studio supports target lengths down to 250 words for flash fiction or very short stories. Changing target words updates the plan target plus chapter and paragraph target allocations, so the actual book plan follows the selected length instead of keeping stale long-book targets. If an existing draft's chapter count no longer fits the selected length, the dashboard shows **Structure mismatch** with **Rebalance structure**; that action condenses chapter and paragraph cards to the new target, preserves locked paragraphs, and marks Book Sync as needing refreshed Book Text. Book Studio now tracks major plot-twist edits as story-impact events. When saved paragraph text introduces a whole-book change such as a villain reveal, secret relationship, betrayal, false death, unreliable narrator reveal, hidden motive, identity reveal, or new clue/payoff, the saved plan records a Book Sync state such as **Needs Propagation** or **Locked Conflict Found** instead of pretending the rest of the book is already updated. The Book Control Bar shows a short **Storyline Overview** plus a **Book Sync** summary with affected chapter count and locked-block risk. **Propagate Change Through Book** rewrites only editable affected paragraph cards with setup, reveal-bridge, payoff, and consequence obligations, preserves locked text, marks the pending story-impact event applied, and moves the sync state toward **Fully Updated** or **Cohesion Review Needed**. When the dashboard/gateway has a live Book Writer model available, propagation also asks the model to rewrite affected editable paragraphs from the revision obligations; otherwise it keeps the deterministic bridge text for review. The CLI equivalent is `planning-propagate`.

### Cohesive writing engine

The backend implementation plan is intentionally UI-light: keep the existing paragraph-card dashboard, but make the writing engine context-first. On every meaningful plan save, rewrite, regeneration, propagation, draft, or stitch operation, Book Studio rebuilds `hierarchical-memory.json` from `book-plan.json`, then uses relevant slices of that memory for generation. The memory data structures are:

- **Book Bible**: premise, genre, audience, tone, main storyline, stakes, themes, and ending direction.
- **Character Bible**: character names, roles, goals, motivations, arcs, current state, and evidence.
- **Timeline**: ordered chapter/paragraph events and consequences.
- **Chapter Map**: chapter purpose, summary, previous/next chapter links, plot threads, and setup/payoff needs.
- **Scene Map**: scene/paragraph purpose, emotional state, transition in, transition out, and paragraph ids.
- **Style Guide**: tone, prose rules, language/profanity rule, and cohesion rules.
- **Locked Text Map**: exact locked text, hash, fixed facts, and rules that forbid editing, paraphrasing, reordering, shortening, or expanding locked text while locked.

Paragraph rewrites use a paragraph context packet with the user instruction, selected paragraph, previous/next paragraph, scene purpose, chapter purpose and summary, book premise, main storyline, relevant character and timeline facts, style guide, future consequences, and locked-text rules. Chapter rewrites use a chapter context packet with the user instruction, chapter text, previous/next chapter summaries, book premise, main storyline, act structure, character arcs, timeline, unresolved plot threads, setup/payoff needs, style guide, and locked-text rules. The prompt architecture is fixed: expert role, task, context packet, constraints, brief plan, generation instruction, cohesion review, revision rule, and clean output. The paragraph prompt asks for exactly one reader-facing paragraph; the chapter prompt asks for a coherent chapter movement or the caller's requested JSON mapping; the cohesion audit prompt asks for JSON scores and repair instructions.

Impact logic classifies edits as **Local**, **Scene**, **Chapter**, or **Book**. Local edits stay near the selected text. Scene edits update scene logic, emotional continuity, and consequences. Chapter edits update chapter purpose, pacing, transition, setup, or payoff needs. Book edits involve plot, timeline, character arc, theme, twist, reveal, or ending direction and move Book Sync into a broader propagation/review state. Cohesion scoring checks flow, scene fit, chapter fit, book fit, timeline, character logic, plot logic, emotional continuity, style, clarity, pacing, and locked-text compliance on a 1-10 scale. Scores below 8 trigger one repair pass; scores below 6 are flagged for operator review. Short multi-chapter plans force the final chapter into a resolution/payoff role, and final-chapter prompts require closure instead of a new unresolved threat, warning, clue, or cliffhanger. The edit/update workflow is: assemble memory -> build packet -> generate -> score -> revise once when needed -> preserve locked text -> save plan -> rebuild memory/artifacts -> update story impact and storyline overview.

The dashboard defaults to a beginner-safe **Guided Builder** with one obvious next action: describe the book once, then click **Write my editable draft**. That one-click path creates editable chapters, paragraph plans, reader-facing Book Text, and a readable preview from the initial description, then lands the operator in Write so every paragraph can be edited. It shows resumable stage progress for **Making chapters -> Planning paragraphs -> Writing Book Text -> Building preview**, and **Finish editable draft** resumes from saved work if the browser refreshes or the first pass is interrupted. Operators who want slower control can choose **Just make chapters first** and follow Idea -> Chapters -> Plan -> Write -> Read -> Publish. Book Studio is manual-first: it can create a plan from one topic paragraph, write empty unlocked paragraphs from their plans, preserve locked text, build the visible Book Text into `manuscript.md`, create the quality package, and prepare the approval-gated KDP dry-run only from explicit operator actions. Locked Book Text is byte-for-byte protected while it remains locked; drafting treats it as immutable story truth, extracts fixed facts and required setup/consequence obligations, and repairs only surrounding editable text. The Idea step keeps the **Book Control Bar** visible with title, target words, drafted words, tone, custom voice preview, profanity level, audience, reader promise, current step, save state, and automation state; later steps switch the left rail to controls for that section so the workspace is not crowded by unrelated setup fields. The compact command bar also shows **Local AI** health: provider, model, endpoint reachability, whether the model is loaded/warm, latest benchmark facts, and the exact next fix when the local writer is offline or missing. Changing the target length rebalances chapter and paragraph targets and keeps the 90% quality threshold tied to the selected word count; tone and profanity edits persist when operators move between steps. The library's compact new-book starter stays topic-only and opens **Set up new book** for a simplified Idea setup before chapter generation. Each AI action opens a plain-English confirmation sheet that explains what AI will do, what it will not overwrite, and what the operator should check next; successful actions leave a short receipt so the next step is never ambiguous. The split between **Plan** and **Write** is intentional: **Plan for AI · what this paragraph will say** is an editable reader-facing paraphrase AI uses, while **Book Text** is the actual prose readers see. The stricter Book Text path now builds the pipeline `Book Context -> Chapter Context -> Scene Context -> Paragraph Context -> Generate -> Cohesion Check -> Revise -> Update Memory`: before any paragraph rewrite, Book Studio assembles a paragraph context packet with the user instruction, selected paragraph, previous/next paragraph context, scene purpose, chapter purpose/summary, book premise, live main-storyline tracker, relevant character/timeline facts, style guide, future consequences, and locked-text rules; before chapter-window generation, it assembles a chapter context packet with previous/future chapter summaries, act structure, character arcs, timeline, unresolved plot threads, setup/payoff needs, style guide, and locked-text rules. Prompts use a structured role/task/context/constraints/brief-plan/generation/cohesion-review/clean-output architecture and ask the model to behave as novelist, developmental editor, continuity editor, and line editor. Generated prose is scored from 1-10 for flow, scene fit, chapter fit, book fit, timeline, character logic, plot logic, emotional continuity, style, clarity, pacing, and locked-text compliance; anything below 8 gets one repair attempt, and anything still below 6 is flagged in the revision map. The memory artifact maintains Book Bible, Character Bible, Timeline, Chapter Map, Scene Map, Style Guide, Locked Text Map, and the main storyline tracker in the form “[Protagonist] wants [goal], but [conflict] creates [problem]. The stakes are [stakes], and the story is moving toward [ending/question].” Full-draft actions first try multi-paragraph chapter-window generation and map accepted prose back to paragraph cards, then fall back to single-paragraph generation for any unusable or missing outputs; generated prose then passes a lock-safe QA/repair step that records transition guidance, continuity obligations, repetition/thin-draft risks, cohesion scores, and adjacent-lock repair needs; paragraphs marked for repair get one AI revision attempt against the revision map and locked constraints before save; stitching runs a final manuscript-level cohesion audit for unresolved repair flags, full draft coverage, locked-block bridges, chapter-opening repetition, and final reader-promise callback, then runs genre-specific excellence checks for mystery clue/payoff logic, nonfiction/business/education practical application, memoir chronology/reflection, or fiction emotional arc before writing `manuscript.md`; it rejects instruction-like output such as "AI will", "Chapter focus", or "The paragraph should" and blocks stitching/package/publish until those paragraphs are repaired. AI helper buttons sit beside editable Idea, chapter, chapter-role, paragraph-plan, style-direction, Book Text, cover, and publish metadata fields; suggestions use the Context Fill Engine with surrounding book context, previous/next chapter and paragraph context, and locked text before/after as immovable story truth before opening a preview to apply. Chapter cards include **Chapter role** controls for story thread, plot job, reader feeling, and notes so mystery clues, side stories, twists, converging threads, and payoffs stay explicit. The compact top preview keeps the title, reader-facing text, written count, and locked-count safety state visible without a large cover fixture; if text still looks like old AI instructions, it warns that the paragraph needs Book Text before publishing. Build screens remove the active-draft rail, keep one section-specific left toolbar, and provide a clear **Home** button: Chapters can regenerate selected chapter fields, Plan Paragraphs can reflow a selected chapter into paragraph plans, Write can rewrite the focused paragraph with before/after locked context, and Read/Publish turns into a readiness checklist. Advanced regeneration, reordering, bulk editing, glossary, workflow map, and detailed packaging controls remain available in **Advanced View**. Chapter titles and paragraph labels are editing handles only and are not printed in the built manuscript.

The Read step includes a synchronized chapter jump selector and an optional **Book Preview** mode. Book Preview is read-only and uses final reader-facing Book Text only: paperback mode shows fixed, page-numbered title, contents, chapter, body, and index pages; eBook mode shows the same words in a reflowable reader with a note that Kindle page numbers vary by device and font.

The Idea and Chapters steps also include specialized-agent autofill controls. **AI generate idea setup** runs the Book Writer `idea-strategist` against the configured local provider/model and can fill selected fields for title, quick idea summary, reader promise, word count, tone, and audience/"What should this book be"; profanity is always reset to **Off** by that action unless the operator manually changes it afterward. **AI fill from Book Control Bar** rewrites only the "What should this book be?" field using the current control-bar title, reader promise, word count, tone, audience, pen name, genre, and clean-language rule. **AI generate chapter setup** runs the Book Writer `chapter-architect` and can fill selected chapter hook titles, **Plan for AI**, **Chapter style direction**, and **Chapter role** values. Chapter titles are prompted as reader-facing hooks based on what the chapter covers, including paragraph plans and existing Book Text, with enough tension, mystery, and concrete imagery to make the reader want the chapter. Locked chapters are never changed, locked fields inside unlocked chapters are preserved, and locked chapters are passed to the model as fixed before/after continuity anchors so regenerated chapter plans still flow around approved material. Every chapter box is labeled with its chapter number.

The book library includes quiet archive/copy/delete/restore and finished-book organization. Active unfinished books stay in the Home left rail with the New Book Idea starter only; **Copy book** creates a new editable draft with preserved idea, chapters, paragraphs, Book Text, locks, tone, and style settings while clearing publish proof and trophy metrics. **Archive draft** moves a draft under `_archived-books`, hides it from active work, and leaves it recoverable from a collapsed **Archived books** section with **Restore to drafts** and **Delete**. Deleting from the archive is safe by default: it moves the archived run to `_deleted-books` with a `deleted-book.json` recovery note before the permanent Recently Deleted delete path is available. Publish-ready but unpublished books are removed from the active-draft rail and shown on the landing page under **Completed books**. The landing page is the Book Studio home: **Trophy Room** published books are showcased first, **Completed books** sit underneath, and active drafts remain in the Home rail only. The **Trophy room** is published books only: it appears on the landing page, never inside Idea, Chapters, Plan Paragraphs, Write, Read, or Publish build pages. Active books keep destructive actions in the lower **Manage books** drawer; **Move to Recently Deleted** removes a book from active writing and moves the run directory under `_deleted-books` with a `deleted-book.json` recovery note, so cleanup does not silently erase the source files. The **Recently deleted** section restores recoverable books, deletes one book forever, or empties all recently deleted books after a plain confirmation; long deleted-book lists stay compact behind a reveal control so the active workspace remains readable. Published books moved to the Trophy room are stored under `_finished-books` with a `finished-book.json` note, publish proof, cover/source metadata, word count, and editable metrics snapshots for sales, revenue, ad spend, profit, reviews, categories, keywords, and notes; the Home recommendation card uses those published-book signals to propose the next book to build without auto-generating chapters or prose. Book cards use quick, reduced-motion-safe balloon hover feedback, and new active books or newly published trophy books show a celebratory sparkle/firework card.

The Publish step is deliberately a readiness handoff, not a vague button. If the book has not been checked, it shows **Check book quality first**. If Book Text is missing or instruction-like, quality/package/publish actions inspect only and show **Write missing Book Text** instead of silently generating prose. If the quality check is not approved, the Guided Builder puts **Fix this with AI** first; the advanced publish view still lists the exact issue and direct repair actions such as **Open Plan Paragraphs**, **Write missing Book Text**, and **Check book quality again**. Instruction-like Book Text is a hard blocker for stitching, packaging, and publishing. Once the quality package is approved, the late Publish cover section opens **Local AI Cover Studio**. **Generate Local AI Cover** uses the Book Writer `cover-art-director` prompt and the OpenClaw `image_generate` surface with local ComfyUI (`comfy/workflow`) when `agents.defaults.imageGenerationModel.primary` and the ComfyUI image workflow are configured. If local image AI is missing, the action falls back to **Create Editable SVG Concept** instead of silently doing nothing. Operators can also upload an image, use **Edit with Local AI** on a selected/reference cover, approve the selected cover, or explicitly choose the KDP Cover Creator route. **Prepare publishing** writes the upload manifest and action checklist only after the cover is approved or the KDP Cover Creator route is selected. When the dry-run is ready, the dashboard shows **Open KDP Bookshelf**, exact upload files, metadata, findings, the final-submit pause, and **Mark published · Move to Trophy Room** for books that were actually published; marking published asks for destination, published date, and optional ASIN, marketplace URL, price, category, and keywords.

The maintainer browser smoke covers both publish outcomes: a rejected quality package that must show the repair path, and an approved fixture that runs **Prepare publishing**, verifies exact KDP upload files, verifies the KDP handoff button, verifies Trophy Room is landing-page-only, and moves the published book into the Trophy room.

All dashboard saves use an optimistic `version` guard. If another client edits the same plan first, the save is rejected instead of silently overwriting newer work.

## Model benchmarking

Record measured local model facts before trusting a model for overnight work:

```bash
openclaw books model-bench \
  --model "Qwen/Qwen3-30B-A3B-Instruct-2507" \
  --measured-peak-gb 52 \
  --tokens-per-second 24 \
  --stable-context-tokens 32768 \
  --quality-score 0.82 \
  --json
```

To measure the active local model directly through LM Studio, Ollama, or another OpenAI-compatible local endpoint:

```bash
openclaw books model-bench \
  --model "Qwen/Qwen3-30B-A3B-Instruct-2507" \
  --live \
  --max-tokens 256 \
  --json
```

The live benchmark calls `/chat/completions` for LM Studio/custom OpenAI-compatible servers and Ollama's native `/api/chat` endpoint for Ollama, records measured completion throughput, samples visible local provider process memory, and stores a `source: "measured"` record when the request succeeds. If the local server or model is unavailable, the command reports `source: "unavailable"` without overwriting the last good benchmark unless you pass `--record-unavailable`.

The scheduler rejects any model above the active cap and hard rejects anything over 110 GB peak memory.

## Artifacts

A complete review pack includes:

- `book-bible.json`
- `book-canon.json`
- `hierarchical-memory.json`
- `outline.json`
- `locked-constraints.json`
- `scene-graph.json`
- `cohesion-plan.json`
- `book-quality-score.json`
- `revision-map.json`
- `story-impact-report.json`
- `story-sync-report.json`
- `storyline-overview.json`
- `final-cohesion-report.json`
- `genre-excellence-report.json`
- `manuscript.md`
- `continuity-report.json`
- `quality-report.json`
- `originality-report.json`
- `editorial-policy-report.json`
- `story-quality-report.json`
- `endurance-report.json`
- `metadata.json`
- `publish-preview.json`
- `cover-brief.json`
- `cover.tiff`
- `cover.svg`
- `ebook.epub`
- `print.html`
- `print.pdf` when a local PDF exporter is available
- `export-validation-report.json`
- `review-pack.json`
- `kdp-upload-manifest.json` after `publish-dry-run`
- `kdp-browser-actions.json` after `publish-dry-run`
- `kdp-dry-run-report.json` after `publish-dry-run`
- `approved-backlog.json` after `overnight-run`
- `overnight-run-report.json` after `overnight-run`
- `scheduler/schedule-install.json` after `schedule-install`
- `scheduler/scheduler-state.json` after `schedule-install` or `scheduler-tick`
- `scheduler/scheduler-tick-report.json` after `scheduler-tick`

If LM Studio is unavailable, the plugin produces a deterministic offline draft and records a gap. That package is marked for revision until live local model generation is verified.

If `localProvider` is set to `ollama`, or a benchmarked model record uses provider `ollama`, live generation uses Ollama's native local endpoint by default.

For Book Studio dashboard generation, set the plugin-local model explicitly when you want a stable local writer independent of the global agent default:

```json5
{
  plugins: {
    entries: {
      "book-writer": {
        config: {
          localProvider: "ollama",
          localModel: "qwen2.5:32b",
          localBaseUrl: "http://127.0.0.1:11434",
        },
      },
    },
  },
}
```

If `localModel` is omitted and the global default model uses the same provider, Book Writer reuses that model id. Ollama's normal OpenClaw provider config should keep the native `http://127.0.0.1:11434` base URL. Older Book Writer configs that still include `/v1` are normalized back to the native Ollama endpoint before generation.

`endurance-preview` estimates full-length overnight feasibility with chapter retry reserves, packaging and QA overhead, measured model speed, and the active memory cap. Review packs also include `story-quality-report.json` for outline order, chapter promise coverage, cast coverage, scene specificity, and final-resolution checks, plus `endurance-report.json` for measured-model, memory-cap, and overnight-window status.

`overnight-run` is the daily operator entry point. It requires an eligible measured model by default, estimates whether the selected model can finish before the configured review time, runs or resumes the review-pack pipeline, refreshes `approved-backlog.json`, and prepares a KDP dry-run only from the highest-scoring approved backlog item. Use `--dry-run` to check model, timing, and backlog selection without drafting. Use `--allow-estimated` only for temporary smoke tests before a measured local benchmark exists.

`schedule-install` writes the explicit nightly runner under the book-writer output directory and reports two operator choices: a system cron line and an `openclaw cron add --command ...` command for the Gateway scheduler. The generated runner preserves safe OpenClaw path/profile environment overrides and changes into the install-time working directory before invoking OpenClaw, so `pnpm openclaw` schedules do not depend on cron's current directory. It does not mutate cron by default, and autonomous writing is paused by default even when schedule files exist. Pass `--enable-autonomous-writing` only after an explicit advanced confirmation; without it, scheduled ticks write a skipped-disabled report instead of drafting. Pass `--register-gateway-cron` to list existing Gateway cron jobs, update the managed book-writer job when found, create it when absent, and verify it with `cron show`. If a same-name unmarked job exists, registration is blocked instead of creating a duplicate. Pass `--gateway-cron-dry-run` to include the planned Gateway cron registration without mutating cron. Pass `--install-system-cron` only when you want the command to replace the managed system crontab block.

`scheduler-tick` is the command the runner executes. It first checks the Book Writer automation file and schedule manifest; when automation is disabled it no-ops with `status: "skipped-disabled"`, records a gap that no book was drafted, and writes `scheduler/scheduler-tick-report.json`. When automation is explicitly enabled, it acquires a local lock before calling `overnight-run`, skips overlapping ticks, recovers stale locks after the configured TTL, marks missed runs when the last successful run is older than the configured threshold, and writes durable scheduler state.

Longer live manuscripts are drafted as bounded chapter segments so local models do not have to hold an entire chapter in one generation call. Each segment gets a proportional token and timeout budget, then the plugin keeps the best live segment, performs bounded live expansion when a chapter is short, and records a deterministic fallback gap only when the local model cannot produce a usable chapter. Planning Studio Write actions are stricter: they use the configured local Book Writer model directly, show the active provider/model in the Write step, retry once when output looks like meta instructions, and leave existing Book Text unchanged if the model cannot return final reader-facing prose. Planning Studio drafting also rejects old instruction-like Book Text such as "Chapter focus", "A useful book on", "the reader should", or "The paragraph should..." so quality checks fail until the text is replaced with reader-facing prose.

The quality gate now treats `--target-words` as an approval contract, not just a prompt hint. A manuscript must reach at least 90% of the requested target words, while still meeting the configured absolute minimum, before the review pack can be approved. This prevents long-form overnight runs from quietly approving materially short books. When profanity is set to **Off**, plan and package quality scans also fail if profanity is detected in Book Text.

Packaging runs deterministic EPUB ZIP, print trim, margin, and content-flow checks. If an official EPUBCheck command or jar is configured with `OPENCLAW_BOOK_WRITER_EPUBCHECK_BIN`, `OPENCLAW_BOOK_WRITER_EPUBCHECK_JAR`, or `EPUBCHECK_JAR`, the review pack also runs that upload-grade EPUB gate. Print PDF export uses `cupsfilter` or a Chromium-compatible browser when available, then falls back to a deterministic 6in x 9in PDF writer so review packs still include a printable PDF path.

## Publishing posture

The KDP preview prepares title, subtitle, description, keywords, category suggestions, AI disclosure notes, KDP Select warning, and a final-submit checklist. The plugin does not perform final KDP submission in v1.

`publish-dry-run` turns an approved review pack into a browser-assisted KDP preparation bundle. It validates that the review pack is approved, the EPUB and metadata artifacts exist, upload-grade export validation passed, and the final submit action remains blocked. The command writes a KDP upload manifest, human-readable browser action plan, and dry-run report. The Control UI dashboard uses the strict approved-only path for KDP prep; CLI operators can pass `--allow-revise` only for a rehearsal that is explicitly not upload-ready.

The package step writes both `cover.tiff` and `cover.svg`. The TIFF is a deterministic 1600x2560 RGB upload cover under KDP's eBook cover size limit; the SVG is kept as an editable preview source. `publish-dry-run` auto-selects direct upload when a valid JPEG or TIFF cover is present and falls back to KDP Cover Creator for older review packs. Use `--cover-strategy kdp-cover-creator` when you want to force the manual cover route.

Related:

- [Local models](/gateway/local-models)
- [LM Studio](/providers/lmstudio)
- [Scheduled tasks](/automation/cron-jobs)
