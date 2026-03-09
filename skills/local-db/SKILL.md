---
name: local-db
description: "Manage local SQLite databases: create DBs, tables with relationships, execute queries, apply safe migrations (never loses data), and backup. Use when the user asks to store, query, or manage structured data locally. NOT for: unstructured document search (use rag-store), cloud databases, or key-value config storage."
metadata: { "openclaw": { "emoji": "🗄️", "requires": { "bins": ["python3"] } } }
---

# Local Database (SQLite)

Manage local SQLite databases via the bundled `localdb.py` script. Databases are stored in `~/.openclaw/databases/`.

## When to use

✅ **USE this skill when:**

- User asks to "create a database", "store data", "create a table"
- User wants to query structured local data
- User needs relationships between data (foreign keys)
- User asks to track records, patients, inventory, contacts, etc.
- User wants a persistent local data store

## When NOT to use

❌ **DON'T use this skill when:**

- User wants to search document content semantically → use rag-store
- User needs cloud/remote database access → use appropriate cloud tools
- User wants key-value or config storage → use files/JSON directly
- Data is unstructured (free text, PDFs) → use rag-store

## Key safety rules

1. **NEVER drop tables** without explicit user confirmation
2. **ALWAYS use migrations** for schema changes (not raw ALTER/DROP)
3. **ALWAYS backup** before destructive operations
4. Foreign keys are enforced (`PRAGMA foreign_keys = ON`)
5. All schema changes are recorded in `_migrations` table
6. Destructive SQL (DROP, DELETE, TRUNCATE) requires `--allow-destructive` flag
7. **ALWAYS ask the user for confirmation** before using `--allow-destructive`

## Commands

### Create a database

```bash
python3 {baseDir}/scripts/localdb.py create mydata
```

### List databases

```bash
python3 {baseDir}/scripts/localdb.py list
```

### Apply a migration (safe schema change)

Always use migrations to create or alter tables:

```bash
# Create tables
python3 {baseDir}/scripts/localdb.py migrate mydata -d "Create patients table" -s "CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))"

# Add a column (safe — IF NOT EXISTS not available for ALTER, so check first)
python3 {baseDir}/scripts/localdb.py migrate mydata -d "Add email to patients" -s "ALTER TABLE patients ADD COLUMN email TEXT"

# Create related table with foreign key
python3 {baseDir}/scripts/localdb.py migrate mydata -d "Create appointments table" -s "CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id), date TEXT NOT NULL, notes TEXT, created_at TEXT DEFAULT (datetime('now')))"
```

### Execute queries

```bash
# Insert data
python3 {baseDir}/scripts/localdb.py exec mydata "INSERT INTO patients (name, phone) VALUES ('João Silva', '+351912345678')"

# Select data
python3 {baseDir}/scripts/localdb.py exec mydata "SELECT * FROM patients WHERE active = 1"

# JSON output (great for piping)
python3 {baseDir}/scripts/localdb.py exec mydata "SELECT * FROM patients" --json

# Join queries
python3 {baseDir}/scripts/localdb.py exec mydata "SELECT p.name, a.date, a.notes FROM patients p JOIN appointments a ON p.id = a.patient_id ORDER BY a.date DESC"

# Multi-statement (semicolon-separated)
python3 {baseDir}/scripts/localdb.py exec mydata "INSERT INTO patients (name) VALUES ('Alice'); INSERT INTO patients (name) VALUES ('Bob')"

# Destructive operations (requires explicit flag + user confirmation)
python3 {baseDir}/scripts/localdb.py exec mydata "DELETE FROM patients WHERE active = 0" --allow-destructive
```

### View schema

```bash
# All tables
python3 {baseDir}/scripts/localdb.py schema mydata

# Specific table
python3 {baseDir}/scripts/localdb.py schema mydata -t patients
```

### List tables

```bash
python3 {baseDir}/scripts/localdb.py tables mydata
```

### View migration history

```bash
python3 {baseDir}/scripts/localdb.py migrations mydata
```

### Backup a database

```bash
python3 {baseDir}/scripts/localdb.py backup mydata
```

## Patterns

### Safe column addition

Before adding a column, check if it exists:

```bash
python3 {baseDir}/scripts/localdb.py exec mydata "PRAGMA table_info(patients)" --json
```

Then migrate if the column doesn't exist.

### Bulk inserts

Use multiple INSERT statements separated by semicolons in a single exec call:

```bash
python3 {baseDir}/scripts/localdb.py exec mydata "INSERT INTO patients (name) VALUES ('Alice'); INSERT INTO patients (name) VALUES ('Bob')"
```

### Data export

```bash
python3 {baseDir}/scripts/localdb.py exec mydata "SELECT * FROM patients" --json > patients_export.json
```
