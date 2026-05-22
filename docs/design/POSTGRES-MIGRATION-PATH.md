# ClaWorks PostgreSQL 迁移路径

## 现状（2026-05）

| 组件             | 状态                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `openDatabase()` | `postgresql://` → `db-pg` worker；缺 `pg` 时回退 `~/.claworks/pg-runtime-cache.db`                       |
| Schema 权威      | `packages/claworks-runtime/src/planes/data/schema-bootstrap.sql.ts` + `drizzle/migrations/0000_init.sql` |
| 运维迁移         | `pnpm claworks:migrate`（`CLAWORKS_DATABASE_URL`）                                                       |
| ORM              | ObjectStore 仍用 prepared SQL；**未**接 Drizzle 查询构造器                                               |

## 新集群部署

```bash
export CLAWORKS_DATABASE_URL=postgresql://user:pass@host:5432/claworks
pnpm claworks:migrate
```

在 `claworks.json` 中设置：

```json
{
  "plugins": {
    "entries": {
      "claworks-robot": {
        "config": {
          "data": {
            "database_url": "postgresql://user:pass@host:5432/claworks"
          }
        }
      }
    }
  }
}
```

启动后 `claworks doctor` / `cw_doctor_run` 的 `database_postgres` 应为 **ok**（无 `databaseNote` 回退提示）。

## 依赖

根 `package.json` 已声明可选依赖 `pg`。若未安装：

```bash
pnpm install
```

## SQLite → PostgreSQL

1. 在新 PG 上执行 `pnpm claworks:migrate`
2. 导出 SQLite `cw_objects` / `cw_playbook_runs` / `cw_events`（按需脚本或 ETL）
3. 切换 `database_url` 并重启 Gateway

遗留 SQLite 文件默认路径：`~/.claworks/robot.db`。

## 与 MIGRATION-GUIDE.md 的关系

`MIGRATION-GUIDE.md` 描述长期 **Drizzle 全量 ORM + 9 段 Alembic 历史**；当前交付的是 **ClaWorks 运行时表**（`cw_*`）的生产 PG 路径。工业 OT 历史表（equipment/alarms）仍在 Pack/集成层，不在 `cw_*` schema 内。
