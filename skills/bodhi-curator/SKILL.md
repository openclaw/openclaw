---
name: bodhi-curator
description: Captures incoming thoughts to the vault. Entry point for every message.
user-invocable: false
disable-model-invocation: false
---

# bodhi-curator

The entry point. Every message flows through the Curator before anything else touches it. It classifies the thought, infers energy from language, detects the wellness domain, generates tags, and writes a node to the vault. Speed is everything. Target: 2 seconds for text, 4 seconds for media.

## Channel

Primary channel is Telegram. Never Signal. Never WhatsApp.

## Multimodal Intake

The Curator handles all content types that arrive via Telegram. Each media type follows a specific pipeline.

### Text messages

Standard flow. Classify, tag, infer energy, write node.

- `content` = user's exact words, never edited
- `media_type` = "text"
- `media_ref` = not set

### Images and photos

Claude vision analyzes the image. The user's caption (if any) is preserved as `content`. If no caption, generate a brief factual description (one sentence, no interpretation).

- `content` = user's caption, or AI description if no caption
- `media_type` = "image"
- `media_ref` = Telegram file_id

Domain signals from images:

| Visual content | Domain |
|---------------|--------|
| Recipe, meal prep, ingredients, nutrition label | health |
| Workout screenshot, exercise form, gym equipment | fitness |
| Sleep tracker, step counter, hydration app | wellness |
| Meditation app, journal page, therapy notes | mental-health |
| Book highlights, study notes, brain training | cognitive |

### Voice notes

Transcription via Whisper (local) or OpenClaw's audio pipeline. Process the transcript as text.

- `content` = transcription of voice note
- `media_type` = "voice"
- `media_ref` = Telegram file_id

### Links and URLs

Extract page title and brief summary. Tag with `reference`.

- `content` = user's message text containing the URL
- `media_type` = "link"
- `media_ref` = the URL itself

### Documents

Extract text content or title. Tag with `reference`.

- `content` = user's caption, or document title/summary
- `media_type` = "document"
- `media_ref` = Telegram file_id

### Video

Describe key frame content. Process like an image with temporal context.

- `content` = user's caption, or brief description of video content
- `media_type` = "video"
- `media_ref` = Telegram file_id

## Domain Classification

Every node gets exactly one primary `domain` field. Classify based on all available signals: text content, image analysis, tags, and media context.

| Domain | Signals |
|--------|---------|
| wellness | sleep, rest, hydration, daily routine, balance, nature, breathing |
| fitness | exercise, training, workout, movement, strength, cardio, flexibility |
| health | nutrition, diet, supplements, medical, lab results, recipes, cooking |
| mental-health | meditation, therapy, journaling, emotions, stress, anxiety, mindfulness |
| cognitive | learning, reading, memory, focus, problem-solving, brain training |

When ambiguous, prefer the most specific domain. "Morning run" = fitness, not wellness. "Meal prep for muscle gain" = health (nutrition), not fitness.

## Energy Inference

Energy is INFERRED from language. Never prompt the user.

- Urgent, excited, emphatic language = 4-5
- Neutral, declarative language = 3
- Casual, offhand, low-effort language = 1-2
- Default when ambiguous = 3

For images: energy is inferred from the caption tone. No caption = 3.

## Content Handling

The `content` field is the raw thought. For text messages, this is the user's exact words, never edited by AI, never rewritten, cleaned up, or paraphrased.

For media without captions, the Curator generates a brief factual description. The `media_type` field distinguishes these cases.

The `content_enriched` field is written later by bodhi-enricher and used for clustering. It is never displayed to the user.

## Classification

Six types. Classify based on the language structure:

| Type | Signal |
|------|--------|
| Idea | Default. Any standalone thought. |
| Pattern | "I noticed...", "I keep...", "every time..." |
| Practice | Commits to action. "I'm going to...", "starting tomorrow..." |
| Decision | "I decided...", "I'm done with...", "going with..." |
| Synthesis | Connects two or more previous ideas explicitly. |
| Integration | Reports applying a previous idea in real life. "I tried X and..." |

Image-only messages default to Idea unless the caption signals otherwise.

## Tags

2-5 tags per node. Lowercase, hyphenated. Always include at least one domain tag from: `wellness`, `fitness`, `health`, `mental-health`, `cognitive`.

Special cases:
- Questions captured as Idea with `question` tag added. Also answer the question.
- URLs captured with `reference` tag added.
- Images captured with `visual` tag added.
- Voice notes captured with `voice` tag added.
- Recipes get `recipe` + `nutrition` tags.
- Nodes with people mentioned get `social` tag added.

## People and Social Context

When a node mentions other people, extract their names or roles into the `people` field. Also infer `social_context`.

**People extraction:**
- Named individuals: "talked to Dr. Martinez", "my coach said" → `["Dr. Martinez"]`, `["coach"]`
- Roles without names: "my partner", "a friend" → `["partner"]`, `["friend"]`
- Groups: "the team", "family dinner" → `["team"]`, `["family"]`
- Max 20 entries. First-name or title+name only. Never fabricate.

**Social context inference:**

| Value | When |
|-------|------|
| `solo` | No people mentioned, or explicitly alone |
| `social` | Friends, family, social group activity |
| `professional` | Work colleagues, doctor, trainer, coach, therapist |
| `intimate` | Partner, close family member, best friend |

When no people are mentioned and context is clearly solo, omit both fields (default). Only set `social_context` when `people` is non-empty or context makes it obvious.

## Execution

```bash
python -m bodhi_vault.write_cli "<content>" \
  --type <type> \
  --energy <1-5> \
  --source telegram \
  --tags <tags> \
  --vault vault \
  --schema vault/schema/nodes.json
```

## Model

Claude (Sonnet/Opus) handles classification, tagging, energy inference, and image analysis. Small models are never used for this step.

## Confirmation

Reply with "Captured." followed by the inferred type and primary domain tag on the same line. Then optionally a 1-sentence observation. Nothing more. No summaries, no reformulations.

Format: `Captured. [Type · domain]`

Examples:
- `Captured. Practice · fitness` — for "starting my morning walk tomorrow"
- `Captured. Pattern · mental-health` — for "I keep avoiding hard conversations"
- `Captured. Idea · cognitive` — for most standalone thoughts
- `Captured. Decision · wellness` — for "I'm cutting alcohol this month"

If the thought was a question, answer it after the capture line.
For images: `Captured. Idea · [domain]` plus what was recognized ("Looks like a solid post-workout meal.").

## Rules

- Never ask clarifying questions for simple thoughts
- Never prompt for energy level
- Never edit the user's words in the content field (text messages)
- Never skip domain classification
- Never skip domain tags
- 2-second target for text, 4-second target for media
- One primary domain per node, always set
