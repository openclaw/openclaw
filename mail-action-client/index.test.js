const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const client = require('./index');
const {
  executeMailAction,
  __test: helpers
} = client;

function createMailboxes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-action-client-'));
  return {
    root,
    mailboxes: {
      stitch: {
        key: 'stitch',
        provider: 'microsoft',
        address: 'stitch@prestigiocustom.com',
        dir: path.join(root, 'mail'),
        historyEndpoints: ['http://127.0.0.1:39001/thread-by-subject']
      },
      chris: {
        key: 'chris',
        provider: 'microsoft',
        address: 'chris@prestigiocustom.com',
        dir: path.join(root, 'mail-chris'),
        historyEndpoints: ['http://127.0.0.1:39002/thread-by-subject']
      },
      gmail: {
        key: 'gmail',
        provider: 'gmail',
        address: 'chris91744@gmail.com',
        dir: path.join(root, 'mail-gmail'),
        historyEndpoints: ['http://127.0.0.1:39003/mailbox-history']
      }
    }
  };
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, filePath);
}

function actionRequestPath(mailbox, requestId) {
  return helpers.actionRequestPath(mailbox, requestId);
}

function actionResponsePath(mailbox, requestId) {
  return helpers.actionResponsePath(mailbox, requestId);
}

function threadDetailPath(mailbox, requestId) {
  return helpers.threadDetailPath(mailbox, requestId);
}

function startMailboxResponder(mailbox, handler) {
  const requestDir = path.join(mailbox.dir, 'action-requests');
  fs.mkdirSync(requestDir, { recursive: true });
  const seen = new Set();
  const interval = setInterval(async () => {
    const files = fs.readdirSync(requestDir).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      const request = JSON.parse(fs.readFileSync(path.join(requestDir, file), 'utf8'));
      const result = await handler(request);
      if (!result) continue;

      if (result.actionResponse) {
        writeJsonAtomic(actionResponsePath(mailbox, request.requestId), result.actionResponse);
      }
      if (result.threadDetail) {
        writeJsonAtomic(threadDetailPath(mailbox, request.requestId), result.threadDetail);
      }
    }
  }, 10);

  return () => clearInterval(interval);
}

function sampleResolution(overrides = {}) {
  return {
    provider: 'gmail',
    mailbox: 'chris91744@gmail.com',
    found_in: 'mailbox_history',
    aliases_tried: ['ESC 7', 'ESC7'],
    confidence: 0.84,
    matched_thread_subjects: ['ESC 7 missing dimensions'],
    matched_recipients: ['ops@esc7.com'],
    history_winner_reason: 'gmail had the stronger recent thread',
    recipients: [
      { name: 'ESC 7 Ops', email: 'ops@esc7.com', last_seen: '2026-03-23T15:00:00.000Z' }
    ],
    ...overrides
  };
}

function shortlyAfter(iso, offsetMs = 1000) {
  return new Date(Date.parse(iso) + offsetMs).toISOString();
}

test('Microsoft draft through the helper returns a normalized result', async () => {
  const { mailboxes } = createMailboxes();
  const stop = startMailboxResponder(mailboxes.chris, async (request) => ({
    actionResponse: {
      success: true,
      requestId: request.requestId,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'microsoft',
      mailbox: mailboxes.chris.address,
      result: {
        id: 'draft-ms-1',
        subject: request.subject,
        conversationId: 'conv-ms-1',
        webLink: 'https://outlook.example/draft-ms-1'
      }
    }
  }));

  try {
    const result = await executeMailAction({
      action: 'draft',
      mailbox: 'chris',
      subject: 'ESC 7 missing info',
      body: 'Hi team',
      to: ['ops@esc7.com'],
      recipientResolution: sampleResolution()
    }, { mailboxes });

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'microsoft');
    assert.equal(result.mailbox, 'chris@prestigiocustom.com');
    assert.equal(result.result.draft_id, 'draft-ms-1');
    assert.equal(result.result.thread_id, 'conv-ms-1');
    assert.deepEqual(result.result.to, ['ops@esc7.com']);
    assert.deepEqual(result.result.cc, []);
    assert.equal(result.result.draft_type, 'new');
    assert.equal(result.recipientResolutionSummary.provider, 'gmail');
    assert.match(result.summary, /gmail mailbox history/i);
  } finally {
    stop();
  }
});

test('helper strips duplicate Chris signoff before writing draft request', async () => {
  const { mailboxes } = createMailboxes();
  let capturedRequest = null;
  const stop = startMailboxResponder(mailboxes.chris, async (request) => {
    capturedRequest = request;
    return {
      actionResponse: {
        success: true,
        requestId: request.requestId,
        requestedAt: request.requested_at,
        completedAt: shortlyAfter(request.requested_at),
        provider: 'microsoft',
        mailbox: mailboxes.chris.address,
        result: {
          id: 'draft-signature-1',
          subject: request.subject,
          conversationId: 'conv-signature-1',
          webLink: 'https://outlook.example/draft-signature-1'
        }
      }
    };
  });

  try {
    const result = await executeMailAction({
      action: 'draft',
      mailbox: 'chris',
      subject: 'Signature cleanup',
      body: 'Hi Diana,\n\nEither Tuesday or Wednesday works for us.\n\nThank you,\nChris',
      to: ['diana@example.com']
    }, { mailboxes });

    assert.equal(result.ok, true);
    assert.equal(capturedRequest.body, 'Hi Diana,\n\nEither Tuesday or Wednesday works for us.\n\nThank you,');
  } finally {
    stop();
  }
});

test('helper forwards bodyText and sanitized bodyHtml to HTML-capable providers', async () => {
  const { mailboxes } = createMailboxes();
  let capturedRequest = null;
  const stop = startMailboxResponder(mailboxes.chris, async (request) => {
    capturedRequest = request;
    return {
      actionResponse: {
        success: true,
        requestId: request.requestId,
        requestedAt: request.requested_at,
        completedAt: shortlyAfter(request.requested_at),
        provider: 'microsoft',
        mailbox: mailboxes.chris.address,
        result: { id: 'draft-html-1', subject: request.subject }
      }
    };
  });

  try {
    const result = await executeMailAction({
      action: 'draft',
      mailbox: 'chris',
      subject: 'Formatted draft',
      bodyText: 'Hi team\n\nBold update',
      bodyHtml: '<p>Hi team</p><p><strong>Bold update</strong></p><script>alert(1)</script>',
      to: ['team@example.com']
    }, { mailboxes });

    assert.equal(result.ok, true);
    assert.equal(capturedRequest.bodyText, 'Hi team\n\nBold update');
    assert.match(capturedRequest.bodyHtml, /<strong>Bold update<\/strong>/);
    assert.doesNotMatch(capturedRequest.bodyHtml, /<script/i);
  } finally {
    stop();
  }
});

test('helper falls back to plain text when mailbox declares HTML unavailable', () => {
  const request = helpers.buildActionRequest({
    action: 'draft',
    mailbox: 'plain',
    __mailbox: { provider: 'example', supportsHtmlBody: false },
    bodyText: 'Hi team\n\nBold update',
    bodyHtml: '<p>Hi team</p><p><strong>Bold update</strong></p>',
    bodyType: 'HTML'
  }, 'draft-plain', '2026-05-01T12:00:00.000Z');

  assert.equal(request.body, 'Hi team\n\nBold update');
  assert.equal(request.bodyText, undefined);
  assert.equal(request.bodyHtml, undefined);
  assert.equal(request.bodyType, undefined);
});

test('helper does not put literal HTML tags into fallback plain text', () => {
  const request = helpers.buildActionRequest({
    action: 'draft',
    mailbox: 'plain',
    __mailbox: { provider: 'example', supportsHtmlBody: false },
    bodyHtml: '<p>Hi team</p><p><strong>Bold update</strong></p>'
  }, 'draft-html-fallback', '2026-05-01T12:00:00.000Z');

  assert.equal(request.body, 'Hi team\nBold update');
  assert.doesNotMatch(request.body, /<p>|<strong>/);
});

test('normalizeDraftBody preserves bodies without duplicate signature name', () => {
  assert.equal(
    helpers.normalizeDraftBody('Hi Diana,\n\nTuesday works for us.\n\nThank you,'),
    'Hi Diana,\n\nTuesday works for us.\n\nThank you,'
  );
  assert.equal(
    helpers.normalizeDraftBody('Hi Diana,\r\n\r\nTuesday works for us.\r\n\r\nBest,\r\nChris'),
    'Hi Diana,\r\n\r\nTuesday works for us.\r\n\r\nBest,'
  );
});

test('Gmail draft through the helper returns a normalized result', async () => {
  const { mailboxes } = createMailboxes();
  const stop = startMailboxResponder(mailboxes.gmail, async (request) => ({
    actionResponse: {
      success: true,
      requestId: request.requestId,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'gmail',
      mailbox: mailboxes.gmail.address,
      result: {
        id: 'draft-gmail-1',
        message: {
          id: 'msg-gmail-1',
          threadId: 'thread-gmail-1'
        }
      }
    }
  }));

  try {
    const result = await executeMailAction({
      action: 'draft',
      mailbox: 'gmail',
      subject: 'Harbor House follow-up',
      body: 'Hi',
      to: ['team@harborhouse.com']
    }, { mailboxes });

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'gmail');
    assert.equal(result.result.draft_id, 'draft-gmail-1');
    assert.equal(result.result.thread_id, 'thread-gmail-1');
    assert.equal(result.result.message_id, 'msg-gmail-1');
  } finally {
    stop();
  }
});

test('Microsoft reply through the helper reflects the provider reply-all recipients', async () => {
  const { mailboxes } = createMailboxes();
  const stop = startMailboxResponder(mailboxes.chris, async (request) => ({
    actionResponse: {
      success: true,
      requestId: request.requestId,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'microsoft',
      mailbox: mailboxes.chris.address,
      replyRecipientGuard: {
        status: 'narrowed',
        expected_external_count: 3,
        actual_external_count: 2
      },
      result: {
        id: 'reply-ms-1',
        subject: 'RE: Long Valley',
        conversationId: 'conv-reply-1',
        webLink: 'https://outlook.example/reply-ms-1',
        toRecipients: [
          {
            emailAddress: {
              name: 'Madison Williams',
              address: 'madison@clementsdesign.com'
            }
          }
        ],
        ccRecipients: [
          {
            emailAddress: {
              name: 'Stephanie',
              address: 'stephanie@clementsdesign.com'
            }
          }
        ]
      }
    }
  }));

  try {
    const result = await executeMailAction({
      action: 'reply',
      mailbox: 'chris',
      messageId: 'msg-reply-1',
      body: 'Thanks all'
    }, { mailboxes });

    assert.equal(result.ok, true);
    assert.equal(result.result.draft_type, 'reply');
    assert.deepEqual(result.result.to, ['madison@clementsdesign.com']);
    assert.deepEqual(result.result.cc, ['stephanie@clementsdesign.com']);
    assert.deepEqual(result.result.toRecipients, [
      { name: 'Madison Williams', email: 'madison@clementsdesign.com' }
    ]);
    assert.deepEqual(result.result.ccRecipients, [
      { name: 'Stephanie', email: 'stephanie@clementsdesign.com' }
    ]);
    assert.equal(result.result.replyRecipientGuard.status, 'narrowed');
    assert.match(result.summary, /madison@clementsdesign.com/i);
  } finally {
    stop();
  }
});

test('Microsoft mailbox-history lookup through the helper normalizes recipients and provenance', async () => {
  const { mailboxes } = createMailboxes();
  const result = await executeMailAction({
    action: 'lookup_history',
    provider: 'microsoft',
    search: 'ESC 7',
    aliases: ['ESC 7', 'ESC7']
  }, {
    mailboxes,
    postJson: async (_url, body) => {
      if (body.subject !== 'ESC7') {
        return { subject: body.subject, messages: [] };
      }
      return {
        subject: 'Re: ESC7 missing dimensions',
        conversationId: 'conv-esc7',
        messages: [
          {
            from: 'Chris <chris@prestigiocustom.com>',
            to: 'ESC 7 Ops <ops@esc7.com>',
            cc: '',
            date: '2026-03-22T16:00:00.000Z'
          },
          {
            from: 'ESC 7 Ops <ops@esc7.com>',
            to: 'Chris <chris@prestigiocustom.com>',
            cc: 'ESC 7 PM <pm@esc7.com>',
            date: '2026-03-23T16:00:00.000Z'
          }
        ]
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'microsoft');
  assert.equal(result.found_in, 'mailbox_history');
  assert.ok(result.aliases_tried.includes('ESC7'));
  assert.deepEqual(
    result.result.recipients.map((recipient) => recipient.email),
    ['ops@esc7.com', 'pm@esc7.com']
  );
  assert.ok(result.matched_thread_subjects.includes('Re: ESC7 missing dimensions'));
});

test('Gmail mailbox-history lookup through the helper normalizes recipients and provenance', async () => {
  const { mailboxes } = createMailboxes();
  const result = await executeMailAction({
    action: 'lookup_history',
    provider: 'gmail',
    search: 'Harbor House',
    aliases: ['Harbor House']
  }, {
    mailboxes,
    postJson: async () => ({
      provider: 'gmail',
      mailbox: 'chris91744@gmail.com',
      found_in: 'mailbox_history',
      aliases_tried: ['Harbor House'],
      confidence: 0.79,
      matched_thread_subjects: ['Harbor House fabric follow-up'],
      matched_recipients: ['team@harborhouse.com'],
      recipients: [
        { name: 'Harbor House Team', email: 'team@harborhouse.com', last_seen: '2026-03-23T12:00:00.000Z' }
      ],
      winner_reason: 'subject matched Harbor House and the thread was recent',
      candidates: [
        { threadId: 'thread-hh-1', subject: 'Harbor House fabric follow-up' }
      ]
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'gmail');
  assert.equal(result.recipientResolutionSummary.provider, 'gmail');
  assert.equal(result.matched_recipients[0], 'team@harborhouse.com');
  assert.match(result.summary, /gmail mailbox history/i);
});

test('thread normalization formats mailbox timestamps in Los Angeles local time', () => {
  const result = helpers.normalizeThreadResult(
    {
      result: {
        subject: 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table',
        messageCount: 2,
        conversationId: 'conv-long-valley'
      }
    },
    {
      subject: 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table',
      messageCount: 2,
      conversationId: 'conv-long-valley',
      messages: [
        {
          id: 'msg-1',
          subject: 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table',
          date: '2026-03-24T00:48:24Z'
        },
        {
          id: 'msg-2',
          subject: 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table',
          date: '2026-03-24T20:15:00Z'
        }
      ]
    }
  );

  assert.equal(result.presentation_timezone, 'America/Los_Angeles');
  assert.equal(result.messages[0].date, '2026-03-24T00:48:24Z');
  assert.equal(result.messages[0].date_utc, '2026-03-24T00:48:24Z');
  assert.equal(result.messages[0].date_local_short, 'Mar 23');
  assert.equal(result.messages[0].date_local_with_time, 'Mar 23 at 5:48 PM');
  assert.equal(result.messages[0].local_date, '2026-03-23');
  assert.equal(result.messages[1].date_local_short, 'Mar 24');
  assert.equal(result.messages[1].date_local_with_time, 'Mar 24 at 1:15 PM');
  assert.equal(result.messages[1].local_date, '2026-03-24');
});

test('fetch_thread_by_subject preserves Los Angeles-local display dates end-to-end', async () => {
  const { mailboxes } = createMailboxes();
  const stop = startMailboxResponder(mailboxes.chris, async (request) => ({
    actionResponse: {
      success: true,
      requestId: request.requestId,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'microsoft',
      mailbox: mailboxes.chris.address,
      result: {
        subject: request.subject,
        messageCount: 1,
        conversationId: 'conv-la-timezone'
      }
    },
    threadDetail: {
      subject: request.subject,
      messageCount: 1,
      conversationId: 'conv-la-timezone',
      messages: [
        {
          id: 'msg-la-1',
          subject: request.subject,
          from: 'Madison Williams <madison@clementsdesign.com>',
          to: ['chris@prestigiocustom.com'],
          cc: ['stephanie@clementsdesign.com'],
          date: '2026-03-24T00:48:24Z',
          preview: 'Can I please have a quote for the attached piece for Long Valley Living?',
          body: 'Can I please have a quote for the attached piece for Long Valley Living?'
        }
      ]
    }
  }));

  try {
    const result = await executeMailAction({
      action: 'fetch_thread_by_subject',
      mailbox: 'chris',
      subject: 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table'
    }, { mailboxes });

    assert.equal(result.ok, true);
    assert.equal(result.presentation_timezone, 'America/Los_Angeles');
    assert.equal(result.result.presentation_timezone, 'America/Los_Angeles');
    assert.equal(result.result.messages[0].date_local_short, 'Mar 23');
    assert.equal(result.result.messages[0].date_local_with_time, 'Mar 23 at 5:48 PM');
  } finally {
    stop();
  }
});

test('thread fetch actions get a longer default timeout than drafts', () => {
  assert.equal(helpers.resolveTimeoutMs('fetch_thread_by_subject'), client.DEFAULT_THREAD_FETCH_TIMEOUT_MS);
  assert.equal(helpers.resolveTimeoutMs('fetch_thread'), client.DEFAULT_THREAD_FETCH_TIMEOUT_MS);
  assert.equal(helpers.resolveTimeoutMs('draft'), client.DEFAULT_TIMEOUT_MS);
  assert.equal(helpers.resolveTimeoutMs('fetch_thread_by_subject', 1234), client.MIN_THREAD_FETCH_TIMEOUT_MS);
});

test('concurrent helper draft requests do not collide', async () => {
  const { mailboxes } = createMailboxes();
  const stop = startMailboxResponder(mailboxes.chris, async (request) => ({
    actionResponse: {
      success: true,
      requestId: request.requestId,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'microsoft',
      mailbox: mailboxes.chris.address,
      result: {
        id: `draft-${request.subject}`,
        subject: request.subject,
        conversationId: `conv-${request.subject}`
      }
    }
  }));

  try {
    const [first, second] = await Promise.all([
      executeMailAction({
        action: 'draft',
        mailbox: 'chris',
        subject: 'First',
        body: 'One',
        to: ['one@example.com']
      }, { mailboxes }),
      executeMailAction({
        action: 'draft',
        mailbox: 'chris',
        subject: 'Second',
        body: 'Two',
        to: ['two@example.com']
      }, { mailboxes })
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(first.result.draft_id, 'draft-First');
    assert.equal(second.result.draft_id, 'draft-Second');
    assert.ok(fs.existsSync(actionRequestPath(mailboxes.chris, first.requestId)));
    assert.ok(fs.existsSync(actionRequestPath(mailboxes.chris, second.requestId)));
  } finally {
    stop();
  }
});

test('helper reports a timeout when thread detail never arrives after an action response', async () => {
  const { mailboxes } = createMailboxes();
  const stop = startMailboxResponder(mailboxes.chris, async (request) => ({
    actionResponse: {
      success: true,
      requestId: request.requestId,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'microsoft',
      mailbox: mailboxes.chris.address,
      result: {
        subject: 'Re: Thread fetch',
        conversationId: 'conv-timeout'
      }
    }
  }));

  try {
    const result = await executeMailAction({
      action: 'fetch_thread',
      mailbox: 'chris',
      messageId: 'msg-timeout',
      timeoutMs: 150,
      pollIntervalMs: 20
    }, { mailboxes });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'timeout');
    assert.match(result.summary, /timed out/i);
  } finally {
    stop();
  }
});

test('helper returns a structured ambiguous_thread error when subject fetch is not confident', async () => {
  const { mailboxes } = createMailboxes();
  const stop = startMailboxResponder(mailboxes.chris, async (request) => ({
    actionResponse: {
      success: true,
      requestId: request.requestId,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'microsoft',
      mailbox: mailboxes.chris.address,
      result: {
        ambiguous: true,
        subject: request.subject,
        ambiguityMessage: 'I found two likely Long Valley Loggia threads: Sofa and Ottoman Coffee Table.',
        candidates: [
          { subject: 'Quote Request - Long Valley Living / Loggia / Sofa', score: 91 },
          { subject: 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table', score: 90 }
        ],
        messageCount: 0,
        conversationId: null
      }
    },
    threadDetail: {
      ambiguous: true,
      requestedSubject: request.subject,
      candidates: [
        { subject: 'Quote Request - Long Valley Living / Loggia / Sofa', score: 91 },
        { subject: 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table', score: 90 }
      ],
      ambiguityMessage: 'I found two likely Long Valley Loggia threads: Sofa and Ottoman Coffee Table.',
      messages: [],
      messageCount: 0
    }
  }));

  try {
    const result = await executeMailAction({
      action: 'fetch_thread_by_subject',
      mailbox: 'chris',
      subject: 'Quote Request - Long Valley Living / Loggia'
    }, { mailboxes });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ambiguous_thread');
    assert.match(result.summary, /two likely Long Valley Loggia threads/i);
    assert.equal(result.result.ambiguous, true);
    assert.equal(result.result.candidates.length, 2);
  } finally {
    stop();
  }
});

test('helper reports a missing response file when no service reply appears', async () => {
  const { mailboxes } = createMailboxes();
  const result = await executeMailAction({
    action: 'draft',
    mailbox: 'gmail',
    subject: 'No response',
    body: 'Hello',
    to: ['nobody@example.com'],
    timeoutMs: 120,
    pollIntervalMs: 20
  }, { mailboxes });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing_response');
  assert.match(result.summary, /no response file/i);
});

test('helper rejects stale pre-existing response files', async () => {
  const { mailboxes } = createMailboxes();
  const fixedRequestId = 'stale-request';
  writeJsonAtomic(actionResponsePath(mailboxes.chris, fixedRequestId), {
    success: true,
    requestId: fixedRequestId,
    requestedAt: '2026-03-23T15:59:00.000Z',
    completedAt: '2026-03-23T15:59:01.000Z',
    result: { id: 'old-draft' }
  });

  const result = await executeMailAction({
    action: 'draft',
    mailbox: 'chris',
    subject: 'Fresh request',
    body: 'Hello',
    to: ['ops@example.com']
  }, {
    mailboxes,
    requestIdFactory: () => fixedRequestId,
    now: new Date('2026-03-23T16:20:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'stale_response');
});

test('helper rejects response files with a mismatched requestId', async () => {
  const { mailboxes } = createMailboxes();
  const stop = startMailboxResponder(mailboxes.chris, async (request) => ({
    actionResponse: {
      success: true,
      requestId: `${request.requestId}-wrong`,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'microsoft',
      mailbox: mailboxes.chris.address,
      result: { id: 'draft-mismatch' }
    }
  }));

  try {
    const result = await executeMailAction({
      action: 'draft',
      mailbox: 'chris',
      subject: 'Mismatch',
      body: 'Hello',
      to: ['ops@example.com']
    }, { mailboxes });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'request_id_mismatch');
  } finally {
    stop();
  }
});

test('unsupported provider/action combinations fail clearly', async () => {
  const { mailboxes } = createMailboxes();
  const result = await executeMailAction({
    action: 'reply',
    mailbox: 'gmail',
    messageId: 'msg-1',
    body: 'Hello'
  }, { mailboxes });

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'gmail');
  assert.equal(result.error.code, 'unsupported_action');
  assert.match(result.summary, /gmail does not support reply/i);
});

test('Microsoft attachment download returns normalized attachment metadata', async () => {
  const { mailboxes } = createMailboxes();
  const stop = startMailboxResponder(mailboxes.chris, async (request) => ({
    actionResponse: {
      success: true,
      requestId: request.requestId,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'microsoft',
      mailbox: mailboxes.chris.address,
      result: {
        messageId: request.messageId,
        outputDir: '/mail-output/attachments/message-1',
        totalBytes: 12,
        attachments: [
          {
            id: 'attachment-1',
            name: 'Schedule.pdf',
            contentType: 'application/pdf',
            size: 12,
            sha256: 'abc123',
            path: '/mail-output/attachments/message-1/Schedule.pdf'
          }
        ],
        skipped: []
      }
    }
  }));

  try {
    const result = await executeMailAction({
      action: 'download_attachments',
      mailbox: 'chris',
      messageId: 'message-1'
    }, { mailboxes });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'download_attachments');
    assert.equal(result.result.message_id, 'message-1');
    assert.equal(result.result.attachment_count, 1);
    assert.equal(result.result.attachments[0].name, 'Schedule.pdf');
    assert.equal(result.result.output_dir, path.join(mailboxes.chris.dir, 'attachments/message-1'));
    assert.equal(result.result.attachments[0].path, path.join(mailboxes.chris.dir, 'attachments/message-1/Schedule.pdf'));
    assert.match(result.summary, /Downloaded 1 attachment/i);
  } finally {
    stop();
  }
});

test('Gmail attachment download is blocked until implemented', async () => {
  const { mailboxes } = createMailboxes();
  const result = await executeMailAction({
    action: 'download_attachments',
    mailbox: 'gmail',
    messageId: 'message-1'
  }, { mailboxes });

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'gmail');
  assert.equal(result.error.code, 'unsupported_action');
});

test('end-to-end provenance survives through helper draft results', async () => {
  const { mailboxes } = createMailboxes();
  const resolution = sampleResolution({
    matched_thread_subjects: ['Harbor House missing dimensions'],
    matched_recipients: ['team@harborhouse.com'],
    recipients: [
      { name: 'Harbor House Team', email: 'team@harborhouse.com', last_seen: '2026-03-23T11:00:00.000Z' }
    ]
  });
  const stop = startMailboxResponder(mailboxes.chris, async (request) => ({
    actionResponse: {
      success: true,
      requestId: request.requestId,
      requestedAt: request.requested_at,
      completedAt: shortlyAfter(request.requested_at),
      provider: 'microsoft',
      mailbox: mailboxes.chris.address,
      result: {
        id: 'draft-harbor',
        subject: request.subject,
        conversationId: 'conv-harbor'
      }
    }
  }));

  try {
    const result = await executeMailAction({
      action: 'draft',
      mailbox: 'chris',
      subject: 'Harbor House follow-up',
      body: 'Hi team',
      to: ['team@harborhouse.com'],
      recipientResolution: resolution
    }, { mailboxes });

    assert.equal(result.ok, true);
    assert.equal(result.recipientResolution.provider, 'gmail');
    assert.equal(result.recipientResolutionSummary.provider, 'gmail');
    assert.equal(result.found_in, 'mailbox_history');
    assert.equal(result.matched_recipients[0], 'team@harborhouse.com');
    assert.match(result.summary, /recipient evidence came from gmail mailbox history/i);
  } finally {
    stop();
  }
});
