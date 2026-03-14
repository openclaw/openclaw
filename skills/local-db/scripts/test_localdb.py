#!/usr/bin/env python3
"""
Tests for localdb helpers.
"""

import os
import sqlite3
import tempfile
from unittest import TestCase, main
from unittest.mock import patch

# Patch DB_DIR before importing
_tmpdir = tempfile.mkdtemp()

with patch.dict(os.environ, {}):
    import localdb

    localdb.DB_DIR = _tmpdir


class TestGetDbPath(TestCase):
    def test_valid_names(self):
        for name in ["mydb", "test-db", "db_123", "A"]:
            path = localdb.get_db_path(name)
            self.assertTrue(path.endswith(f"{name}.db"))

    def test_invalid_names_exit(self):
        for name in ["../etc", "my db", "db;drop", "a/b", ""]:
            with self.assertRaises(SystemExit):
                localdb.get_db_path(name)


class TestDestructiveGuard(TestCase):
    def test_detects_drop_table(self):
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search("DROP TABLE users"))

    def test_detects_delete_from(self):
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search("DELETE FROM users WHERE id=1"))

    def test_detects_truncate(self):
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search("TRUNCATE users"))

    def test_allows_select(self):
        self.assertIsNone(localdb._DESTRUCTIVE_PATTERNS.search("SELECT * FROM users"))

    def test_allows_insert(self):
        self.assertIsNone(localdb._DESTRUCTIVE_PATTERNS.search("INSERT INTO users (name) VALUES ('a')"))

    def test_allows_create_table(self):
        self.assertIsNone(localdb._DESTRUCTIVE_PATTERNS.search("CREATE TABLE users (id INTEGER)"))

    def test_detects_quoted_alter_table_drop(self):
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search('ALTER TABLE "u-ser" DROP COLUMN c'))

    def test_detects_raw_double_quoted_spaced_alter_drop(self):
        # .*?\bDROP\b: raw SQL (no strip) matches regardless of identifier style
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search('ALTER TABLE "my table" DROP COLUMN c'))

    def test_detects_raw_backtick_spaced_alter_drop(self):
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search('ALTER TABLE `my table` DROP COLUMN c'))

    def test_no_false_positive_alter_table_add(self):
        self.assertIsNone(localdb._DESTRUCTIVE_PATTERNS.search('ALTER TABLE users ADD COLUMN created_at TEXT'))

    def test_no_false_positive_alter_table_column_named_dropped(self):
        self.assertIsNone(localdb._DESTRUCTIVE_PATTERNS.search('ALTER TABLE t ADD COLUMN dropped_at TEXT'))


class TestStripSqlForPatternCheck(TestCase):
    """Ensure destructive-pattern check catches obfuscation and avoids false positives."""

    def test_rejects_comment_obfuscated_drop(self):
        stripped = localdb._strip_sql_for_pattern_check("DROP/**/TABLE users")
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search(stripped))

    def test_rejects_line_comment_obfuscated_delete(self):
        stripped = localdb._strip_sql_for_pattern_check("DELETE-- comment\nFROM t")
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search(stripped))

    def test_no_false_positive_keyword_in_string(self):
        stripped = localdb._strip_sql_for_pattern_check("INSERT INTO t VALUES ('TRUNCATE')")
        self.assertIsNone(localdb._DESTRUCTIVE_PATTERNS.search(stripped))

    def test_no_false_positive_drop_in_string(self):
        stripped = localdb._strip_sql_for_pattern_check("INSERT INTO t VALUES ('DROP TABLE x')")
        self.assertIsNone(localdb._DESTRUCTIVE_PATTERNS.search(stripped))

    def test_detects_spaced_identifier_alter_drop(self):
        stripped = localdb._strip_sql_for_pattern_check('ALTER TABLE "my table" DROP COLUMN c')
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search(stripped))

    def test_detects_backtick_spaced_identifier_alter_drop(self):
        stripped = localdb._strip_sql_for_pattern_check('ALTER TABLE `my table` DROP COLUMN c')
        self.assertIsNotNone(localdb._DESTRUCTIVE_PATTERNS.search(stripped))


class TestSplitSql(TestCase):
    def test_simple_split(self):
        stmts = localdb._split_sql("SELECT 1; SELECT 2")
        self.assertEqual(stmts, ["SELECT 1", "SELECT 2"])

    def test_preserves_semicolon_in_string(self):
        sql = "INSERT INTO t VALUES('a;b'); SELECT * FROM t"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2)
        self.assertIn("a;b", stmts[0])

    def test_preserves_semicolon_in_double_quotes(self):
        sql = 'SELECT "col;name" FROM t; SELECT 1'
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2)
        self.assertIn('"col;name"', stmts[0])

    def test_single_statement_no_semicolon(self):
        stmts = localdb._split_sql("SELECT 1")
        self.assertEqual(stmts, ["SELECT 1"])

    def test_escaped_single_quotes(self):
        sql = "INSERT INTO t VALUES('it''s ok'); SELECT 1"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2)
        self.assertIn("it''s ok", stmts[0])

    def test_escaped_double_quotes(self):
        sql = 'SELECT "col""name" FROM t; SELECT 1'
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2)
        self.assertIn('"col""name"', stmts[0])

    def test_line_comment_with_semicolon(self):
        sql = "SELECT 1 -- comment; not a split\n; SELECT 2"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2)
        self.assertIn("-- comment; not a split", stmts[0])

    def test_block_comment_with_semicolon(self):
        sql = "SELECT /* ignore; this */ 1; SELECT 2"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2)
        self.assertIn("/* ignore; this */", stmts[0])

    def test_bracket_quoted_identifier(self):
        sql = "SELECT [col;name] FROM t; SELECT 1"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2)
        self.assertIn("[col;name]", stmts[0])

    def test_trigger_begin_end_preserves_inner_semicolons(self):
        sql = (
            "CREATE TRIGGER trg AFTER INSERT ON t BEGIN "
            "INSERT INTO log VALUES (1); "
            "INSERT INTO log VALUES (2); "
            "END"
        )
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 1)
        self.assertIn("BEGIN", stmts[0])
        self.assertIn("END", stmts[0])

    def test_trigger_followed_by_another_statement(self):
        sql = (
            "CREATE TRIGGER trg AFTER INSERT ON t BEGIN "
            "INSERT INTO log VALUES (1); END; "
            "SELECT 1"
        )
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2)

    def test_begin_transaction_splits_normally(self):
        sql = "BEGIN TRANSACTION; INSERT INTO t VALUES (1); COMMIT"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 3)
        self.assertEqual(stmts[0], "BEGIN TRANSACTION")
        self.assertEqual(stmts[2], "COMMIT")

    def test_begin_immediate_splits_normally(self):
        sql = "BEGIN IMMEDIATE; INSERT INTO t VALUES (1); COMMIT"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 3)

    def test_backtick_quoted_identifier(self):
        sql = "SELECT `col;name` FROM t; SELECT 1"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2)
        self.assertIn("`col;name`", stmts[0])

    def test_comment_prefix_before_begin_transaction_splits_normally(self):
        # /* comment */ before BEGIN TRANSACTION must NOT be treated as a trigger body
        sql = "/* header */ BEGIN TRANSACTION; INSERT INTO t VALUES (1); COMMIT"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 3, f"Expected 3 stmts, got {stmts}")

    def test_begin_as_identifier_splits_normally(self):
        # 'begin' used as a table name must NOT be treated as a trigger body
        sql = "CREATE TABLE begin (id INTEGER); INSERT INTO begin VALUES (1)"
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 2, f"Expected 2 stmts, got {stmts}")

    def test_trigger_with_case_end_preserved(self):
        # CASE...END inside a trigger body must NOT prematurely close begin_depth
        sql = (
            "CREATE TRIGGER trg AFTER INSERT ON t BEGIN "
            "INSERT INTO x VALUES (CASE WHEN 1 THEN 1 ELSE 0 END); "
            "END"
        )
        stmts = localdb._split_sql(sql)
        self.assertEqual(len(stmts), 1, f"Expected 1 stmt (full trigger), got {stmts}")


class TestCreateAndMigrate(TestCase):
    def setUp(self):
        self.db_name = f"test_{os.getpid()}"
        self.db_path = os.path.join(_tmpdir, f"{self.db_name}.db")

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_create_db(self):
        localdb.cmd_create_db(type("Args", (), {"name": self.db_name, "force": False})())
        self.assertTrue(os.path.exists(self.db_path))
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'"
        )
        self.assertIsNotNone(cursor.fetchone())
        conn.close()

    def test_create_force_recreates(self):
        # Create first
        localdb.cmd_create_db(type("Args", (), {"name": self.db_name, "force": False})())
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE dummy (id INTEGER)")
        conn.commit()
        conn.close()

        # Force recreate
        localdb.cmd_create_db(type("Args", (), {"name": self.db_name, "force": True})())
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='dummy'"
        )
        self.assertIsNone(cursor.fetchone())
        conn.close()


class TestExecCommitBeforeSelect(TestCase):
    """Ensure INSERT + SELECT in same command persists data (bug fix)."""

    def setUp(self):
        self.db_name = f"test_exec_{os.getpid()}"
        self.db_path = os.path.join(_tmpdir, f"{self.db_name}.db")
        localdb.cmd_create_db(type("Args", (), {"name": self.db_name, "force": False})())
        # Create a table first
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE items (name TEXT)")
        conn.commit()
        conn.close()

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_insert_then_select_persists(self):
        args = type("Args", (), {
            "db": self.db_name,
            "sql": "INSERT INTO items VALUES ('apple'); SELECT * FROM items",
            "allow_destructive": False,
            "json_output": False,
        })()
        localdb.cmd_execute(args)
        # Verify data was actually committed
        conn = sqlite3.connect(self.db_path)
        rows = conn.execute("SELECT * FROM items").fetchall()
        conn.close()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], "apple")

    def test_insert_returning_persists_and_returns_rows(self):
        """INSERT...RETURNING must commit the insert AND return the new row."""
        args = type("Args", (), {
            "db": self.db_name,
            "sql": "INSERT INTO items VALUES ('pear') RETURNING name",
            "allow_destructive": False,
            "json_output": False,
        })()
        localdb.cmd_execute(args)
        # Row must be persisted after the RETURNING fetch
        conn = sqlite3.connect(self.db_path)
        rows = conn.execute("SELECT * FROM items").fetchall()
        conn.close()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], "pear")

    def test_ddl_does_not_report_negative_rows(self):
        """DDL statements should not cause negative row counts."""
        args = type("Args", (), {
            "db": self.db_name,
            "sql": "CREATE TABLE extra (id INTEGER); INSERT INTO items VALUES ('x')",
            "allow_destructive": False,
            "json_output": False,
        })()
        localdb.cmd_execute(args)
        conn = sqlite3.connect(self.db_path)
        rows = conn.execute("SELECT * FROM items").fetchall()
        conn.close()
        self.assertEqual(len(rows), 1)


class TestMigrateDestructiveGuard(TestCase):
    """Ensure cmd_migrate blocks destructive SQL."""

    def setUp(self):
        self.db_name = f"test_mig_{os.getpid()}"
        self.db_path = os.path.join(_tmpdir, f"{self.db_name}.db")
        localdb.cmd_create_db(type("Args", (), {"name": self.db_name, "force": False})())

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_migrate_blocks_drop_table(self):
        args = type("Args", (), {
            "db": self.db_name,
            "sql": "DROP TABLE _migrations",
            "description": "bad migration",
        })()
        with self.assertRaises(SystemExit):
            localdb.cmd_migrate(args)

    def test_migrate_blocks_delete_from(self):
        args = type("Args", (), {
            "db": self.db_name,
            "sql": "DELETE FROM _migrations",
            "description": "bad migration",
        })()
        with self.assertRaises(SystemExit):
            localdb.cmd_migrate(args)

    def test_migrate_allows_create_table(self):
        args = type("Args", (), {
            "db": self.db_name,
            "sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
            "description": "add users table",
        })()
        localdb.cmd_migrate(args)
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
        )
        self.assertIsNotNone(cursor.fetchone())
        conn.close()


class TestCmdSchema(TestCase):
    def setUp(self):
        self.db_name = "schematest"
        self.db_path = localdb.get_db_path(self.db_name)
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)")
        conn.commit()
        conn.close()

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_schema_missing_table_exits_nonzero(self):
        """schema --table <missing> must exit with a non-zero status code."""
        args = type("Args", (), {"db": self.db_name, "table": "no_such_table"})()
        with self.assertRaises(SystemExit) as cm:
            localdb.cmd_schema(args)
        self.assertNotEqual(cm.exception.code, 0)

    def test_schema_existing_table_succeeds(self):
        """schema --table <existing> must print DDL without raising SystemExit."""
        args = type("Args", (), {"db": self.db_name, "table": "widgets"})()
        try:
            localdb.cmd_schema(args)
        except SystemExit:
            self.fail("cmd_schema raised SystemExit for an existing table")


if __name__ == "__main__":
    main()
