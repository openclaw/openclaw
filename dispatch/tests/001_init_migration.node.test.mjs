import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrationPath = path.resolve(
  process.cwd(),
  "dispatch/db/migrations/001_init.sql",
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");

const expectSql = (pattern, message) => {
  assert.match(migrationSql, pattern, message);
};

test("creates required core tables", () => {
  expectSql(/CREATE TABLE IF NOT EXISTS tickets \(/, "tickets table missing");
  expectSql(/CREATE TABLE IF NOT EXISTS audit_events \(/, "audit_events table missing");
  expectSql(
    /CREATE TABLE IF NOT EXISTS ticket_state_transitions \(/,
    "ticket_state_transitions table missing",
  );
  expectSql(
    /CREATE TABLE IF NOT EXISTS idempotency_keys \(/,
    "idempotency_keys table missing",
  );
  expectSql(
    /CREATE TABLE IF NOT EXISTS evidence_items \(/,
    "evidence_items table missing",
  );
});

test("enforces idempotency uniqueness by actor endpoint request", () => {
  expectSql(
    /UNIQUE\(actor_id, endpoint, request_id\)/,
    "idempotency uniqueness constraint is missing",
  );
});

test("includes fail-closed state transition constraint matrix", () => {
  expectSql(
    /CONSTRAINT chk_ticket_state_transition_valid CHECK \(/,
    "state transition constraint missing",
  );
  expectSql(
    /from_state = 'NEW' AND to_state IN \('NEEDS_INFO', 'TRIAGED'\)/,
    "NEW transitions not constrained",
  );
  expectSql(
    /from_state = 'TRIAGED'[\s\S]*to_state IN \('APPROVAL_REQUIRED', 'READY_TO_SCHEDULE', 'DISPATCHED'\)/,
    "TRIAGED transitions do not include emergency dispatch path",
  );
  expectSql(
    /from_state = 'APPROVAL_REQUIRED'[\s\S]*to_state IN \('READY_TO_SCHEDULE', 'TRIAGED', 'IN_PROGRESS'\)/,
    "APPROVAL_REQUIRED transitions do not include in-progress return path",
  );
  expectSql(
    /from_state = 'IN_PROGRESS'[\s\S]*to_state IN \('ON_HOLD', 'COMPLETED_PENDING_VERIFICATION', 'APPROVAL_REQUIRED'\)/,
    "IN_PROGRESS transitions do not include approval escalation path",
  );
  expectSql(
    /from_state = 'INVOICED' AND to_state = 'CLOSED'/,
    "terminal transition missing",
  );
});

test("creates queue-oriented ticket indexes", () => {
  expectSql(
    /CREATE INDEX IF NOT EXISTS idx_tickets_state_priority_created ON tickets\(state, priority, created_at\);/,
    "state-priority queue index missing",
  );
  expectSql(
    /CREATE INDEX IF NOT EXISTS idx_tickets_state_schedule ON tickets\(state, scheduled_start\);/,
    "state-schedule index missing",
  );
});
