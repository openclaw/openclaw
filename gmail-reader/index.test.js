const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-reader-test-'));
process.env.MAIL_OUTPUT_DIR = tempRoot;
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'client';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'secret';

const gmailReader = require('./index');
const helpers = gmailReader.__test;

test('Gmail draft MIME stays plain text when no HTML body is supplied', () => {
  const raw = helpers.buildRawDraftMessage({
    subject: 'Plain',
    to: ['team@example.com'],
    body: 'Hi team'
  });

  assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.doesNotMatch(raw, /multipart\/alternative|text\/html/);
  assert.match(raw, /\r\n\r\nHi team$/);
});

test('Gmail draft MIME includes sanitized HTML and plain fallback', () => {
  const raw = helpers.buildRawDraftMessage({
    subject: 'Formatted',
    to: ['team@example.com'],
    bodyText: 'Hi team\n\nBold update',
    bodyHtml: '<p>Hi team</p><p><strong>Bold update</strong></p><script>alert(1)</script>'
  });

  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(raw, /Hi team\r\n\r\nBold update/);
  assert.match(raw, /Content-Type: text\/html; charset="UTF-8"/);
  assert.match(raw, /<strong>Bold update<\/strong>/);
  assert.doesNotMatch(raw, /<script/i);
});

test('Gmail HTML-only draft derives plain fallback without literal tags', () => {
  const raw = helpers.buildRawDraftMessage({
    subject: 'HTML only',
    to: ['team@example.com'],
    bodyHtml: '<p>Hi team</p><p><strong>Bold update</strong></p>'
  });

  assert.match(raw, /Hi team\r\nBold update/);
  assert.doesNotMatch(raw, /<p>Hi team<\/p>[\s\S]*Content-Type: text\/plain/);
});

test('searchMailboxHistory groups Gmail hits by thread and ranks the strongest external-recipient thread', async () => {
  const seenQueries = [];
  const result = await helpers.searchMailboxHistory({
    search: 'ESC 7 team',
    aliases: ['ESC 7', 'ESC7', 'ESC-7'],
    participants: ['ops@esc7.com']
  }, {
    searchMessageIds: async (query) => {
      seenQueries.push(query);
      if (query.includes('subject:\"ESC 7\"')) {
        return [{ id: 'msg-thread-1' }, { id: 'msg-thread-2' }];
      }
      if (query.includes('subject:\"ESC7\"')) {
        return [{ id: 'msg-thread-2' }];
      }
      return [];
    },
    fetchMessageMetadata: async (messageId) => {
      if (messageId === 'msg-thread-1') {
        return {
          threadId: 'thread-1',
          payload: {
            headers: [
              { name: 'Subject', value: 'ESC 7 samples follow-up' },
              { name: 'Date', value: '2025-01-05T10:00:00.000Z' }
            ]
          }
        };
      }

      return {
        threadId: 'thread-2',
        payload: {
          headers: [
            { name: 'Subject', value: 'Re: ESC7 missing dimensions' },
            { name: 'Date', value: '2026-03-21T16:00:00.000Z' }
          ]
        }
      };
    },
    fetchThreadMetadata: async (threadId) => {
      if (threadId === 'thread-1') {
        return [
          {
            id: 'old-1',
            threadId,
            subject: 'ESC 7 samples follow-up',
            from: 'Chris <chris@prestigiocustom.com>',
            to: 'Old Contact <old@esc7.com>',
            cc: '',
            date: '2025-01-05T10:00:00.000Z'
          }
        ];
      }

      return [
        {
          id: 'new-1',
          threadId,
          subject: 'Re: ESC7 missing dimensions',
          from: 'Chris <chris91744@gmail.com>',
          to: 'ESC 7 Ops <ops@esc7.com>',
          cc: 'Chris Work <chris@prestigiocustom.com>',
          date: '2026-03-20T16:00:00.000Z'
        },
        {
          id: 'new-2',
          threadId,
          subject: 'Re: ESC7 missing dimensions',
          from: 'ESC 7 Ops <ops@esc7.com>',
          to: 'Chris <chris91744@gmail.com>',
          cc: 'ESC 7 PM <pm@esc7.com>',
          date: '2026-03-21T16:00:00.000Z'
        }
      ];
    }
  });

  assert.equal(result.provider, 'gmail');
  assert.equal(result.found_in, 'mailbox_history');
  assert.ok(seenQueries.some((query) => query.includes('(from:ops@esc7.com OR to:ops@esc7.com OR cc:ops@esc7.com)')));
  assert.ok(result.aliases_tried.includes('ESC7'));
  assert.equal(result.recipients[0].email, 'ops@esc7.com');
  assert.equal(result.recipients[1].email, 'pm@esc7.com');
  assert.deepEqual(
    result.recipients.map((recipient) => recipient.email),
    ['ops@esc7.com', 'pm@esc7.com']
  );
  assert.ok(result.matched_thread_subjects.includes('Re: ESC7 missing dimensions'));
  assert.ok(result.matched_recipients.includes('pm@esc7.com'));
  assert.ok(result.confidence > 0.55);
  assert.match(result.winner_reason, /subject matched/i);
  assert.equal(result.candidates[0].threadId, 'thread-2');
});

test('searchMailboxHistory returns an explicit miss when Gmail search finds no candidate threads', async () => {
  const result = await helpers.searchMailboxHistory({
    search: 'No Such Team'
  }, {
    searchMessageIds: async () => [],
    fetchMessageMetadata: async () => {
      throw new Error('should not fetch metadata on a total miss');
    },
    fetchThreadMetadata: async () => {
      throw new Error('should not fetch threads on a total miss');
    }
  });

  assert.equal(result.provider, 'gmail');
  assert.equal(result.found_in, 'mailbox_history');
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.recipients, []);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.winner_reason, null);
});
