#!/usr/bin/env python3
"""
vault_to_training.py — Deep Research конвертер Obsidian vault → training JSONL.

Читает .md файлы из vault, парсит YAML frontmatter,
разбивает на секции по H2/H3 заголовкам и генерирует
МНОЖЕСТВЕННЫЕ типы instruction-response пар для QLoRA fine-tuning:

  - explain    — "Объясни: {тема}"
  - howto      — "Как сделать {X}?"
  - code       — "Напиши код: {задача}" (из code blocks)
  - compare    — "Сравни {A} и {B}" (из таблиц и списков)
  - troubleshoot — "Почему возникает {ошибка}?" (из debug/fix контента)
  - summarize  — "Кратко опиши {тему}" (summary с лимитом)
  - crossref   — "Как {тема A} связана с {тема B}?" (между файлами)

Использование:
    python scripts/vault_to_training.py                        # дефолт: Knowledge/
    python scripts/vault_to_training.py --deep                  # deep research mode
    python scripts/vault_to_training.py --vault-dir .           # весь vault
    python scripts/vault_to_training.py --dry-run               # только показать
    python scripts/vault_to_training.py --category domain-knowledge
"""

import argparse
import json
import re
import sys
from pathlib import Path
from collections import defaultdict

# ── YAML frontmatter parser (без зависимости от PyYAML) ──────────────

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Парсит YAML frontmatter из markdown. Возвращает (meta, body)."""
    if not text.startswith("---"):
        return {}, text

    end = text.find("---", 3)
    if end == -1:
        return {}, text

    yaml_block = text[3:end].strip()
    body = text[end + 3:].strip()
    meta: dict = {}

    current_key = None
    current_list: list[str] = []

    for line in yaml_block.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        # List item under current key
        if stripped.startswith("- ") and current_key:
            current_list.append(stripped[2:].strip())
            continue

        # Flush previous list
        if current_key and current_list:
            meta[current_key] = current_list
            current_list = []
            current_key = None

        if ":" in stripped:
            key, _, val = stripped.partition(":")
            key = key.strip()
            val = val.strip()
            if val:
                # Inline value
                if val.lower() == "true":
                    meta[key] = True
                elif val.lower() == "false":
                    meta[key] = False
                else:
                    meta[key] = val
            else:
                # Start of list
                current_key = key

    if current_key and current_list:
        meta[current_key] = current_list

    return meta, body


# ── Markdown section splitter ─────────────────────────────────────────

def split_sections(body: str) -> list[dict]:
    """Разбивает markdown на секции по H2/H3 заголовкам."""
    sections = []
    current_heading = None
    current_level = 0
    current_lines: list[str] = []

    for line in body.splitlines():
        m = re.match(r'^(#{2,3})\s+(.+)', line)
        if m:
            # Flush previous section
            if current_heading and current_lines:
                content = "\n".join(current_lines).strip()
                if len(content) > 50:  # Минимальная длина контента
                    sections.append({
                        "heading": current_heading,
                        "level": current_level,
                        "content": content,
                    })
            current_heading = m.group(2).strip()
            current_level = len(m.group(1))
            current_lines = []
        else:
            current_lines.append(line)

    # Flush last section
    if current_heading and current_lines:
        content = "\n".join(current_lines).strip()
        if len(content) > 50:
            sections.append({
                "heading": current_heading,
                "level": current_level,
                "content": content,
            })

    return sections


# ── Training pair generator ───────────────────────────────────────────

def clean_for_training(text: str) -> str:
    """Очищает markdown от служебных элементов для training data."""
    # Убираем Obsidian wikilinks → оставляем текст
    text = re.sub(r'\[\[([^\]|]+)\|([^\]]+)\]\]', r'\2', text)
    text = re.sub(r'\[\[([^\]]+)\]\]', r'\1', text)
    # Убираем inline tags (#v16_knowledge и т.д.)
    text = re.sub(r'#\w+', '', text)
    # Убираем навигационные блоки
    text = re.sub(r'>\s*\*\*Навигация:\*\*.*\n?', '', text)
    # Сжимаем множественные пустые строки
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


# ── Deep Research: extract code blocks ────────────────────────────────

def extract_code_blocks(text: str) -> list[dict]:
    """Извлекает code blocks с языком и контекстом."""
    blocks = []
    pattern = re.compile(r'```(\w+)?\n(.*?)```', re.DOTALL)
    for m in pattern.finditer(text):
        lang = m.group(1) or "text"
        code = m.group(2).strip()
        if len(code) > 30:
            # Ищем контекст — текст перед code block
            start = m.start()
            preceding = text[max(0, start - 300):start].strip()
            # Берём последний абзац или последнюю строку
            lines = [l for l in preceding.split('\n') if l.strip()]
            context = lines[-1] if lines else ""
            blocks.append({"lang": lang, "code": code, "context": context})
    return blocks


def extract_tables(text: str) -> list[dict]:
    """Извлекает markdown таблицы."""
    tables = []
    lines = text.split('\n')
    table_lines: list[str] = []
    in_table = False
    for line in lines:
        if re.match(r'^\s*\|', line):
            in_table = True
            table_lines.append(line.strip())
        elif in_table:
            if table_lines and len(table_lines) >= 3:
                tables.append({"content": "\n".join(table_lines), "rows": len(table_lines) - 2})
            table_lines = []
            in_table = False
    if in_table and table_lines and len(table_lines) >= 3:
        tables.append({"content": "\n".join(table_lines), "rows": len(table_lines) - 2})
    return tables


def extract_error_fix_pairs(text: str) -> list[dict]:
    """Извлекает пары ошибка→решение из troubleshooting контента."""
    pairs = []
    # Pattern: **Error**: ... → **Fix**: ...
    pattern = re.compile(
        r'\*\*(?:Error|Ошибка|Проблема)\*\*[:\s]*(.+?)[\n\r]+'
        r'.*?\*\*(?:Fix|Решение|Фикс)\*\*[:\s]*(.+?)(?:\n|$)',
        re.IGNORECASE
    )
    for m in pattern.finditer(text):
        error = m.group(1).strip().strip('-').strip()
        fix = m.group(2).strip().strip('-').strip()
        if len(error) > 10 and len(fix) > 10:
            pairs.append({"error": error, "fix": fix})
    return pairs


# ── Deep Research: multi-style instruction generation ─────────────────

INSTRUCTION_STYLES = {
    "explain": [
        "Объясни: {topic}",
        "Что такое {topic}?",
        "Расскажи подробно про {topic}",
    ],
    "howto": [
        "Как работает {topic}?",
        "Как использовать {topic}?",
        "Покажи как применить {topic}",
    ],
    "code": [
        "Напиши код: {topic}",
        "Покажи пример кода для {topic}",
        "Реализуй {topic} в коде",
    ],
    "troubleshoot": [
        "Почему возникает ошибка: {topic}?",
        "Как исправить: {topic}?",
        "Диагностика проблемы: {topic}",
    ],
    "summarize": [
        "Кратко опиши {topic}",
        "В чём суть {topic}?",
    ],
    "compare": [
        "Сравни подходы в {topic}",
        "Какие есть варианты для {topic}?",
    ],
}


def pick_instruction_style(heading: str, content: str, style_idx: int = 0) -> tuple[str, str]:
    """Выбирает стиль инструкции на основе контента."""
    heading_lower = heading.lower()
    content_lower = content.lower()

    # Detect troubleshooting
    if any(w in heading_lower for w in ["error", "fix", "debug", "ошибка", "фикс", "проблем"]):
        style = "troubleshoot"
    # Detect code
    elif "```" in content and content.count("```") >= 2:
        style = "code"
    # Detect how-to
    elif any(w in heading_lower for w in ["how", "как", "usage", "использ", "пример", "example"]):
        style = "howto"
    # Detect comparison
    elif any(w in heading_lower for w in ["сравн", "compar", "vs", "разниц", "отличи"]):
        style = "compare"
    # Detect summary
    elif any(w in heading_lower for w in ["обзор", "overview", "summary", "итог", "кратко"]):
        style = "summarize"
    else:
        style = "explain"

    templates = INSTRUCTION_STYLES[style]
    template = templates[style_idx % len(templates)]
    return style, template.format(topic=heading)


def generate_pairs(filepath: Path, meta: dict, body: str, deep: bool = False) -> list[dict]:
    """Генерирует instruction-response пары из файла."""
    pairs = []
    title = filepath.stem.replace("_", " ")
    tags = meta.get("tags", [])
    category = meta.get("category", "general")
    difficulty = meta.get("difficulty", "intermediate")

    sections = split_sections(body)
    source = f"vault:{filepath.relative_to(filepath.parent.parent)}"

    def make_pair(instruction: str, response: str, pair_type: str = "explain") -> dict:
        return {
            "instruction": instruction,
            "response": clean_for_training(response),
            "source": source,
            "tags": tags if isinstance(tags, list) else [tags],
            "category": category,
            "difficulty": difficulty,
            "type": pair_type,
        }

    for i, section in enumerate(sections):
        heading = section["heading"]
        content = section["content"]

        if not content or len(content) < 80:
            continue

        # ── Primary pair (style-aware) ─────────────────────────────
        style, instruction = pick_instruction_style(heading, content, style_idx=0)
        pairs.append(make_pair(instruction, content, style))

        if not deep:
            continue

        # ══ DEEP RESEARCH MODE ═════════════════════════════════════

        # ── Alternative instruction style ──────────────────────────
        _, alt_instruction = pick_instruction_style(heading, content, style_idx=1)
        if alt_instruction != instruction:
            pairs.append(make_pair(alt_instruction, content, style + "_alt"))

        # ── Code block extraction ──────────────────────────────────
        code_blocks = extract_code_blocks(content)
        for cb in code_blocks:
            code_context = cb["context"] or heading
            code_instruction = f"Напиши {cb['lang']} код: {code_context}"
            code_response = f"```{cb['lang']}\n{cb['code']}\n```"
            if cb["context"]:
                code_response = f"{cb['context']}\n\n{code_response}"
            pairs.append(make_pair(code_instruction, code_response, "code"))

        # ── Error-fix pairs ────────────────────────────────────────
        error_fixes = extract_error_fix_pairs(content)
        for ef in error_fixes:
            pairs.append(make_pair(
                f"Как исправить ошибку: {ef['error']}?",
                f"Проблема: {ef['error']}\n\nРешение: {ef['fix']}",
                "troubleshoot"
            ))

        # ── Table-based pairs ──────────────────────────────────────
        tables = extract_tables(content)
        for tbl in tables:
            if tbl["rows"] >= 2:
                pairs.append(make_pair(
                    f"Покажи данные по {heading}",
                    tbl["content"],
                    "table"
                ))

        # ── Summary pair (truncated response) ──────────────────────
        if len(content) > 500:
            # Берём первые 2 абзаца как summary
            paragraphs = [p.strip() for p in content.split('\n\n') if p.strip()]
            summary = "\n\n".join(paragraphs[:2])
            if len(summary) > 100:
                pairs.append(make_pair(
                    f"Кратко опиши: {heading}",
                    summary,
                    "summarize"
                ))

    # ── Whole-file fallback ────────────────────────────────────────
    if not sections:
        clean_body = clean_for_training(body)
        if len(clean_body) > 100:
            pairs.append(make_pair(f"Расскажи про {title}", clean_body[:4000], "explain"))

    # ── Deep: whole-file summary ───────────────────────────────────
    if deep and len(sections) >= 3:
        all_headings = [s["heading"] for s in sections]
        overview = f"Файл «{title}» содержит следующие разделы: {', '.join(all_headings)}."
        first_section = clean_for_training(sections[0]["content"])[:500]
        pairs.append(make_pair(
            f"Дай обзор темы: {title}",
            f"{overview}\n\n{first_section}",
            "overview"
        ))

    return pairs


# ── Cross-reference pair generation ───────────────────────────────────

TAG_RELATIONS = {
    ("dmarket", "hmac"): "Как HMAC используется в DMarket API?",
    ("dmarket", "api"): "Как устроено DMarket API и какие эндпоинты доступны?",
    ("rust", "python"): "Как связать Rust и Python через PyO3?",
    ("pyo3", "performance"): "Как PyO3 помогает ускорить Python-код?",
    ("performance", "memory"): "Как оптимизация памяти влияет на производительность?",
    ("hmac", "security"): "Как HMAC обеспечивает безопасность API запросов?",
    ("cryptography", "api"): "Как криптография используется для подписи API запросов?",
    ("fpga", "performance"): "Как FPGA ускоряет HFT торговлю?",
    ("zero-copy", "performance"): "Как zero-copy техники улучшают latency?",
    ("tcp", "performance"): "Как тюнинг TCP влияет на задержку в трейдинге?",
}


def generate_crossref_pairs(all_files_meta: list[dict]) -> list[dict]:
    """Генерирует cross-reference пары между связанными файлами."""
    pairs = []
    # Группируем файлы по тегам
    tag_to_files: dict[str, list[dict]] = defaultdict(list)
    for fm in all_files_meta:
        for tag in fm.get("tags", []):
            tag_to_files[tag].append(fm)

    for (tag_a, tag_b), question in TAG_RELATIONS.items():
        files_a = tag_to_files.get(tag_a, [])
        files_b = tag_to_files.get(tag_b, [])
        if not files_a or not files_b:
            continue

        # Берём первый файл из каждой группы
        fa = files_a[0]
        fb = files_b[0]
        if fa["title"] == fb["title"]:
            if len(files_b) > 1:
                fb = files_b[1]
            else:
                continue

        response_parts = [
            f"**{fa['title']}** ({fa.get('category', 'general')}):",
            fa.get("summary", "")[:300],
            "",
            f"**{fb['title']}** ({fb.get('category', 'general')}):",
            fb.get("summary", "")[:300],
        ]
        response = "\n".join(response_parts)

        if len(response) > 150:
            pairs.append({
                "instruction": question,
                "response": response,
                "source": f"crossref:{fa['title']}+{fb['title']}",
                "tags": [tag_a, tag_b],
                "category": "cross-reference",
                "difficulty": "intermediate",
                "type": "crossref",
            })

    return pairs


# ── Main ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Obsidian vault → training JSONL (Deep Research)")
    parser.add_argument(
        "--vault-dir", type=Path, default=Path("Knowledge"),
        help="Корневая директория vault для сканирования (default: Knowledge/)"
    )
    parser.add_argument(
        "--output", type=Path, default=Path("data/training/vault_generated.jsonl"),
        help="Путь для output JSONL (default: data/training/vault_generated.jsonl)"
    )
    parser.add_argument(
        "--category", type=str, default=None,
        help="Фильтровать по category (domain-knowledge, code-reference, troubleshooting)"
    )
    parser.add_argument(
        "--min-length", type=int, default=80,
        help="Минимальная длина response в символах (default: 80)"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Только показать что будет сгенерировано, не писать файл"
    )
    parser.add_argument(
        "--include-core", action="store_true",
        help="Включить core identity файлы (BRAIN, MEMORY, SOUL и т.д.)"
    )
    parser.add_argument(
        "--deep", action="store_true",
        help="Deep Research mode: множественные стили, код, таблицы, кросс-ссылки"
    )
    args = parser.parse_args()

    root = Path(".")
    vault_dir = root / args.vault_dir

    if not vault_dir.exists():
        print(f"Ошибка: директория {vault_dir} не найдена", file=sys.stderr)
        sys.exit(1)

    # Собираем файлы
    md_files = list(vault_dir.rglob("*.md"))

    # Опционально добавляем core файлы
    if args.include_core:
        core_files = ["BRAIN.md", "MEMORY.md", "SOUL.md", "HEARTBEAT.md",
                       "PROJECT_CONTEXT.md", "TROUBLESHOOTING.md"]
        for cf in core_files:
            p = root / cf
            if p.exists():
                md_files.append(p)

    all_pairs: list[dict] = []
    all_files_meta: list[dict] = []  # for crossref
    stats = {"files_scanned": 0, "files_with_training": 0, "pairs_generated": 0,
             "skipped_no_frontmatter": 0, "skipped_training_false": 0,
             "type_counts": defaultdict(int)}

    for filepath in sorted(md_files):
        stats["files_scanned"] += 1
        text = filepath.read_text(encoding="utf-8")
        meta, body = parse_frontmatter(text)

        # Пропускаем файлы без frontmatter (если не core)
        if not meta and "Knowledge" in str(filepath):
            stats["skipped_no_frontmatter"] += 1
            continue

        # Пропускаем если training: false
        if meta.get("training") is False:
            stats["skipped_training_false"] += 1
            continue

        # Фильтр по category
        if args.category and meta.get("category") != args.category:
            continue

        pairs = generate_pairs(filepath, meta, body, deep=args.deep)

        # Фильтр по длине
        pairs = [p for p in pairs if len(p["response"]) >= args.min_length]

        if pairs:
            stats["files_with_training"] += 1
            stats["pairs_generated"] += len(pairs)
            for p in pairs:
                stats["type_counts"][p.get("type", "explain")] += 1
            all_pairs.extend(pairs)

        # Collect meta for crossref
        if args.deep:
            sections = split_sections(body)
            summary = clean_for_training(sections[0]["content"])[:300] if sections else ""
            all_files_meta.append({
                "title": filepath.stem.replace("_", " "),
                "tags": meta.get("tags", []),
                "category": meta.get("category", "general"),
                "summary": summary,
            })

    # ── Deep: Cross-reference pairs ────────────────────────────────
    if args.deep and all_files_meta:
        crossref_pairs = generate_crossref_pairs(all_files_meta)
        all_pairs.extend(crossref_pairs)
        stats["pairs_generated"] += len(crossref_pairs)
        stats["type_counts"]["crossref"] += len(crossref_pairs)

    # Вывод статистики
    print(f"\n{'='*50}")
    mode = "Deep Research" if args.deep else "Standard"
    print(f"Vault → Training Data Report ({mode})")
    print(f"{'='*50}")
    print(f"Файлов проскансировано:    {stats['files_scanned']}")
    print(f"Файлов с training=true:    {stats['files_with_training']}")
    print(f"Пропущено (нет meta):      {stats['skipped_no_frontmatter']}")
    print(f"Пропущено (training=false): {stats['skipped_training_false']}")
    print(f"Training пар сгенерировано: {stats['pairs_generated']}")

    if all_pairs:
        avg_len = sum(len(p["response"]) for p in all_pairs) // len(all_pairs)
        print(f"Средняя длина response:    {avg_len} символов")

        # Type breakdown
        if stats["type_counts"]:
            print(f"\nТипы пар:")
            for ptype, count in sorted(stats["type_counts"].items(), key=lambda x: -x[1]):
                print(f"  {ptype}: {count}")

        # Группировка по тегам
        tag_counts: dict[str, int] = {}
        for p in all_pairs:
            for t in p.get("tags", []):
                tag_counts[t] = tag_counts.get(t, 0) + 1
        print(f"\nТоп теги:")
        for tag, count in sorted(tag_counts.items(), key=lambda x: -x[1])[:10]:
            print(f"  {tag}: {count} пар")

    if args.dry_run:
        print(f"\n[DRY RUN] Не записано. Примеры пар по типам:")
        shown_types: set[str] = set()
        for p in all_pairs:
            ptype = p.get("type", "explain")
            if ptype not in shown_types and len(shown_types) < 5:
                shown_types.add(ptype)
                print(f"\n--- {ptype} ---")
                print(json.dumps(p, ensure_ascii=False, indent=2)[:400])
        return

    # Записываем JSONL
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        for pair in all_pairs:
            f.write(json.dumps(pair, ensure_ascii=False) + "\n")

    print(f"\nЗаписано в: {args.output}")
    print(f"Размер: {args.output.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
