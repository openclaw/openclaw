#!/usr/bin/env python3
"""
OpenClaw Documentation Translator

Translates OpenClaw docs from English into multiple languages, following the
same conventions as the existing zh-CN translations:
  - Output to docs/<lang>/ mirroring the English directory structure
  - x-i18n metadata in frontmatter (source path, source hash, provider, model, timestamp)
  - Glossary-guided translation via docs/.i18n/glossary.<lang>.json
  - Placeholder masking to protect code blocks and inline code from translation

Requirements:
  pip install openai

Usage:
  export OPENAI_API_KEY="sk-..."
  python translate_docs.py                        # translate all configured languages
  python translate_docs.py --limit 10             # translate only the first 10 pending files
  python translate_docs.py --generate-glossary    # generate/update glossaries using gpt-5.2-pro

The script is resumable: it tracks progress in translation_progress.json and
checks for existing translations on disk. Running it again will pick up where
it left off.

Glossary generation uses gpt-5.2-pro (a more capable, more expensive model)
to produce high-quality term glossaries for each language. These glossaries
then guide the cheaper translation model, ensuring consistent terminology
across all documents. Glossaries are small (~50 terms), so the pro model cost
is negligible. Translations are bulk work (~309 files per language), so the
cheaper model keeps costs low.

To add a new language:
  1. Add an entry to LOCALES (e.g., "it": "Italian")
  2. Add language-specific rules to LANG_RULES
  3. Run: python translate_docs.py --generate-glossary
  4. Review the generated glossary at docs/.i18n/glossary.it.json
  5. Run: python translate_docs.py
"""

import hashlib
import json
import os
import re
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from openai import OpenAI

sys.stdout.reconfigure(line_buffering=True)

# ── Config ────────────────────────────────────────────────────────────
DOCS_ROOT = Path(__file__).resolve().parent.parent  # docs/ directory
MODEL = "gpt-5.2-chat-latest"
GLOSSARY_MODEL = "gpt-5.2-pro"  # more capable model for glossary generation
PROVIDER = "openai"
WORKFLOW = "v1"
WORKERS = 100
MAX_RETRIES = 3
RETRY_DELAY = 5

# Pricing (per token, Standard tier) -- used for cost estimation only
INPUT_COST_PER_TOKEN = 1.75 / 1_000_000
OUTPUT_COST_PER_TOKEN = 14.00 / 1_000_000

LOCALES = {
    "ja": "Japanese",
    "ko": "Korean",
    "zh-TW": "Traditional Chinese",
    "pt-BR": "Brazilian Portuguese",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "vi": "Vietnamese",
    "sv": "Swedish",
    "fil": "Filipino",
    "nl": "Dutch",
    "ur": "Urdu",
    "ar": "Arabic",
    "hi": "Hindi",
    "da": "Danish",
    "pl": "Polish",
    "th": "Thai",
    "tr": "Turkish",
    "my": "Burmese",
    "ru": "Russian",
}

LANG_RULES = {
    "ja": """- Use fluent, idiomatic technical Japanese; avoid overly casual language.
- Use neutral documentation tone; prefer 「です・ます」 style.
- Insert a half-width space between Latin characters and Japanese text.
- Use Japanese quotation marks 「 and 」 for Japanese prose; keep ASCII quotes inside code spans/blocks.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway（ゲートウェイ）".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "ko": """- Use fluent, idiomatic technical Korean; avoid overly casual language.
- Use neutral documentation tone; prefer 합니다/합니다체 style.
- Insert a half-width space between Latin characters and Korean text.
- Use Korean quotation marks ' and ' or " and " for Korean prose; keep ASCII quotes inside code spans/blocks.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway(게이트웨이)".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "zh-TW": """- Use fluent, idiomatic Traditional Chinese (Taiwan usage); avoid Simplified Chinese characters.
- Use neutral documentation tone.
- Insert a half-width space between Latin characters and Chinese text.
- Use Chinese quotation marks 「 and 」 for Chinese prose; keep ASCII quotes inside code spans/blocks.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway 閘道器".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "pt-BR": """- Use fluent, idiomatic Brazilian Portuguese; avoid European Portuguese conventions.
- Use neutral documentation tone; prefer "voce" form.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "es": """- Use fluent, idiomatic Spanish; prefer neutral Latin American Spanish over regional variants.
- Use neutral documentation tone; prefer "usted" form for instructions.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "fr": """- Use fluent, idiomatic French; follow standard technical French conventions.
- Use neutral documentation tone; prefer "vous" form.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway (passerelle)".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Use French quotation marks (guillemets) for French prose; keep ASCII quotes inside code spans/blocks.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "de": """- Use fluent, idiomatic German; follow standard technical German conventions.
- Use neutral documentation tone; prefer "Sie" form.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Use German quotation marks for German prose; keep ASCII quotes inside code spans/blocks.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "vi": """- Use fluent, idiomatic Vietnamese; avoid overly formal or archaic language.
- Use neutral documentation tone.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "sv": """- Use fluent, idiomatic Swedish; follow standard technical Swedish conventions.
- Use neutral documentation tone; prefer "du" form (informal address, standard in Swedish technical writing).
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Use Swedish quotation marks for Swedish prose; keep ASCII quotes inside code spans/blocks.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "fil": """- Use fluent, idiomatic Filipino (Tagalog-based); follow standard Filipino technical writing conventions.
- Use neutral documentation tone.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Use Taglish naturally where technical terms have no established Filipino equivalent.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "nl": """- Use fluent, idiomatic Dutch; follow standard technical Dutch conventions.
- Use neutral documentation tone; prefer "je/u" form as appropriate for technical documentation.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "ur": """- Use fluent, idiomatic Urdu; follow standard Urdu technical writing conventions.
- Use neutral documentation tone; prefer formal register.
- Write in Urdu script (Nastaliq); do not use Roman Urdu.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "ar": """- Use fluent, idiomatic Modern Standard Arabic (MSA); avoid regional dialects.
- Use neutral documentation tone; prefer formal register.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Use Arabic quotation marks for Arabic prose; keep ASCII quotes inside code spans/blocks.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "hi": """- Use fluent, idiomatic Hindi; follow standard Hindi technical writing conventions.
- Use neutral documentation tone; prefer formal register.
- Write in Devanagari script.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "da": """- Use fluent, idiomatic Danish; follow standard technical Danish conventions.
- Use neutral documentation tone; prefer "du" form (informal address, standard in Danish technical writing).
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "pl": """- Use fluent, idiomatic Polish; follow standard technical Polish conventions.
- Use neutral documentation tone; prefer formal register.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Use Polish quotation marks for Polish prose; keep ASCII quotes inside code spans/blocks.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "th": """- Use fluent, idiomatic Thai; follow standard Thai technical writing conventions.
- Use neutral documentation tone; prefer polite register.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Do not add spaces between Thai words (follow standard Thai spacing conventions).
- Never output an empty response; if unsure, return the source text unchanged.""",
    "tr": """- Use fluent, idiomatic Turkish; follow standard technical Turkish conventions.
- Use neutral documentation tone; prefer formal register.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "my": """- Use fluent, idiomatic Burmese (Myanmar); follow standard Burmese technical writing conventions.
- Use neutral documentation tone.
- Write in Myanmar script.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Never output an empty response; if unsure, return the source text unchanged.""",
    "ru": """- Use fluent, idiomatic Russian; follow standard technical Russian conventions.
- Use neutral documentation tone; prefer formal register.
- Keep product names in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- For the OpenClaw Gateway, use "Gateway (шлюз)".
- Keep these terms in English: Skills, local loopback, Tailscale, CLI, sandbox, sandboxing.
- Use Russian quotation marks (guillemets) for Russian prose; keep ASCII quotes inside code spans/blocks.
- Never output an empty response; if unsure, return the source text unchanged.""",
}

client = OpenAI()

# ── Thread-safe state ─────────────────────────────────────────────────
lock = threading.Lock()
progress = {}
stats = {
    "done": 0,
    "error": 0,
    "total": 0,
    "bytes_in": 0,
    "bytes_out": 0,
    "api_seconds": 0.0,
    "input_tokens": 0,
    "output_tokens": 0,
    "cost": 0.0,
}
per_lang = defaultdict(lambda: {"done": 0, "error": 0})
active_workers = {}
completed_times = []
start_time_global = None


# ── Helpers ───────────────────────────────────────────────────────────
def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    elif n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    else:
        return f"{n / (1024 * 1024):.2f} MB"


def fmt_duration(secs: float) -> str:
    if secs < 60:
        return f"{secs:.1f}s"
    m, s = divmod(int(secs), 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m {s}s"


def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def print_dashboard():
    """Print a periodic status dashboard."""
    elapsed = time.time() - start_time_global
    done = stats["done"]
    errors = stats["error"]
    total = stats["total"]
    remaining = total - done - errors

    rate = done / elapsed * 60 if elapsed > 0 and done > 0 else 0
    eta = remaining / (done / elapsed) if done > 0 and elapsed > 0 else 0

    avg_time = sum(completed_times) / len(completed_times) if completed_times else 0

    lines = [
        "",
        f"{'=' * 70}",
        f"  DASHBOARD  |  Elapsed: {fmt_duration(elapsed)}  |  {datetime.now().strftime('%H:%M:%S')}",
        f"{'=' * 70}",
        f"  Progress:  {done}/{total} done  ({done * 100 / total:.1f}%)  |  {errors} errors  |  {remaining} remaining",
        f"  Rate:      {rate:.1f} files/min  |  Avg: {avg_time:.1f}s/file  |  ETA: {fmt_duration(eta)}",
        f"  Data:      {fmt_bytes(stats['bytes_in'])} in  ->  {fmt_bytes(stats['bytes_out'])} out  |  API time: {fmt_duration(stats['api_seconds'])}",
        f"  Tokens:    {stats['input_tokens']:,} in  +  {stats['output_tokens']:,} out  =  {stats['input_tokens'] + stats['output_tokens']:,} total",
        f"  Cost:      ${stats['cost']:.2f}  (input: ${stats['input_tokens'] * INPUT_COST_PER_TOKEN:.2f}  output: ${stats['output_tokens'] * OUTPUT_COST_PER_TOKEN:.2f})",
    ]

    for lang in LOCALES:
        ld = per_lang[lang]
        lines.append(f"  {lang}:        {ld['done']} done, {ld['error']} errors")

    now = time.time()
    active = list(active_workers.values())
    if active:
        lines.append(f"  Active:    {len(active)} workers in-flight:")
        active.sort(key=lambda x: x[2])
        for lang, fpath, t0 in active[:10]:
            running = now - t0
            lines.append(f"             [{lang}] {fpath} ({running:.0f}s)")
        if len(active) > 10:
            lines.append(f"             ... and {len(active) - 10} more")

    lines.append(f"{'=' * 70}")
    lines.append("")

    print("\n".join(lines), flush=True)


# ── Glossary ──────────────────────────────────────────────────────────
def load_glossary(lang: str) -> list:
    path = DOCS_ROOT / ".i18n" / f"glossary.{lang}.json"
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return []


def build_glossary_prompt(glossary: list) -> str:
    if not glossary:
        return ""
    lines = ["Preferred translations (use when natural):"]
    for entry in glossary:
        if entry.get("source") and entry.get("target"):
            lines.append(f"- {entry['source']} -> {entry['target']}")
    return "\n".join(lines)


def generate_glossary(lang_code: str):
    """Generate or update a glossary file for a language using the pro model.

    Scans all English source docs to extract recurring project-specific terms,
    then uses gpt-5.2-pro to produce idiomatic translations for each term.
    If a glossary already exists, it is sent as context so the model can
    refine existing entries and add missing ones.
    """
    lang_name = LOCALES[lang_code]
    lang_rules = LANG_RULES.get(lang_code, "")
    glossary_path = DOCS_ROOT / ".i18n" / f"glossary.{lang_code}.json"

    # Load existing glossary if present
    existing = []
    if glossary_path.exists():
        with open(glossary_path) as f:
            existing = json.load(f)

    # Collect a sample of headings and key terms from the docs
    exclude_dirs = {".i18n", "assets", "images", "zh-CN"} | set(LOCALES.keys())
    terms_sample = []
    for p in sorted(DOCS_ROOT.rglob("*.md")):
        parts = p.relative_to(DOCS_ROOT).parts
        if parts[0] in exclude_dirs:
            continue
        try:
            text = p.read_text(encoding="utf-8")
            # Extract headings
            for m in re.finditer(r'^#+\s+(.+)$', text, re.MULTILINE):
                terms_sample.append(m.group(1).strip())
            # Extract bold terms
            for m in re.finditer(r'\*\*([^*]+)\*\*', text):
                terms_sample.append(m.group(1).strip())
        except Exception:
            pass

    # Deduplicate and take top terms
    from collections import Counter
    term_counts = Counter(terms_sample)
    top_terms = [t for t, _ in term_counts.most_common(200)]

    existing_json = json.dumps(existing, ensure_ascii=False, indent=2) if existing else "[]"
    top_terms_text = "\n".join(f"- {t}" for t in top_terms[:150])

    instructions = f"""You are a technical translation glossary expert.

Your task: produce a JSON glossary for translating OpenClaw documentation from English to {lang_name}.

The glossary is an array of objects with "source" (English term) and "target" (preferred {lang_name} translation).

Rules:
- Include 40-60 entries covering the most important project-specific terms.
- Product names that should stay in English: OpenClaw, Pi, WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal, Tailscale, Skills, CLI.
- For product names kept in English, set target = source.
- For "Gateway", include the English word followed by the local term (e.g., "Gateway（ゲートウェイ）" for Japanese).
- Include both capitalized and lowercase variants for important terms (e.g., "sandbox" and "Sandbox").
- Include common documentation terms: Getting Started, Quick Start, Features, FAQ, troubleshooting, onboarding, wizard, environment variables, etc.
- Include OpenClaw-specific concepts: agent, channel, session, provider, model, tool, sandbox, sandboxing, block streaming, Discovery, Companion apps, expected keys, etc.
{lang_rules}

Output ONLY valid JSON. No markdown fences, no commentary."""

    user_msg = f"""Here are the most frequent terms and headings from the OpenClaw documentation:

{top_terms_text}

Existing glossary (refine and extend this):
{existing_json}

Generate the updated glossary as a JSON array."""

    log(f"Generating glossary for {lang_code} ({lang_name}) using {GLOSSARY_MODEL}...")

    response = client.responses.create(
        model=GLOSSARY_MODEL,
        instructions=instructions,
        input=user_msg,
    )

    result = response.output_text.strip()
    # Strip markdown fences if the model wraps the JSON
    if result.startswith("```"):
        result = re.sub(r'^```\w*\n?', '', result)
        result = re.sub(r'\n?```$', '', result)

    usage = response.usage
    in_tok = usage.input_tokens if usage else 0
    out_tok = usage.output_tokens if usage else 0
    cost = in_tok * (21.00 / 1_000_000) + out_tok * (168.00 / 1_000_000)

    try:
        glossary = json.loads(result)
    except json.JSONDecodeError as e:
        log(f"  ERROR: Failed to parse glossary JSON: {e}")
        log(f"  Raw output saved to glossary.{lang_code}.raw.txt")
        (DOCS_ROOT / ".i18n" / f"glossary.{lang_code}.raw.txt").write_text(result)
        return

    with open(glossary_path, "w", encoding="utf-8") as f:
        json.dump(glossary, f, ensure_ascii=False, indent=2)
        f.write("\n")

    log(f"  {lang_code}: {len(glossary)} entries written to {glossary_path}")
    log(f"  Tokens: {in_tok:,} in + {out_tok:,} out | Cost: ${cost:.3f}")


def generate_all_glossaries():
    """Generate glossaries for all configured languages."""
    log(f"Generating glossaries using {GLOSSARY_MODEL}")
    log(f"  Languages: {', '.join(LOCALES.keys())}")
    log("")

    total_cost = 0.0
    errors = []
    for lang_code in LOCALES:
        try:
            generate_glossary(lang_code)
        except Exception as e:
            log(f"  ERROR generating {lang_code}: {e}")
            errors.append(lang_code)

    if errors:
        log(f"\nGlossary generation finished with errors for: {', '.join(errors)}")
    else:
        log(f"\nGlossary generation complete for all {len(LOCALES)} languages.")


def build_system_prompt(src_lang: str, tgt_lang: str, lang_code: str, glossary: list) -> str:
    src_label = "English" if src_lang == "en" else src_lang
    tgt_label = LOCALES.get(lang_code, tgt_lang)
    glossary_block = build_glossary_prompt(glossary)
    lang_rules = LANG_RULES.get(lang_code, "")

    return f"""You are a translation function, not a chat assistant.
Translate from {src_label} to {tgt_label}.

Rules:
- Output ONLY the translated text. No preamble, no questions, no commentary.
- Translate all English prose; do not leave English unless it is code, a URL, or a product name.
- Preserve Markdown syntax exactly (headings, lists, tables, emphasis, links).
- Preserve HTML tags and attributes exactly.
- Do not translate code spans/blocks, config keys, CLI flags, or env vars.
- Do not alter URLs or anchors.
- Do not remove, reorder, or summarize content.
- Preserve all frontmatter YAML structure; translate only the values of title, summary, and read_when fields.
{lang_rules}

{glossary_block}

If the input is empty, output empty."""


# ── Masking ───────────────────────────────────────────────────────────
def mask_code_blocks(text: str) -> tuple[str, dict]:
    """Replace code blocks with placeholders to protect them from translation."""
    mapping = {}
    counter = [0]

    def replacer(match):
        placeholder = f"__OC_I18N_{counter[0]:04d}__"
        mapping[placeholder] = match.group(0)
        counter[0] += 1
        return placeholder

    text = re.sub(r'```[\s\S]*?```', replacer, text)
    text = re.sub(r'`[^`\n]+`', replacer, text)
    return text, mapping


def unmask(text: str, mapping: dict) -> str:
    for placeholder, original in mapping.items():
        text = text.replace(placeholder, original)
    return text


# ── Frontmatter ───────────────────────────────────────────────────────
def split_frontmatter(content: str) -> tuple[str, str]:
    if not content.startswith("---"):
        return "", content
    lines = content.split("\n")
    end_index = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_index = i
            break
    if end_index == -1:
        return "", content
    front = "\n".join(lines[1:end_index])
    body = "\n".join(lines[end_index + 1:])
    if body.startswith("\n"):
        body = body[1:]
    return front, body


def add_i18n_metadata(frontmatter: str, rel_path: str, source_bytes: bytes) -> str:
    meta = f"""x-i18n:
  source_path: {rel_path}
  source_hash: {hash_bytes(source_bytes)}
  provider: {PROVIDER}
  model: {MODEL}
  workflow: {WORKFLOW}
  generated_at: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"""

    if frontmatter.strip():
        return f"---\n{frontmatter}\n{meta}\n---\n\n"
    else:
        return f"---\n{meta}\n---\n\n"


# ── Translation ───────────────────────────────────────────────────────
def translate_text(text: str, lang_code: str, glossary: list, rel_path: str) -> tuple[str, float, int, int]:
    """Returns (translated_text, api_time, input_tokens, output_tokens)."""
    system_prompt = build_system_prompt("en", LOCALES[lang_code], lang_code, glossary)

    for attempt in range(MAX_RETRIES):
        try:
            t0 = time.time()
            response = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Translate this documentation file ({rel_path}):\n\n{text}"},
                ],
                max_completion_tokens=16384,
            )
            api_time = time.time() - t0
            result = response.choices[0].message.content
            usage = response.usage
            in_tok = usage.prompt_tokens if usage else 0
            out_tok = usage.completion_tokens if usage else 0
            if result and result.strip():
                return result, api_time, in_tok, out_tok
            log(f"  WARN: empty response for {lang_code}:{rel_path}, attempt {attempt + 1}/{MAX_RETRIES}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
        except Exception as e:
            log(f"  RETRY {attempt + 1}/{MAX_RETRIES} for {lang_code}:{rel_path}: {str(e)[:120]}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))
            else:
                raise e
    return text, 0.0, 0, 0


def process_file(source_path: Path, lang_code: str, glossary: list):
    rel_path = str(source_path.relative_to(DOCS_ROOT))
    key = f"{lang_code}:{rel_path}"
    target_path = DOCS_ROOT / lang_code / rel_path
    tid = threading.current_thread().ident
    file_start = time.time()

    source_bytes = source_path.read_bytes()
    content = source_bytes.decode("utf-8")
    src_size = len(source_bytes)

    with lock:
        active_workers[tid] = (lang_code, rel_path, file_start)

    # Skip if target already has a good translation (x-i18n metadata present)
    if target_path.exists():
        try:
            existing = target_path.read_text(encoding="utf-8")
            if "x-i18n:" in existing and "source_hash:" in existing:
                elapsed = time.time() - file_start
                with lock:
                    progress[key] = "done"
                    stats["done"] += 1
                    per_lang[lang_code]["done"] += 1
                    completed_times.append(elapsed)
                    if tid in active_workers:
                        del active_workers[tid]
                    n = stats["done"] + stats["error"]
                    log(f"  [{n}/{stats['total']}] {lang_code}: {rel_path}  SKIP (already translated)")
                return
        except Exception:
            pass

    try:
        # Copy tiny files without translation
        if len(content.strip()) < 10:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text(content, encoding="utf-8")
            elapsed = time.time() - file_start
            with lock:
                progress[key] = "done"
                stats["done"] += 1
                stats["bytes_in"] += src_size
                stats["bytes_out"] += src_size
                per_lang[lang_code]["done"] += 1
                completed_times.append(elapsed)
                del active_workers[tid]
                n = stats["done"] + stats["error"]
                log(f"  [{n}/{stats['total']}] {lang_code}: {rel_path}  COPY  {fmt_bytes(src_size)}")
            return

        # Split frontmatter and body
        frontmatter, body = split_frontmatter(content)
        masked_body, code_mapping = mask_code_blocks(body)

        if frontmatter:
            full_text = f"---\n{frontmatter}\n---\n\n{masked_body}"
        else:
            full_text = masked_body

        translated, api_time, in_tok, out_tok = translate_text(full_text, lang_code, glossary, rel_path)
        translated = unmask(translated, code_mapping)
        trans_front, trans_body = split_frontmatter(translated)
        output = add_i18n_metadata(trans_front, rel_path, source_bytes) + trans_body

        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(output, encoding="utf-8")

        out_size = len(output.encode("utf-8"))
        elapsed = time.time() - file_start
        file_cost = in_tok * INPUT_COST_PER_TOKEN + out_tok * OUTPUT_COST_PER_TOKEN

        with lock:
            progress[key] = "done"
            stats["done"] += 1
            stats["bytes_in"] += src_size
            stats["bytes_out"] += out_size
            stats["api_seconds"] += api_time
            stats["input_tokens"] += in_tok
            stats["output_tokens"] += out_tok
            stats["cost"] += file_cost
            per_lang[lang_code]["done"] += 1
            completed_times.append(elapsed)
            del active_workers[tid]
            n = stats["done"] + stats["error"]
            ratio = out_size / src_size if src_size > 0 else 0
            log(f"  [{n}/{stats['total']}] {lang_code}: {rel_path}  OK  {fmt_bytes(src_size)}->{fmt_bytes(out_size)} ({ratio:.1f}x)  API {api_time:.1f}s  ${file_cost:.3f}  Total: ${stats['cost']:.2f}")

    except Exception as e:
        # Do not write English fallback on error -- preserve any existing translation
        elapsed = time.time() - file_start
        with lock:
            progress[key] = f"error: {str(e)[:200]}"
            stats["error"] += 1
            stats["bytes_in"] += src_size
            per_lang[lang_code]["error"] += 1
            completed_times.append(elapsed)
            if tid in active_workers:
                del active_workers[tid]
            n = stats["done"] + stats["error"]
            log(f"  [{n}/{stats['total']}] {lang_code}: {rel_path}  FAIL  {str(e)[:100]}  ({elapsed:.1f}s)")

    with lock:
        if (stats["done"] + stats["error"]) % 10 == 0:
            save_progress()
        if (stats["done"] + stats["error"]) % 30 == 0:
            print_dashboard()


def save_progress():
    path = DOCS_ROOT / ".i18n" / "translation_progress.json"
    with open(path, "w") as f:
        json.dump(progress, f, indent=2)


# ── Dashboard thread ──────────────────────────────────────────────────
def dashboard_ticker():
    """Print a dashboard every 2 minutes regardless of completion events."""
    while not dashboard_stop.is_set():
        dashboard_stop.wait(120)
        if not dashboard_stop.is_set() and stats["total"] > 0:
            with lock:
                print_dashboard()


dashboard_stop = threading.Event()


# ── Main ──────────────────────────────────────────────────────────────
def main():
    global progress, start_time_global

    # Exclude existing translation dirs, assets, and i18n config
    exclude_dirs = {".i18n", "assets", "images"} | set(LOCALES.keys())
    # Also exclude zh-CN (maintained separately)
    exclude_dirs.add("zh-CN")

    doc_files = []
    for p in sorted(DOCS_ROOT.rglob("*.md")):
        parts = p.relative_to(DOCS_ROOT).parts
        if parts[0] not in exclude_dirs:
            doc_files.append(p)

    total_src_bytes = sum(p.stat().st_size for p in doc_files)

    log(f"OpenClaw Docs Translator")
    log(f"  Docs found:  {len(doc_files):>5}  ({fmt_bytes(total_src_bytes)})")
    log(f"  Locales:     {', '.join(LOCALES.keys())}")
    log(f"  Model:       {MODEL}")
    log(f"  Workers:     {WORKERS}")
    log("")

    # Load progress
    pf = DOCS_ROOT / ".i18n" / "translation_progress.json"
    if pf.exists():
        with open(pf) as f:
            progress = json.load(f)
        already_done = sum(1 for v in progress.values() if v == "done")
        already_err = sum(1 for v in progress.values() if isinstance(v, str) and v.startswith("error"))
        log(f"Resuming: {already_done} done, {already_err} prior errors (will retry errors)")

    # Build task list
    tasks = []
    for lang_code in LOCALES:
        glossary = load_glossary(lang_code)
        lang_count = 0
        lang_skip = 0
        for src in doc_files:
            rel = str(src.relative_to(DOCS_ROOT))
            key = f"{lang_code}:{rel}"
            if progress.get(key) == "done":
                lang_skip += 1
                continue
            target = DOCS_ROOT / lang_code / rel
            if target.exists():
                try:
                    existing = target.read_text(encoding="utf-8")
                    if "x-i18n:" in existing and "source_hash:" in existing:
                        progress[key] = "done"
                        lang_skip += 1
                        continue
                except Exception:
                    pass
            tasks.append((src, lang_code, glossary))
            lang_count += 1
        log(f"  {lang_code}: {lang_count} to translate, {lang_skip} already done")

    # Optional limit for testing
    if "--limit" in sys.argv:
        idx = sys.argv.index("--limit")
        if idx + 1 < len(sys.argv):
            limit = int(sys.argv[idx + 1])
            tasks = tasks[:limit]
            log(f"  Limited to first {limit} tasks")

    stats["total"] = len(tasks)
    log(f"\nTotal tasks: {len(tasks)}")

    if not tasks:
        log("Nothing to do. All translations complete.")
        return

    start_time_global = time.time()

    ticker = threading.Thread(target=dashboard_ticker, daemon=True)
    ticker.start()

    log(f"Launching {WORKERS} workers...\n")

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(process_file, s, l, g) for s, l, g in tasks]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception as e:
                log(f"  UNEXPECTED EXCEPTION: {e}")

    dashboard_stop.set()
    save_progress()

    # Final report
    elapsed = time.time() - start_time_global
    done = stats["done"]
    errors = stats["error"]
    rate = done / elapsed * 60 if elapsed > 0 and done > 0 else 0

    print("", flush=True)
    log(f"TRANSLATION COMPLETE")
    log(f"  Translated:    {done}")
    log(f"  Errors:        {errors}")
    log(f"  Elapsed:       {fmt_duration(elapsed)}")
    log(f"  Rate:          {rate:.1f} files/min")
    log(f"  Data:          {fmt_bytes(stats['bytes_in'])} in -> {fmt_bytes(stats['bytes_out'])} out")
    log(f"  API time:      {fmt_duration(stats['api_seconds'])}")
    log(f"  Tokens:        {stats['input_tokens']:,} in + {stats['output_tokens']:,} out")
    log(f"  Cost:          ${stats['cost']:.2f}")

    for lang in LOCALES:
        ld = per_lang[lang]
        log(f"  {lang}: {ld['done']} translated, {ld['error']} errors")

    if errors > 0:
        log(f"\nFiles with errors:")
        for key, val in progress.items():
            if isinstance(val, str) and val.startswith("error"):
                log(f"  {key}: {val}")


if __name__ == "__main__":
    if "--generate-glossary" in sys.argv:
        generate_all_glossaries()
    else:
        main()
