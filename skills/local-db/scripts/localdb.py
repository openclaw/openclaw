#!/usr/bin/env python3
"""
localdb — CLI for managing local SQLite databases.
OpenClaw skill: lets the agent create databases, tables, relationships,
query and safely migrate data without losing existing records.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime

DB_DIR = os.path.expanduser("~/.openclaw/databases")


def get_db_path(name):
    os.makedirs(DB_DIR, exist_ok=True)
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        print(f"Error: invalid database name '{name}'. Use only alphanumeric, _ and -.", file=sys.stderr)
        sys.exit(1)
    return os.path.join(DB_DIR, f"{name}.db")


def cmd_list_dbs(args):
    os.makedirs(DB_DIR, exist_ok=True)
    dbs = [f[:-3] for f in os.listdir(DB_DIR) if f.endswith(".db")]
    if not dbs:
        print("No databases found.")
        return
    for db in sorted(dbs):
        path = os.path.join(DB_DIR, f"{db}.db")
        size = os.path.getsize(path)
        print(f"  {db}  ({size} bytes)")


def cmd_create_db(args):
    path = get_db_path(args.name)
    if os.path.exists(path) and not args.force:
        print(f"Database '{args.name}' already exists. Use --force to recreate.")
        return
    if os.path.exists(path) and args.force:
        os.remove(path)
    conn = sqlite3.connect(path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS _migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            sql_up TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    conn.close()
    print(f"Database '{args.name}' created at {path}")


def cmd_tables(args):
    path = get_db_path(args.db)
    if not os.path.exists(path):
        print(f"Database '{args.db}' not found.", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(path)
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('_migrations', 'sqlite_sequence') ORDER BY name")
    tables = [row[0] for row in cursor]
    conn.close()
    if not tables:
        print("No tables (excluding internal).")
        return
    for t in tables:
        print(f"  {t}")


def cmd_schema(args):
    path = get_db_path(args.db)
    if not os.path.exists(path):
        print(f"Database '{args.db}' not found.", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(path)
    try:
        if args.table:
            cursor = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (args.table,))
            row = cursor.fetchone()
            if row:
                print(row[0])
            else:
                print(f"Table '{args.table}' not found.", file=sys.stderr)
                sys.exit(1)
        else:
            cursor = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT IN ('_migrations', 'sqlite_sequence') ORDER BY name")
            for row in cursor:
                if row[0]:
                    print(row[0] + ";\n")
    finally:
        conn.close()


# SQL patterns that require --allow-destructive flag.
# ALTER TABLE uses .*?\bDROP\b (lazy dot-all) so it matches any identifier style
# ("my table", `my table`, [my table], plain name) without depending on \S+.
_DESTRUCTIVE_PATTERNS = re.compile(
    r'\b(DROP\s+TABLE|DROP\s+INDEX|DROP\s+VIEW|DROP\s+TRIGGER|'
    r'DELETE\s+FROM|TRUNCATE)\b'
    r'|ALTER\s+TABLE\b.*?\bDROP\b',
    re.IGNORECASE | re.DOTALL
)


def _strip_sql_for_pattern_check(sql):
    """Strip string literals and comments, replacing with placeholder tokens.

    This allows _DESTRUCTIVE_PATTERNS to:
    - Avoid false positives: SELECT 'TRUNCATE' -> SELECT _STR_ (no match)
    - Catch comment obfuscation: DROP/**/TABLE -> DROP  TABLE (matches \\s+)
    - Handle spaced identifiers: ALTER TABLE "my table" DROP -> ... _ID_ DROP
    """
    result = []
    i = 0
    length = len(sql)
    while i < length:
        ch = sql[i]
        if ch == "'":
            result.append('_STR_')
            i += 1
            while i < length:
                if sql[i] == "'":
                    i += 1
                    if i < length and sql[i] == "'":  # escaped ''
                        i += 1
                        continue
                    break
                i += 1
        elif ch == '"':
            result.append('_ID_')
            i += 1
            while i < length:
                if sql[i] == '"':
                    i += 1
                    if i < length and sql[i] == '"':  # escaped ""
                        i += 1
                        continue
                    break
                i += 1
        elif ch == '[':
            result.append('_ID_')
            i += 1
            while i < length and sql[i] != ']':
                i += 1
            if i < length:
                i += 1
        elif ch == '`':
            result.append('_ID_')
            i += 1
            while i < length and sql[i] != '`':
                i += 1
            if i < length:
                i += 1
        elif ch == '-' and i + 1 < length and sql[i + 1] == '-':
            result.append(' ')
            while i < length and sql[i] != '\n':
                i += 1
        elif ch == '/' and i + 1 < length and sql[i + 1] == '*':
            result.append(' ')
            i += 2
            while i < length:
                if sql[i] == '*' and i + 1 < length and sql[i + 1] == '/':
                    i += 2
                    break
                i += 1
        else:
            result.append(ch)
            i += 1
    return ''.join(result)


def _split_sql(sql):
    """Split SQL on semicolons, respecting string literals, identifiers, comments,
    and BEGIN...END blocks (preserves semicolons inside CREATE TRIGGER bodies)."""
    statements = []
    current = []
    in_single = False
    in_double = False
    in_bracket = False
    in_backtick = False
    begin_depth = 0  # tracks nesting for CREATE TRIGGER ... BEGIN ... END
    case_depth = 0   # tracks CASE...END nesting inside trigger bodies
    i = 0
    length = len(sql)

    def _word_char(c):
        return c.isalnum() or c == '_'

    while i < length:
        ch = sql[i]

        # Inside single-quoted string
        if in_single:
            current.append(ch)
            if ch == "'":
                if i + 1 < length and sql[i + 1] == "'":
                    current.append(sql[i + 1])  # escaped ''
                    i += 2
                    continue
                in_single = False
            i += 1
            continue

        # Inside double-quoted identifier
        if in_double:
            current.append(ch)
            if ch == '"':
                if i + 1 < length and sql[i + 1] == '"':
                    current.append(sql[i + 1])  # escaped ""
                    i += 2
                    continue
                in_double = False
            i += 1
            continue

        # Inside bracket-quoted identifier [...]
        if in_bracket:
            current.append(ch)
            if ch == ']':
                in_bracket = False
            i += 1
            continue

        # Inside backtick-quoted identifier
        if in_backtick:
            current.append(ch)
            if ch == '`':
                in_backtick = False
            i += 1
            continue

        # Line comment: -- until end of line
        if ch == '-' and i + 1 < length and sql[i + 1] == '-':
            while i < length and sql[i] != '\n':
                current.append(sql[i])
                i += 1
            continue

        # Block comment: /* ... */
        if ch == '/' and i + 1 < length and sql[i + 1] == '*':
            current.append(ch)
            i += 1
            current.append(sql[i])
            i += 1
            while i < length:
                if sql[i] == '*' and i + 1 < length and sql[i + 1] == '/':
                    current.append(sql[i])
                    i += 1
                    current.append(sql[i])
                    i += 1
                    break
                current.append(sql[i])
                i += 1
            continue

        # Track BEGIN/END depth to preserve semicolons inside trigger bodies.
        # Only increment when BEGIN follows a partial CREATE [TEMP] TRIGGER
        # declaration — NOT for transaction control (BEGIN TRANSACTION) or
        # when `begin` is used as a plain identifier/table name.
        if ch in ('B', 'b') and sql[i:i + 5].upper() == 'BEGIN':
            prev_ok = i == 0 or not _word_char(sql[i - 1])
            next_ok = i + 5 >= length or not _word_char(sql[i + 5])
            if prev_ok and next_ok:
                current_text = ''.join(current).strip()
                # Strip comments so a comment-only prefix like '/* header */'
                # does not falsely count as trigger context.
                text_no_comments = re.sub(r'/\*.*?\*/', ' ', current_text, flags=re.DOTALL)
                text_no_comments = re.sub(r'--[^\n]*', ' ', text_no_comments).strip()
                if text_no_comments and re.search(
                    r'\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b',
                    text_no_comments, re.IGNORECASE
                ):
                    begin_depth += 1
        elif ch in ('C', 'c') and begin_depth > 0 and sql[i:i + 4].upper() == 'CASE':
            prev_ok = i == 0 or not _word_char(sql[i - 1])
            next_ok = i + 4 >= length or not _word_char(sql[i + 4])
            if prev_ok and next_ok:
                case_depth += 1
        elif ch in ('E', 'e') and sql[i:i + 3].upper() == 'END' and (begin_depth > 0 or case_depth > 0):
            prev_ok = i == 0 or not _word_char(sql[i - 1])
            next_ok = i + 3 >= length or not _word_char(sql[i + 3])
            if prev_ok and next_ok:
                if case_depth > 0:
                    case_depth -= 1  # CASE...END consumed
                elif begin_depth > 0:
                    begin_depth -= 1  # trigger END consumed
                    case_depth = 0   # reset CASE depth on trigger boundary

        # Start of quoted context
        if ch == "'":
            in_single = True
        elif ch == '"':
            in_double = True
        elif ch == '[':
            in_bracket = True
        elif ch == '`':
            in_backtick = True
        elif ch == ';':
            if begin_depth == 0:
                stmt = ''.join(current).strip()
                if stmt:
                    statements.append(stmt)
                current = []
                i += 1
                continue
            # inside BEGIN...END block: keep semicolon as part of statement

        current.append(ch)
        i += 1

    stmt = ''.join(current).strip()
    if stmt:
        statements.append(stmt)
    return statements


def cmd_execute(args):
    path = get_db_path(args.db)
    if not os.path.exists(path):
        print(f"Database '{args.db}' not found.", file=sys.stderr)
        sys.exit(1)

    sql = args.sql

    # Guard against destructive operations without explicit flag.
    # Run against stripped SQL to catch comment obfuscation (DROP/**/TABLE)
    # and avoid false positives from keywords inside string literals.
    if _DESTRUCTIVE_PATTERNS.search(_strip_sql_for_pattern_check(sql)) and not args.allow_destructive:
        print(
            "Error: destructive SQL detected (DROP/DELETE/TRUNCATE).\n"
            "Use --allow-destructive to confirm, or use migrations instead.",
            file=sys.stderr
        )
        sys.exit(1)

    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")

    try:
        # Support multi-statement SQL (respects quoted semicolons)
        statements = _split_sql(sql)
        last_cursor = None
        total_affected = 0

        for stmt in statements:
            cursor = conn.execute(stmt)
            last_cursor = cursor
            if cursor.rowcount > 0:
                total_affected += cursor.rowcount

        # Fetch result rows BEFORE committing: SQLite keeps INSERT...RETURNING
        # statements open until all rows are consumed, so calling conn.commit()
        # before fetchall() raises OperationalError "cannot commit transaction -
        # SQL statements in progress" and rolls back the write.
        result_cols = None
        result_rows = None
        if last_cursor and last_cursor.description:
            result_cols = [d[0] for d in last_cursor.description]
            result_rows = last_cursor.fetchall()

        # Commit after rows are fetched so writes from DML (including RETURNING)
        # are persisted regardless of what the last statement type was.
        conn.commit()

        # Detect result-returning queries via cursor.description (handles
        # SELECT, PRAGMA, WITH ... SELECT, INSERT ... RETURNING, etc.)
        if result_rows is not None:
            cols = result_cols
            rows = result_rows
            if args.json_output:
                result = [dict(zip(cols, row)) for row in rows]
                print(json.dumps(result, indent=2, default=str))
            else:
                if cols:
                    print(" | ".join(cols))
                    print("-" * (sum(len(c) for c in cols) + 3 * (len(cols) - 1)))
                for row in rows:
                    print(" | ".join(str(v) for v in row))
                print(f"\n({len(rows)} rows)")
        else:
            print(f"OK. Rows affected: {total_affected}")
    except sqlite3.Error as e:
        conn.rollback()
        print(f"SQL Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


def cmd_migrate(args):
    """Apply a migration: records the SQL and description, then executes."""
    path = get_db_path(args.db)
    if not os.path.exists(path):
        print(f"Database '{args.db}' not found. Create it first.", file=sys.stderr)
        sys.exit(1)

    if _DESTRUCTIVE_PATTERNS.search(_strip_sql_for_pattern_check(args.sql)):
        print(
            "Error: destructive SQL detected (DROP/DELETE/TRUNCATE) in migration.\n"
            "Migrations should only add or modify structure. "
            "Use exec --allow-destructive for intentional destructive ops.",
            file=sys.stderr
        )
        sys.exit(1)

    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")

    # Ensure migrations table exists
    conn.execute("""
        CREATE TABLE IF NOT EXISTS _migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            sql_up TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)

    try:
        # Execute the migration SQL
        for statement in _split_sql(args.sql):
            conn.execute(statement)

        # Record the migration
        conn.execute(
            "INSERT INTO _migrations (description, sql_up) VALUES (?, ?)",
            (args.description, args.sql)
        )
        conn.commit()
        print(f"Migration applied: {args.description}")
    except sqlite3.Error as e:
        conn.rollback()
        print(f"Migration failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


def cmd_migrations(args):
    """List applied migrations."""
    path = get_db_path(args.db)
    if not os.path.exists(path):
        print(f"Database '{args.db}' not found.", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(path)
    try:
        cursor = conn.execute("SELECT id, description, applied_at FROM _migrations ORDER BY id")
        rows = cursor.fetchall()
        if not rows:
            print("No migrations applied yet.")
            return
        for row in rows:
            print(f"  #{row[0]}  {row[2]}  {row[1]}")
    except sqlite3.OperationalError:
        print("No migrations table found.")
    finally:
        conn.close()


def cmd_backup(args):
    path = get_db_path(args.db)
    if not os.path.exists(path):
        print(f"Database '{args.db}' not found.", file=sys.stderr)
        sys.exit(1)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(DB_DIR, f"{args.db}_backup_{timestamp}.db")
    src = sqlite3.connect(path)
    dst = sqlite3.connect(backup_path)
    src.backup(dst)
    src.close()
    dst.close()
    print(f"Backup saved: {backup_path}")


def main():
    parser = argparse.ArgumentParser(
        prog="localdb",
        description="Manage local SQLite databases for OpenClaw"
    )
    sub = parser.add_subparsers(dest="command")

    # list
    sub.add_parser("list", help="List all databases")

    # create
    p = sub.add_parser("create", help="Create a new database")
    p.add_argument("name", help="Database name")
    p.add_argument("--force", action="store_true", help="Overwrite if exists")

    # tables
    p = sub.add_parser("tables", help="List tables in a database")
    p.add_argument("db", help="Database name")

    # schema
    p = sub.add_parser("schema", help="Show table schema(s)")
    p.add_argument("db", help="Database name")
    p.add_argument("--table", "-t", help="Specific table name")

    # execute
    p = sub.add_parser("exec", help="Execute SQL query")
    p.add_argument("db", help="Database name")
    p.add_argument("sql", help="SQL statement(s) to execute (semicolon-separated)")
    p.add_argument("--json", dest="json_output", action="store_true", help="Output as JSON")
    p.add_argument("--allow-destructive", action="store_true",
                   help="Allow DROP/DELETE/TRUNCATE statements (requires explicit opt-in)")

    # migrate
    p = sub.add_parser("migrate", help="Apply a named migration")
    p.add_argument("db", help="Database name")
    p.add_argument("--description", "-d", required=True, help="Migration description")
    p.add_argument("--sql", "-s", required=True, help="SQL to execute")

    # migrations
    p = sub.add_parser("migrations", help="List applied migrations")
    p.add_argument("db", help="Database name")

    # backup
    p = sub.add_parser("backup", help="Create a backup of a database")
    p.add_argument("db", help="Database name")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    cmds = {
        "list": cmd_list_dbs,
        "create": cmd_create_db,
        "tables": cmd_tables,
        "schema": cmd_schema,
        "exec": cmd_execute,
        "migrate": cmd_migrate,
        "migrations": cmd_migrations,
        "backup": cmd_backup,
    }
    cmds[args.command](args)


if __name__ == "__main__":
    main()
