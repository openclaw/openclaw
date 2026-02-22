#!/usr/bin/env python3
"""Fetch verse/book content from VedicVoice for video production.

Uses Prisma DB directly (via psql or the API) to pull structured content.

Usage:
  python3 fetch_content.py --book "isha-upanishad" --verses 1-5
  python3 fetch_content.py --book "bhagavad-gita" --verse 2.47
  python3 fetch_content.py --list-books
  python3 fetch_content.py --bal-gita --age-group "5-7"

Output: JSON with sanskrit, transliteration, translation, and metadata.
"""

import argparse, json, os, sys, subprocess

BACKEND_DIR = "/home/vivek/projects/shopify-multimodal-assistant/sanskrit-mantras/backend"
PRISMA_SCHEMA = os.path.join(BACKEND_DIR, "prisma/schema.prisma")

def run_prisma_query(query):
    """Execute a raw SQL query via prisma db execute or psql."""
    # Try reading DATABASE_URL from backend .env
    env_file = os.path.join(BACKEND_DIR, ".env")
    db_url = None
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                if line.startswith("DATABASE_URL=") or line.startswith("DIRECT_URL="):
                    db_url = line.strip().split("=", 1)[1].strip('"').strip("'")
                    if "DIRECT_URL" in line:  # Prefer direct URL
                        break
    
    if not db_url:
        print("ERROR: No DATABASE_URL found in backend/.env", file=sys.stderr)
        sys.exit(1)
    
    result = subprocess.run(
        ["psql", db_url, "-t", "-A", "-c", query],
        capture_output=True, text=True, timeout=15
    )
    if result.returncode != 0:
        print(f"Query error: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()

def list_books():
    """List all available books/mantras."""
    # Books from library
    books_query = """
    SELECT json_agg(json_build_object(
        'id', id, 'slug', slug, 'title', title, 
        'category', category, 'status', status,
        'verseCount', (SELECT COUNT(*) FROM "BookVerse" WHERE "bookId" = "Book".id)
    )) FROM "Book" WHERE status = 'PUBLISHED' ORDER BY title;
    """
    
    # Mantras (legacy)
    mantras_query = """
    SELECT json_agg(json_build_object(
        'id', id, 'slug', slug, 'name', name,
        'category', category, 'deity', deity,
        'verseCount', (SELECT COUNT(*) FROM "MantraVerse" WHERE "mantraId" = "Mantra".id)
    )) FROM "Mantra" WHERE "isActive" = true ORDER BY name;
    """
    
    try:
        books_raw = run_prisma_query(books_query)
        books = json.loads(books_raw) if books_raw and books_raw != "null" else []
    except Exception:
        books = []
    
    try:
        mantras_raw = run_prisma_query(mantras_query)
        mantras = json.loads(mantras_raw) if mantras_raw and mantras_raw != "null" else []
    except Exception:
        mantras = []
    
    return {"books": books, "mantras": mantras}

def fetch_book_verses(book_slug, verse_range=None):
    """Fetch verses from a book by slug."""
    where_clause = f"WHERE b.slug = '{book_slug}'"
    if verse_range:
        if "-" in verse_range:
            start, end = verse_range.split("-")
            where_clause += f" AND v.\"verseNumber\" BETWEEN {start} AND {end}"
        else:
            where_clause += f" AND (v.\"verseNumber\" = {verse_range} OR v.\"chapterVerse\" = '{verse_range}')"
    
    query = f"""
    SELECT json_agg(json_build_object(
        'verseNumber', v."verseNumber",
        'chapterVerse', v."chapterVerse",
        'sanskrit', v."textSanskrit",
        'transliteration', v.transliteration,
        'translation', v."textEnglish",
        'commentary', v.commentary,
        'bookTitle', b.title,
        'bookSlug', b.slug
    ) ORDER BY v."verseNumber")
    FROM "BookVerse" v
    JOIN "Book" b ON b.id = v."bookId"
    {where_clause};
    """
    
    raw = run_prisma_query(query)
    verses = json.loads(raw) if raw and raw != "null" else []
    return verses

def fetch_bal_gita(age_group="5-7"):
    """Fetch Bal Gita verses with age-appropriate meanings."""
    meaning_field = {
        "5-7": "meaning5to7",
        "8-10": "meaning8to10",
        "11-13": "meaning11to13",
        "14-16": "meaning14to16",
    }.get(age_group, "meaning5to7")
    
    query = f"""
    SELECT json_agg(json_build_object(
        'id', id,
        'verseRef', "verseRef",
        'sanskrit', "textSanskrit",
        'transliteration', transliteration,
        'meaning', "{meaning_field}",
        'storyContext', "storyContext",
        'activity', activity,
        'targetAccuracy', "targetAccuracy{age_group.replace('-','to')}"
    ) ORDER BY "order")
    FROM "BalGitaVerse";
    """
    
    try:
        raw = run_prisma_query(query)
        return json.loads(raw) if raw and raw != "null" else []
    except Exception as e:
        print(f"Note: BalGita query failed ({e}), table may not exist yet", file=sys.stderr)
        return []

def main():
    parser = argparse.ArgumentParser(description="Fetch VedicVoice content for video production")
    parser.add_argument("--list-books", action="store_true", help="List all available books")
    parser.add_argument("--book", help="Book slug (e.g. isha-upanishad)")
    parser.add_argument("--verses", help="Verse range (e.g. 1-5 or 2.47)")
    parser.add_argument("--verse", help="Single verse (e.g. 2.47)")
    parser.add_argument("--bal-gita", action="store_true", help="Fetch Bal Gita content")
    parser.add_argument("--age-group", default="5-7", help="Age group for Bal Gita (5-7, 8-10, 11-13, 14-16)")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    args = parser.parse_args()
    
    if args.list_books:
        result = list_books()
    elif args.book:
        result = fetch_book_verses(args.book, args.verses or args.verse)
    elif args.bal_gita:
        result = fetch_bal_gita(args.age_group)
    else:
        parser.print_help()
        return
    
    indent = 2 if args.pretty else None
    print(json.dumps(result, indent=indent, ensure_ascii=False))

if __name__ == "__main__":
    main()
