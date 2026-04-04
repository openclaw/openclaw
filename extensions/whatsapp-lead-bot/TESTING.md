# Testing Strategy - WhatsApp Lead Bot

## Current Coverage

**Test Files:**

- `src/followup/__tests__/scheduler.test.ts` — Follow-up scheduler (9 tests)
- `src/rate-limit/__tests__/coordinator.test.ts` — Rate limiting (17 tests)

**Run tests:**

```bash
cd extensions/whatsapp-lead-bot
npm test              # Run all tests once
npm run test:watch    # Watch mode for development
```

## Critical Tests

### Follow-Up Scheduler

**Purpose:** Prevent infinite retry loops when sending follow-up messages.

**Bug scenario:**

- Plugin sends follow-up message to silent lead
- `follow_up_sent_at` is **not** updated
- On next check, same lead appears as "silent" again
- Message sends repeatedly → spam

**Regression test:**

```typescript
it("should update BOTH last_bot_reply_at AND follow_up_sent_at after sending", async () => {
  await scheduler.checkAndSend();

  // CRITICAL: Both timestamps must be updated
  expect(mockDb.updateLastBotReply).toHaveBeenCalledWith(mockLead.id, expect.any(Number));
  expect(mockDb.updateFollowUpSentAt).toHaveBeenCalledWith(mockLead.id, expect.any(Number));
});
```

**What it tests:**

1. ✅ Follow-ups are sent to silent leads
2. ✅ Both `last_bot_reply_at` AND `follow_up_sent_at` are updated
3. ✅ Same timestamp is used for both (atomicity)
4. ✅ Disabled config is respected
5. ✅ Multiple leads are handled correctly
6. ✅ Message formatting works (with/without name/location)
7. ✅ Errors are handled gracefully
8. ✅ Infinite retry loop is prevented

## Integration Testing

### Manual Test Flow

**Setup:**

1. Create test lead in database (status: `qualifying`, `follow_up_sent_at: NULL`)
2. Ensure gateway is running with plugin enabled
3. Wait for scheduler check interval (~5-15 min)

**Expected:**

- ✅ Single follow-up message sent to test lead
- ✅ `follow_up_sent_at` timestamp set in database
- ✅ On next check: lead is **not** selected again

**Verify:**

```bash
# Check lead status
sqlite3 workspace-solayre/data/leads.db \
  "SELECT id, phone_number, follow_up_sent_at, last_bot_reply_at FROM leads WHERE id = <TEST_ID>;"

# Expected: both timestamps should be set and match
```

## Bot Automation Testing

### End-to-End Scenarios

**Scenario 1: New Lead → Quote → Follow-Up**

```
1. Send message from test number
2. Bot qualifies lead (ask 4 questions)
3. Bot sends quote
4. Lead goes silent (no response)
5. After 24h, bot sends follow-up
6. Verify follow_up_sent_at is set
```

**Scenario 2: Receipt Upload → Quote → Handoff**

```
1. Send message from test number
2. Upload CFE receipt PDF
3. Bot extracts data, quotes
4. Lead responds with interest
5. Bot hands off to agent
6. Verify no follow-ups are sent (status: handed_off)
```

**Scenario 3: Rate Limit Protection**

```
1. Send 10 messages in 1 minute from test number
2. Bot should rate-limit after message #6
3. Verify circuit breaker logs
4. Wait 1 hour, verify rate limit reset
```

## Pre-Deploy Testing

**Before deploying changes:**

```bash
cd ~/openclaw-docker/extensions/whatsapp-lead-bot
npm test
```

**Expected:** All tests pass (26/26)
**If tests fail:** Do not deploy, fix the issue first

## Monitoring & Alerts

**Production Checks:**

1. **Follow-up spam detection:**

   ```sql
   -- Check for leads with multiple follow-ups in short time
   SELECT phone_number, COUNT(*) as msg_count
   FROM handoff_log
   WHERE event = 'followup_sent'
     AND timestamp > (strftime('%s','now') - 3600) * 1000
   GROUP BY phone_number
   HAVING msg_count > 3;
   ```

2. **Circuit breaker trips:**

   ```bash
   tail -f ~/.openclaw/logs/gateway.log | grep "TRIPPED"
   ```

3. **Rate limit violations:**
   ```bash
   tail -f ~/.openclaw/logs/gateway.log | grep "rate-limit"
   ```

## Performance Benchmarks

**Database queries:**

- `getSilentLeads()`: < 50ms for 1000 leads
- `updateFollowUpSentAt()`: < 10ms

**Follow-up check cycle:**

- Full cycle: < 500ms for 100 active leads
- Memory usage: < 20MB

## Known Issues & Workarounds

### Issue: WhatsApp Rate Limits

**Symptom:** Messages fail with 429 error
**Solution:** Circuit breaker automatically trips, pauses sending for 1h
**Config:** Adjust `rateLimit.messagesPerHour` in plugin config

### Issue: Database Lock

**Symptom:** `SQLITE_BUSY` errors during high load
**Solution:** Database uses WAL mode + connection pooling
**Recovery:** Restart gateway if persistent

## Future Improvements

**Planned:**

1. ✅ Unit tests for follow-up scheduler (DONE)
2. ⏳ Integration tests for receipt parser
3. ⏳ E2E test suite with mock WhatsApp API
4. ⏳ Load testing for high-volume scenarios (1000+ leads)
5. ⏳ Snapshot tests for message templates
6. ⏳ Database migration tests

**Suggested:**

- Add test coverage reporting
- Set up mutation testing
- Add visual regression tests for admin UI (if added)

## Debugging Tips

**Enable verbose logging:**

```bash
# Gateway logs
tail -f ~/.openclaw/logs/gateway.log | grep -E "followup|lead-bot"

# Database queries (add to connection.ts)
db.on('trace', (sql) => console.log('[SQL]', sql));
```

**Inspect lead state:**

```bash
sqlite3 workspace-solayre/data/leads.db
.mode column
SELECT id, phone_number, status, follow_up_sent_at, last_message_at FROM leads;
```

**Reset test lead:**

```bash
node scripts/reset-lead.mjs <PHONE_NUMBER>
```

---

**Last Updated:** 2026-02-25
**Test Coverage:** 26 tests across 2 suites
**Status:** ✅ All passing
