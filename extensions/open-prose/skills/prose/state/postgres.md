---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: postgres-state-management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: experimental（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  PostgreSQL-based state management for OpenProse programs. This approach persists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  execution state to a PostgreSQL database, enabling true concurrent writes,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  network access, team collaboration, and high-throughput workloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
requires: psql CLI tool in PATH, running PostgreSQL server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see-also:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../prose.md: VM execution semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - filesystem.md: File-based state (default, simpler)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - sqlite.md: SQLite state (queryable, single-file)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - in-context.md: In-context state (for simple programs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../primitives/session.md: Session context and compaction guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# PostgreSQL State Management (Experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document describes how the OpenProse VM tracks execution state using a **PostgreSQL database**. This is an experimental alternative to file-based state (`filesystem.md`), SQLite state (`sqlite.md`), and in-context state (`in-context.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prerequisites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Requires:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. The `psql` command-line tool must be available in your PATH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. A running PostgreSQL server (local, Docker, or cloud)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Installing psql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Platform             | Command                                         | Notes                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------- | ----------------------------------------------- | ---------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| macOS (Homebrew)     | `brew install libpq && brew link --force libpq` | Client-only; no server |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| macOS (Postgres.app) | Download from https://postgresapp.com           | Full install with GUI  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Debian/Ubuntu        | `apt install postgresql-client`                 | Client-only            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Fedora/RHEL          | `dnf install postgresql`                        | Client-only            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Arch Linux           | `pacman -S postgresql-libs`                     | Client-only            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Windows              | `winget install PostgreSQL.PostgreSQL`          | Full installer         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After installation, verify:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
psql --version    # Should output: psql (PostgreSQL) 16.x（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `psql` is not available, the VM will offer to fall back to SQLite state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PostgreSQL state provides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **True concurrent writes**: Row-level locking allows parallel branches to write simultaneously（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Network access**: Query state from any machine, external tools, or dashboards（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Team collaboration**: Multiple developers can share run state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Rich SQL**: JSONB queries, window functions, CTEs for complex state analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **High throughput**: Handle 1000+ writes/minute, multi-GB outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Durability**: WAL-based recovery, point-in-time restore（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key principle:** The database is a flexible, shared workspace. The VM and subagents coordinate through it, and external tools can observe and query execution state in real-time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security Warning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**⚠️ Credentials are visible to subagents.** The `OPENPROSE_POSTGRES_URL` connection string is passed to spawned sessions so they can write their outputs. This means:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Database credentials appear in subagent context and may be logged（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Treat these credentials as **non-sensitive**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a **dedicated database** for OpenProse, not your production systems（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Create a **limited-privilege user** with access only to the `openprose` schema（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Recommended setup:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Create dedicated user with minimal privileges（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE USER openprose_agent WITH PASSWORD 'changeme';（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE SCHEMA openprose AUTHORIZATION openprose_agent;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
GRANT ALL ON SCHEMA openprose TO openprose_agent;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- User can only access the openprose schema, nothing else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When to Use PostgreSQL State（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PostgreSQL state is for **power users** with specific scale or collaboration needs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Need                                        | PostgreSQL Helps                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------------- | --------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| >5 parallel branches writing simultaneously | SQLite locks; PostgreSQL doesn't              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| External dashboards querying state          | PostgreSQL is designed for concurrent readers |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Team collaboration on long workflows        | Shared network access; no file sync needed    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Outputs exceeding 1GB                       | Bulk ingestion; no single-file bottleneck     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Mission-critical workflows (hours/days)     | Robust durability; point-in-time recovery     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**If none of these apply, use filesystem or SQLite state.** They're simpler and sufficient for 99% of programs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Decision Tree（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Is your program <30 statements with no parallel blocks?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use in-context state (zero friction)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Continue...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do external tools (dashboards, monitoring, analytics) need to query state?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use PostgreSQL (network access required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Continue...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do multiple machines or team members need shared access to the same run?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use PostgreSQL (collaboration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Continue...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do you have >5 concurrent parallel branches writing simultaneously?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use PostgreSQL (concurrency)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Continue...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Will outputs exceed 1GB or writes exceed 100/minute?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  YES -> Use PostgreSQL (scale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  NO  -> Use filesystem (default) or SQLite (if you want SQL queries)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### The Concurrency Case（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The primary motivation for PostgreSQL is **concurrent writes in parallel execution**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SQLite uses table-level locks: parallel branches serialize（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- PostgreSQL uses row-level locks: parallel branches write simultaneously（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your program has 10 parallel branches completing at once, PostgreSQL will be 5-10x faster than SQLite for the write phase.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Database Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option 1: Docker (Recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The fastest path to a running PostgreSQL instance:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker run -d \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name prose-pg \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -e POSTGRES_DB=prose \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -e POSTGRES_HOST_AUTH_METHOD=trust \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -p 5432:5432 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  postgres:16（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then configure the connection:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p .prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "OPENPROSE_POSTGRES_URL=postgresql://postgres@localhost:5432/prose" > .prose/.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Management commands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker ps | grep prose-pg    # Check if running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker logs prose-pg         # View logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker stop prose-pg         # Stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker start prose-pg        # Start again（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker rm -f prose-pg        # Remove completely（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option 2: Local PostgreSQL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For users who prefer native PostgreSQL:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**macOS (Homebrew):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
brew install postgresql@16（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
brew services start postgresql@16（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
createdb myproject（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "OPENPROSE_POSTGRES_URL=postgresql://localhost/myproject" >> .prose/.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Linux (Debian/Ubuntu):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt install postgresql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl start postgresql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo -u postgres createdb myproject（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "OPENPROSE_POSTGRES_URL=postgresql:///myproject" >> .prose/.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option 3: Cloud PostgreSQL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For team collaboration or production:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Provider     | Free Tier              | Cold Start | Best For                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | ---------------------- | ---------- | ----------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Neon**     | 0.5GB, auto-suspend    | 1-3s       | Development, testing          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Supabase** | 500MB, no auto-suspend | None       | Projects needing auth/storage |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Railway**  | $5/mo credit           | None       | Simple production deploys     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Example: Neon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "OPENPROSE_POSTGRES_URL=postgresql://user:pass@ep-name.us-east-2.aws.neon.tech/neondb?sslmode=require" >> .prose/.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Database Location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The connection string is stored in `.prose/.env`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
your-project/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── .prose/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── .env                    # OPENPROSE_POSTGRES_URL=...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── runs/                   # Execution metadata and attachments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       └── {YYYYMMDD}-{HHMMSS}-{random}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│           ├── program.prose   # Copy of running program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│           └── attachments/    # Large outputs (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── .gitignore                  # Should exclude .prose/.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── your-program.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Run ID format:** `{YYYYMMDD}-{HHMMSS}-{random6}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: `20260116-143052-a7b3c9`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Environment Variable Precedence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM checks in this order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `OPENPROSE_POSTGRES_URL` in `.prose/.env`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `OPENPROSE_POSTGRES_URL` in shell environment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `DATABASE_URL` in shell environment (common fallback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Security: Add to .gitignore（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```gitignore（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse sensitive files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/.env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/runs/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Responsibility Separation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This section defines **who does what**. This is the contract between the VM and subagents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### VM Responsibilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM (the orchestrating agent running the .prose program) is responsible for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Responsibility            | Description                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------- | --------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Schema initialization** | Create `openprose` schema and tables at run start         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Run registration**      | Store the program source and metadata                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Execution tracking**    | Update position, status, and timing as statements execute |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Subagent spawning**     | Spawn sessions via Task tool with database instructions   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Parallel coordination** | Track branch status, implement join strategies            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Loop management**       | Track iteration counts, evaluate conditions               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Error aggregation**     | Record failures, manage retry state                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Context preservation**  | Maintain sufficient narration in the main thread          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Completion detection**  | Mark the run as complete when finished                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Critical:** The VM must preserve enough context in its own conversation to understand execution state without re-reading the entire database. The database is for coordination and persistence, not a replacement for working memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Subagent Responsibilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subagents (sessions spawned by the VM) are responsible for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Responsibility          | Description                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ----------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Writing own outputs** | Insert/update their binding in the `bindings` table               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Memory management**   | For persistent agents: read and update their memory record        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Segment recording**   | For persistent agents: append segment history                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attachment handling** | Write large outputs to `attachments/` directory, store path in DB |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Atomic writes**       | Use transactions when updating multiple related records           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Critical:** Subagents write ONLY to `bindings`, `agents`, and `agent_segments` tables. The VM owns the `execution` table entirely. Completion signaling happens through the substrate (Task tool return), not database updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Critical:** Subagents must write their outputs directly to the database. The VM does not write subagent outputs—it only reads them after the subagent completes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What subagents return to the VM:** A confirmation message with the binding location—not the full content:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Root scope:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: openprose.bindings WHERE name='research' AND run_id='20260116-143052-a7b3c9' AND execution_id IS NULL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: AI safety research covering alignment, robustness, and interpretability with 15 citations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Inside block invocation:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: openprose.bindings WHERE name='result' AND run_id='20260116-143052-a7b3c9' AND execution_id=43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution ID: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: Processed chunk into 3 sub-parts for recursive processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM tracks locations, not values. This keeps the VM's context lean and enables arbitrarily large intermediate values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Shared Concerns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Concern          | Who Handles                                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------- | ------------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Schema evolution | Either (use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` as needed) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Custom tables    | Either (prefix with `x_` for extensions)                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Indexing         | Either (add indexes for frequently-queried columns)                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Cleanup          | VM (at run end, optionally delete old data)                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Core Schema（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM initializes these tables using the `openprose` schema. This is a **minimum viable schema**—extend freely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Create dedicated schema for OpenProse state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE SCHEMA IF NOT EXISTS openprose;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Run metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS openprose.run (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id TEXT PRIMARY KEY,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    program_path TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    program_source TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status TEXT NOT NULL DEFAULT 'running'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    state_mode TEXT NOT NULL DEFAULT 'postgres',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metadata JSONB DEFAULT '{}'::jsonb（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Execution position and history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS openprose.execution (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id SERIAL PRIMARY KEY,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    run_id TEXT NOT NULL REFERENCES openprose.run(id) ON DELETE CASCADE,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    statement_index INTEGER NOT NULL,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    statement_text TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status TEXT NOT NULL DEFAULT 'pending'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'skipped')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    started_at TIMESTAMPTZ,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    completed_at TIMESTAMPTZ,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    error_message TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    parent_id INTEGER REFERENCES openprose.execution(id) ON DELETE CASCADE,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metadata JSONB DEFAULT '{}'::jsonb（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- All named values (input, output, let, const)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS openprose.bindings (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    name TEXT NOT NULL,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    run_id TEXT NOT NULL REFERENCES openprose.run(id) ON DELETE CASCADE,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    execution_id INTEGER,  -- NULL for root scope, non-null for block invocations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    kind TEXT NOT NULL CHECK (kind IN ('input', 'output', 'let', 'const')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    value TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    source_statement TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    attachment_path TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metadata JSONB DEFAULT '{}'::jsonb,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    PRIMARY KEY (name, run_id, COALESCE(execution_id, -1))  -- Composite key with scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Persistent agent memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS openprose.agents (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    name TEXT NOT NULL,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    run_id TEXT,  -- NULL for project-scoped and user-scoped agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scope TEXT NOT NULL CHECK (scope IN ('execution', 'project', 'user', 'custom')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memory TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metadata JSONB DEFAULT '{}'::jsonb,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    PRIMARY KEY (name, COALESCE(run_id, '__project__'))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Agent invocation history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS openprose.agent_segments (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id SERIAL PRIMARY KEY,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    agent_name TEXT NOT NULL,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    run_id TEXT,  -- NULL for project-scoped agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    segment_number INTEGER NOT NULL,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    summary TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metadata JSONB DEFAULT '{}'::jsonb,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    UNIQUE (agent_name, COALESCE(run_id, '__project__'), segment_number)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Import registry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS openprose.imports (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    alias TEXT NOT NULL,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    run_id TEXT NOT NULL REFERENCES openprose.run(id) ON DELETE CASCADE,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    source_url TEXT NOT NULL,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    fetched_at TIMESTAMPTZ,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    inputs_schema JSONB,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    outputs_schema JSONB,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    content_hash TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metadata JSONB DEFAULT '{}'::jsonb,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    PRIMARY KEY (alias, run_id)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Indexes for common queries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX IF NOT EXISTS idx_execution_run_id ON openprose.execution(run_id);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX IF NOT EXISTS idx_execution_status ON openprose.execution(status);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX IF NOT EXISTS idx_execution_parent_id ON openprose.execution(parent_id) WHERE parent_id IS NOT NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX IF NOT EXISTS idx_execution_metadata_gin ON openprose.execution USING GIN (metadata jsonb_path_ops);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX IF NOT EXISTS idx_bindings_run_id ON openprose.bindings(run_id);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX IF NOT EXISTS idx_bindings_execution_id ON openprose.bindings(execution_id) WHERE execution_id IS NOT NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX IF NOT EXISTS idx_agents_run_id ON openprose.agents(run_id) WHERE run_id IS NOT NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX IF NOT EXISTS idx_agents_project_scoped ON openprose.agents(name) WHERE run_id IS NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX IF NOT EXISTS idx_agent_segments_lookup ON openprose.agent_segments(agent_name, run_id);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Schema Conventions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Timestamps**: Use `TIMESTAMPTZ` with `NOW()` (timezone-aware)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **JSON fields**: Use `JSONB` for structured data in `metadata` columns (queryable, indexable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Large values**: If a binding value exceeds ~100KB, write to `attachments/{name}.md` and store path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Extension tables**: Prefix with `x_` (e.g., `x_metrics`, `x_audit_log`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Anonymous bindings**: Sessions without explicit capture use auto-generated names: `anon_001`, `anon_002`, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Import bindings**: Prefix with import alias for scoping: `research.findings`, `research.sources`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Scoped bindings**: Use `execution_id` column—NULL for root scope, non-null for block invocations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Scope Resolution Query（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For recursive blocks, bindings are scoped to their execution frame. Resolve variables by walking up the call stack:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Find binding 'result' starting from execution_id 43 in run '20260116-143052-a7b3c9'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WITH RECURSIVE scope_chain AS (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -- Start with current execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SELECT id, parent_id FROM openprose.execution WHERE id = 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  UNION ALL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -- Walk up to parent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SELECT e.id, e.parent_id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  FROM openprose.execution e（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  JOIN scope_chain s ON e.id = s.parent_id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT b.* FROM openprose.bindings b（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE b.name = 'result'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND b.run_id = '20260116-143052-a7b3c9'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND (b.execution_id IN (SELECT id FROM scope_chain) OR b.execution_id IS NULL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ORDER BY（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  CASE WHEN b.execution_id IS NULL THEN 1 ELSE 0 END,  -- Prefer scoped over root（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  b.execution_id DESC NULLS LAST  -- Prefer deeper (more local) scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
LIMIT 1;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Simpler version if you know the scope chain:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Direct lookup: check current scope (43), then parent (42), then root (NULL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT * FROM openprose.bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE name = 'result'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND run_id = '20260116-143052-a7b3c9'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND (execution_id = 43 OR execution_id = 42 OR execution_id IS NULL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ORDER BY execution_id DESC NULLS LAST（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
LIMIT 1;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Database Interaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Both VM and subagents interact via the `psql` CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### From the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Initialize schema（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
psql "$OPENPROSE_POSTGRES_URL" -f schema.sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Register a new run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
psql "$OPENPROSE_POSTGRES_URL" -c "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  INSERT INTO openprose.run (id, program_path, program_source, status)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  VALUES ('20260116-143052-a7b3c9', '/path/to/program.prose', 'program source...', 'running')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update execution position（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
psql "$OPENPROSE_POSTGRES_URL" -c "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  INSERT INTO openprose.execution (run_id, statement_index, statement_text, status, started_at)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  VALUES ('20260116-143052-a7b3c9', 3, 'session \"Research AI safety\"', 'executing', NOW())（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Read a binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
psql "$OPENPROSE_POSTGRES_URL" -t -A -c "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SELECT value FROM openprose.bindings WHERE name = 'research' AND run_id = '20260116-143052-a7b3c9'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check parallel branch status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
psql "$OPENPROSE_POSTGRES_URL" -c "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SELECT metadata->>'branch' AS branch, status FROM openprose.execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  WHERE run_id = '20260116-143052-a7b3c9' AND metadata->>'parallel_id' = 'p1'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### From Subagents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM provides the database path and instructions when spawning:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Root scope (outside block invocations):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your output goes to PostgreSQL state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Property | Value |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
|----------|-------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Connection | `postgresql://user:***@host:5432/db` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Schema | `openprose` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Run ID | `20260116-143052-a7b3c9` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Binding | `research` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Execution ID | (root scope) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When complete, write your output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
psql "$OPENPROSE_POSTGRES_URL" -c "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  INSERT INTO openprose.bindings (name, run_id, execution_id, kind, value, source_statement)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  VALUES (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'research',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    '20260116-143052-a7b3c9',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    NULL,  -- root scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'let',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    E'AI safety research covers alignment, robustness...',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'let research = session: researcher'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ON CONFLICT (name, run_id, COALESCE(execution_id, -1)) DO UPDATE（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SET value = EXCLUDED.value, updated_at = NOW()（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Inside block invocation (include execution_id):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your output goes to PostgreSQL state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Property | Value |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
|----------|-------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Connection | `postgresql://user:***@host:5432/db` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Schema | `openprose` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Run ID | `20260116-143052-a7b3c9` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Binding | `result` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Execution ID | `43` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Block | `process` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Depth | `3` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When complete, write your output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
psql "$OPENPROSE_POSTGRES_URL" -c "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  INSERT INTO openprose.bindings (name, run_id, execution_id, kind, value, source_statement)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  VALUES (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'result',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    '20260116-143052-a7b3c9',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    43,  -- scoped to this execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'let',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    E'Processed chunk into 3 sub-parts...',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'let result = session \"Process chunk\"'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ON CONFLICT (name, run_id, COALESCE(execution_id, -1)) DO UPDATE（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SET value = EXCLUDED.value, updated_at = NOW()（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For persistent agents (execution-scoped):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your memory is in the database:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Read your current state:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  psql "$OPENPROSE_POSTGRES_URL" -t -A -c "SELECT memory FROM openprose.agents WHERE name = 'captain' AND run_id = '20260116-143052-a7b3c9'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Update when done:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  psql "$OPENPROSE_POSTGRES_URL" -c "UPDATE openprose.agents SET memory = '...', updated_at = NOW() WHERE name = 'captain' AND run_id = '20260116-143052-a7b3c9'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Record this segment:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  psql "$OPENPROSE_POSTGRES_URL" -c "INSERT INTO openprose.agent_segments (agent_name, run_id, segment_number, prompt, summary) VALUES ('captain', '20260116-143052-a7b3c9', 3, '...', '...')"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For project-scoped agents, use `run_id IS NULL` in queries:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Read project-scoped agent memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT memory FROM openprose.agents WHERE name = 'advisor' AND run_id IS NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Update project-scoped agent memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE openprose.agents SET memory = '...' WHERE name = 'advisor' AND run_id IS NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context Preservation in Main Thread（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**This is critical.** The database is for persistence and coordination, but the VM must still maintain conversational context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What the VM Must Narrate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Even with PostgreSQL state, the VM should narrate key events in its conversation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] Statement 3: let research = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Spawning session, will write to state database（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Task tool call]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Success] Session complete, binding written to DB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] research = <stored in openprose.bindings>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why Both?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Purpose                   | Mechanism                                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------- | -------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Working memory**        | Conversation narration (what the VM "remembers" without re-querying) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Durable state**         | PostgreSQL database (survives context limits, enables resumption)    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Subagent coordination** | PostgreSQL database (shared access point)                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Debugging/inspection**  | PostgreSQL database (queryable history)                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The narration is the VM's "mental model" of execution. The database is the "source of truth" for resumption and inspection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Parallel Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For parallel blocks, the VM uses the `metadata` JSONB field to track branches. **Only the VM writes to the `execution` table.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- VM marks parallel start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
INSERT INTO openprose.execution (run_id, statement_index, statement_text, status, started_at, metadata)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
VALUES ('20260116-143052-a7b3c9', 5, 'parallel:', 'executing', NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  '{"parallel_id": "p1", "strategy": "all", "branches": ["a", "b", "c"]}'::jsonb)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RETURNING id;  -- Save as parent_id (e.g., 42)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- VM creates execution record for each branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
INSERT INTO openprose.execution (run_id, statement_index, statement_text, status, started_at, parent_id, metadata)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
VALUES（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ('20260116-143052-a7b3c9', 6, 'a = session "Task A"', 'executing', NOW(), 42, '{"parallel_id": "p1", "branch": "a"}'::jsonb),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ('20260116-143052-a7b3c9', 7, 'b = session "Task B"', 'executing', NOW(), 42, '{"parallel_id": "p1", "branch": "b"}'::jsonb),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ('20260116-143052-a7b3c9', 8, 'c = session "Task C"', 'executing', NOW(), 42, '{"parallel_id": "p1", "branch": "c"}'::jsonb);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Subagents write their outputs to bindings table (see "From Subagents" section)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Task tool signals completion to VM via substrate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- VM marks branch complete after Task returns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE openprose.execution SET status = 'completed', completed_at = NOW()（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE run_id = '20260116-143052-a7b3c9' AND metadata->>'parallel_id' = 'p1' AND metadata->>'branch' = 'a';（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- VM checks if all branches complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT COUNT(*) AS pending FROM openprose.execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE run_id = '20260116-143052-a7b3c9'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND metadata->>'parallel_id' = 'p1'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND parent_id IS NOT NULL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND status NOT IN ('completed', 'failed', 'skipped');（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### The Concurrency Advantage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each subagent writes to a different row in `openprose.bindings`. PostgreSQL's row-level locking means **no blocking**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SQLite (table locks):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Branch 1 writes -------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                         Branch 2 waits ------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                                              Branch 3 waits -----|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Total time: 3 * write_time (serialized)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PostgreSQL (row locks):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Branch 1 writes  --|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Branch 2 writes  --|  (concurrent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Branch 3 writes  --|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Total time: ~1 * write_time (parallel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Loop Tracking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Loop metadata tracks iteration state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
INSERT INTO openprose.execution (run_id, statement_index, statement_text, status, started_at, metadata)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
VALUES ('20260116-143052-a7b3c9', 10, 'loop until **analysis complete** (max: 5):', 'executing', NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  '{"loop_id": "l1", "max_iterations": 5, "current_iteration": 0, "condition": "**analysis complete**"}'::jsonb);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Update iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE openprose.execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SET metadata = jsonb_set(metadata, '{current_iteration}', '2')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE run_id = '20260116-143052-a7b3c9' AND metadata->>'loop_id' = 'l1' AND parent_id IS NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Record failure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE openprose.execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SET status = 'failed',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    error_message = 'Connection timeout after 30s',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    completed_at = NOW()（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE id = 15;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Track retry attempts in metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE openprose.execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SET metadata = jsonb_set(jsonb_set(metadata, '{retry_attempt}', '2'), '{max_retries}', '3')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE id = 15;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Mark run as failed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE openprose.run SET status = 'failed' WHERE id = '20260116-143052-a7b3c9';（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Project-Scoped and User-Scoped Agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution-scoped agents (the default) use `run_id = specific value`. **Project-scoped agents** (`persist: project`) and **user-scoped agents** (`persist: user`) use `run_id IS NULL` and survive across runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For user-scoped agents, the VM maintains a separate connection or uses a naming convention to distinguish them from project-scoped agents. One approach is to prefix user-scoped agent names with `__user__` in the same database, or use a separate user-level database configured via `OPENPROSE_POSTGRES_USER_URL`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### The run_id Approach（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `COALESCE` trick in the primary key allows both scopes in one table:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PRIMARY KEY (name, COALESCE(run_id, '__project__'))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This means:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `name='advisor', run_id=NULL` has PK `('advisor', '__project__')`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `name='advisor', run_id='20260116-143052-a7b3c9'` has PK `('advisor', '20260116-143052-a7b3c9')`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The same agent name can exist as both project-scoped and execution-scoped without collision.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Query Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Scope            | Query                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------- | ------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Execution-scoped | `WHERE name = 'captain' AND run_id = '{RUN_ID}'` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Project-scoped   | `WHERE name = 'advisor' AND run_id IS NULL`      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Project-Scoped Memory Guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Project-scoped agents should store generalizable knowledge that accumulates:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**DO store:** User preferences, project context, learned patterns, decision rationale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**DO NOT store:** Run-specific details, time-sensitive information, large data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Agent Cleanup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Execution-scoped:** Can be deleted when run completes or after retention period（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Project-scoped:** Only deleted on explicit user request（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Delete execution-scoped agents for a completed run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DELETE FROM openprose.agents WHERE run_id = '20260116-143052-a7b3c9';（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Delete a specific project-scoped agent (user-initiated)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DELETE FROM openprose.agents WHERE name = 'old_advisor' AND run_id IS NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Large Outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a binding value is too large for comfortable database storage (>100KB):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Write content to `attachments/{binding_name}.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Store the path in the `attachment_path` column（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Leave `value` as a summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
INSERT INTO openprose.bindings (name, run_id, kind, value, attachment_path, source_statement)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
VALUES (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'full_report',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  '20260116-143052-a7b3c9',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'let',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'Full analysis report (847KB) - see attachment',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'attachments/full_report.md',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'let full_report = session "Generate comprehensive report"'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ON CONFLICT (name, run_id) DO UPDATE（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SET value = EXCLUDED.value, attachment_path = EXCLUDED.attachment_path, updated_at = NOW();（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Resuming Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To resume an interrupted run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Find current position（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT statement_index, statement_text, status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
FROM openprose.execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE run_id = '20260116-143052-a7b3c9' AND status = 'executing'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ORDER BY id DESC LIMIT 1;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Get all completed bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT name, kind, value, attachment_path FROM openprose.bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE run_id = '20260116-143052-a7b3c9';（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Get agent memory states（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT name, scope, memory FROM openprose.agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE run_id = '20260116-143052-a7b3c9' OR run_id IS NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Check parallel block status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT metadata->>'branch' AS branch, status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
FROM openprose.execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE run_id = '20260116-143052-a7b3c9'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND metadata->>'parallel_id' IS NOT NULL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND parent_id IS NOT NULL;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Flexibility Encouragement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PostgreSQL state is intentionally **flexible**. The core schema is a starting point. You are encouraged to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Add columns** to existing tables as needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Create extension tables** (prefix with `x_`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Store custom metrics** (timing, token counts, model info)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Build indexes** for your query patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Use JSONB operators** for semi-structured data queries（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example extensions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Custom metrics table（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS openprose.x_metrics (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id SERIAL PRIMARY KEY,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    run_id TEXT REFERENCES openprose.run(id) ON DELETE CASCADE,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    execution_id INTEGER REFERENCES openprose.execution(id) ON DELETE CASCADE,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metric_name TEXT NOT NULL,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metric_value NUMERIC,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metadata JSONB DEFAULT '{}'::jsonb（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Add custom column（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ALTER TABLE openprose.bindings ADD COLUMN IF NOT EXISTS token_count INTEGER;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Create index for common query（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bindings_created ON openprose.bindings(created_at);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The database is your workspace. Use it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Comparison with Other Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Aspect                 | filesystem.md             | in-context.md        | sqlite.md                   | postgres.md           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | ------------------------- | -------------------- | --------------------------- | --------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **State location**     | `.prose/runs/{id}/` files | Conversation history | `.prose/runs/{id}/state.db` | PostgreSQL database   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Queryable**          | Via file reads            | No                   | Yes (SQL)                   | Yes (SQL)             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Atomic updates**     | No                        | N/A                  | Yes (transactions)          | Yes (ACID)            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Concurrent writes**  | Yes (different files)     | N/A                  | **No (table locks)**        | **Yes (row locks)**   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Network access**     | No                        | No                   | No                          | **Yes**               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Team collaboration** | Via file sync             | No                   | Via file sync               | **Yes**               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Schema flexibility** | Rigid file structure      | N/A                  | Flexible                    | Very flexible (JSONB) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Resumption**         | Read state.md             | Re-read conversation | Query database              | Query database        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Complexity ceiling** | High                      | Low (<30 statements) | High                        | **Very high**         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Dependency**         | None                      | None                 | sqlite3 CLI                 | psql CLI + PostgreSQL |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Setup friction**     | Zero                      | Zero                 | Low                         | Medium-High           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Status**             | Stable                    | Stable               | Experimental                | **Experimental**      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PostgreSQL state management:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Uses a **shared PostgreSQL database** for all runs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Provides **true concurrent writes** via row-level locking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Enables **network access** for external tools and dashboards（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Supports **team collaboration** on shared run state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Allows **flexible schema evolution** with JSONB and custom tables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Requires the **psql CLI** and a running PostgreSQL server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Is **experimental**—expect changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The core contract: the VM manages execution flow and spawns subagents; subagents write their own outputs directly to the database. Completion is signaled through the Task tool return, not database updates. External tools can query execution state in real-time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**PostgreSQL state is for power users.** If you don't need concurrent writes, network access, or team collaboration, filesystem or SQLite state will be simpler and sufficient.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
