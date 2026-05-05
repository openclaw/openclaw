const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-reader-test-'));
process.env.MAIL_OUTPUT_DIR = tempRoot;
process.env.MS_TENANT_ID = process.env.MS_TENANT_ID || 'tenant';
process.env.MS_CLIENT_ID = process.env.MS_CLIENT_ID || 'client';
process.env.MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || 'secret';

const { resolveCommunicationTarget } = require('../prestigio-service/resolve-communication-target');
const mailReader = require('./index');
const helpers = mailReader.__test;

function threadMessage(id, conversationId, subject, receivedDateTime, body) {
  return {
    id,
    conversationId,
    subject,
    receivedDateTime,
    bodyPreview: '',
    body: {
      content: body || '',
      contentType: 'text'
    },
    from: {
      emailAddress: {
        name: 'Test Sender',
        address: 'sender@example.com'
      }
    },
    toRecipients: [],
    ccRecipients: [],
    isRead: true,
    hasAttachments: false
  };
}

function graphRecipient(address, name) {
  return {
    emailAddress: {
      address,
      name: name || address
    }
  };
}

test('two request-scoped draft actions do not collide on the action bus', async () => {
  const requestA = 'draft-a';
  const requestB = 'draft-b';
  const requestDir = path.join(tempRoot, 'action-requests');
  fs.mkdirSync(requestDir, { recursive: true });

  fs.writeFileSync(path.join(requestDir, requestA + '.json'), JSON.stringify({
    requestId: requestA,
    action: 'draft',
    subject: 'A',
    requested_at: '2026-03-23T10:00:00.000Z'
  }));
  fs.writeFileSync(path.join(requestDir, requestB + '.json'), JSON.stringify({
    requestId: requestB,
    action: 'draft',
    subject: 'B',
    requested_at: '2026-03-23T10:00:01.000Z'
  }));
  const stableTime = new Date(Date.now() - 1000);
  fs.utimesSync(path.join(requestDir, requestA + '.json'), stableTime, stableTime);
  fs.utimesSync(path.join(requestDir, requestB + '.json'), stableTime, stableTime);

  await helpers.checkForActionRequest({
    draft: async (request) => ({
      responseResult: {
        id: 'draft-' + request.subject,
        subject: request.subject
      }
    })
  });

  const responseA = JSON.parse(fs.readFileSync(helpers.actionResponsePathForRequest(requestA), 'utf8'));
  const responseB = JSON.parse(fs.readFileSync(helpers.actionResponsePathForRequest(requestB), 'utf8'));

  assert.equal(responseA.requestId, requestA);
  assert.equal(responseA.result.id, 'draft-A');
  assert.equal(responseB.requestId, requestB);
  assert.equal(responseB.result.id, 'draft-B');
});

test('resolved recipient provenance survives into the draft result payload', async () => {
  const resolution = await resolveCommunicationTarget('Harbor House', {
    itemLookup: async () => ({ __queryResult: true, data: [] }),
    projectOverview: async () => ({ __queryResult: true, data: { summary: null, items: [] } }),
    clientItems: async () => ({ __queryResult: true, data: [] }),
    projectContacts: async () => ({ __queryResult: true, data: [] }),
    mailboxSearchers: [
      Object.assign(async () => ({
        provider: 'gmail',
        mailbox: 'chris91744@gmail.com',
        found_in: 'mailbox_history',
        confidence: 0.84,
        aliases_tried: ['Harbor House'],
        matched_thread_subjects: ['Harbor House missing dimensions'],
        matched_recipients: ['team@harborhouse.com'],
        recipients: [
          { name: 'Harbor House Team', email: 'team@harborhouse.com', last_seen: '2026-03-21T17:00:00.000Z' }
        ],
        winner_reason: 'gmail had the stronger recent thread'
      }), {
        label: 'chris91744@gmail.com',
        provider: 'gmail',
        searchKind: 'contextual'
      })
    ]
  });

  const requestId = 'draft-with-provenance';
  await helpers.processActionRequest({
    action: 'draft',
    subject: 'Harbor House follow-up',
    to: ['team@harborhouse.com'],
    requested_at: '2026-03-23T10:05:00.000Z',
    recipientResolution: resolution
  }, {
    requestId,
    legacy: false,
    actionHandlers: {
      draft: async (request) => ({
        responseResult: {
          id: 'draft-123',
          subject: request.subject
        }
      })
    }
  });

  const response = JSON.parse(fs.readFileSync(helpers.actionResponsePathForRequest(requestId), 'utf8'));
  assert.equal(response.success, true);
  assert.equal(response.provider, 'microsoft');
  assert.equal(response.recipientResolution.provider, 'gmail');
  assert.equal(response.recipientResolution.matched_recipients[0], 'team@harborhouse.com');
  assert.equal(response.recipientResolutionSummary.provider, 'gmail');
  assert.equal(response.recipientResolutionSummary.mailbox, 'chris91744@gmail.com');
  assert.match(response.recipientResolutionSummary.history_winner_reason, /gmail/i);
});

test('processActionRequest accepts underscore action aliases on the legacy mail bus', async () => {
  const requestId = 'fetch-thread-by-subject-underscore';
  await helpers.processActionRequest({
    action: 'fetch_thread_by_subject',
    subject: 'Re: Prestigio Quote: Hill Rd / Pillow Request — $2,035',
    requested_at: '2026-04-10T20:30:00.000Z'
  }, {
    requestId,
    legacy: false,
    actionHandlers: {
      'fetch-thread-by-subject': async (request) => ({
        responseResult: {
          subject: request.subject,
          messageCount: 1,
          conversationId: 'conv-hill-rd'
        },
        threadDetail: {
          subject: request.subject,
          messageCount: 1,
          conversationId: 'conv-hill-rd',
          messages: []
        }
      })
    }
  });

  const response = JSON.parse(fs.readFileSync(helpers.actionResponsePathForRequest(requestId), 'utf8'));
  assert.equal(response.success, true);
  assert.equal(response.action, 'fetch-thread-by-subject');
  assert.equal(response.result.subject, 'Re: Prestigio Quote: Hill Rd / Pillow Request — $2,035');
});

test('createReplyDraft uses reply-all semantics and preserves provider recipients', async () => {
  const calls = [];
  const result = await helpers.createReplyDraftWithDeps(
    'message-123',
    'Hi all,\n\nFollowing up.',
    ['stacey@clementsdesign.com'],
    {
      callGraph: async (endpoint, method, body) => {
        calls.push({ endpoint, method: method || 'GET', body });
        if (endpoint.includes('/messages/message-123?')) {
          return {
            id: 'message-123',
            subject: 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table',
            from: graphRecipient('madison@clementsdesign.com', 'Madison Williams'),
            replyTo: [],
            toRecipients: [graphRecipient('chris@prestigiocustom.com', 'Chris Reyes')],
            ccRecipients: [graphRecipient('stephanie@clementsdesign.com', 'Stephanie')]
          };
        }
        if (endpoint.endsWith('/messages/message-123/createReplyAll')) {
          return {
            id: 'draft-123',
            toRecipients: [graphRecipient('madison@clementsdesign.com', 'Madison Williams')],
            ccRecipients: [graphRecipient('stephanie@clementsdesign.com', 'Stephanie')]
          };
        }
        if (endpoint.endsWith('/messages/draft-123') && method === 'PATCH') {
          return {
            id: 'draft-123',
            subject: 'RE: Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table',
            conversationId: 'conversation-123',
            toRecipients: [graphRecipient('madison@clementsdesign.com', 'Madison Williams')],
            ccRecipients: [
              graphRecipient('stephanie@clementsdesign.com', 'Stephanie'),
              graphRecipient('stacey@clementsdesign.com', 'Stacey')
            ]
          };
        }
        throw new Error('Unexpected Graph call: ' + endpoint);
      }
    }
  );

  assert.equal(calls[1].endpoint.endsWith('/createReplyAll'), true);
  assert.equal(calls.some((call) => call.endpoint.endsWith('/createReply')), false);
  assert.deepEqual(
    calls[2].body.ccRecipients.map((recipient) => recipient.emailAddress.address),
    ['stephanie@clementsdesign.com', 'stacey@clementsdesign.com']
  );
  assert.deepEqual(
    result.toRecipients.map((recipient) => recipient.emailAddress.address),
    ['madison@clementsdesign.com']
  );
  assert.deepEqual(
    result.ccRecipients.map((recipient) => recipient.emailAddress.address),
    ['stephanie@clementsdesign.com', 'stacey@clementsdesign.com']
  );
  assert.equal(result.__openclawReplyRecipientGuard, undefined);
});

test('createReplyDraft writes supplied HTML as rendered HTML instead of escaped tags', async () => {
  const calls = [];
  await helpers.createReplyDraftWithDeps(
    'message-html',
    'Hi team\n\nFallback text',
    [],
    {
      callGraph: async (endpoint, method, body) => {
        calls.push({ endpoint, method: method || 'GET', body });
        if (endpoint.includes('/messages/message-html?')) {
          return {
            id: 'message-html',
            from: graphRecipient('client@example.com', 'Client'),
            replyTo: [],
            toRecipients: [graphRecipient('chris@prestigiocustom.com', 'Chris')],
            ccRecipients: []
          };
        }
        if (endpoint.endsWith('/messages/message-html/createReplyAll')) {
          return {
            id: 'draft-html',
            toRecipients: [graphRecipient('client@example.com', 'Client')],
            ccRecipients: []
          };
        }
        if (endpoint.endsWith('/messages/draft-html') && method === 'PATCH') {
          return { id: 'draft-html', toRecipients: [graphRecipient('client@example.com', 'Client')] };
        }
        throw new Error('Unexpected Graph call: ' + endpoint);
      }
    },
    {
      bodyText: 'Hi team\n\nFallback text',
      bodyHtml: '<p>Hi team</p><p><strong>Fallback text</strong></p><script>alert(1)</script>'
    }
  );

  const patchedBody = calls[2].body.body.content;
  assert.equal(calls[2].body.body.contentType, 'HTML');
  assert.match(patchedBody, /<p>Hi team<\/p>/);
  assert.match(patchedBody, /<strong>Fallback text<\/strong>/);
  assert.doesNotMatch(patchedBody, /&lt;p&gt;|&lt;strong&gt;|<script/i);
});

test('plain text with angle-bracket tags remains escaped in Microsoft HTML wrapper', () => {
  const html = helpers.resolveDraftBodyHtml({
    body: 'Please write <p> literally, not as markup.'
  });

  assert.match(html, /&lt;p&gt; literally/);
  assert.doesNotMatch(html, /<p> literally/);
});

test('downloadMessageAttachments saves allowed files under sanitized message folder', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-attachments-'));
  const calls = [];
  const result = await helpers.downloadMessageAttachments('message/../123', {
    outputDir,
    callGraph: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.includes('/attachments?$select=')) {
        return {
          value: [
            {
              id: 'att-1',
              name: '../Hill Rd Schedule.pdf',
              contentType: 'application/pdf',
              size: 11,
              isInline: false
            },
            {
              id: 'att-2',
              name: 'tracking.html',
              contentType: 'text/html',
              size: 20,
              isInline: false
            }
          ]
        };
      }
      if (endpoint.endsWith('/attachments/att-1')) {
        return {
          '@odata.type': '#microsoft.graph.fileAttachment',
          contentBytes: Buffer.from('hello world').toString('base64')
        };
      }
      if (endpoint.includes('/messages/message%2F..%2F123?$select=body')) {
        return {
          body: {
            content: ''
          }
        };
      }
      throw new Error('Unexpected Graph call: ' + endpoint);
    }
  });

  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].name, 'Hill Rd Schedule.pdf');
  assert.equal(result.attachments[0].size, 11);
  assert.equal(result.attachments[0].sha256.length, 64);
  assert.equal(fs.readFileSync(result.attachments[0].path, 'utf8'), 'hello world');
  assert.equal(path.relative(outputDir, result.attachments[0].path).startsWith('..'), false);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'unsupported_content_type');
  assert.equal(calls.some((endpoint) => endpoint.includes('/../')), false);
});

test('downloadMessageAttachments saves inline image attachments and data URI images', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-inline-attachments-'));
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
  const inlineJpeg = Buffer.from('inline jpeg bytes');
  const result = await helpers.downloadMessageAttachments('inline-message', {
    outputDir,
    callGraph: async (endpoint) => {
      if (endpoint.includes('/attachments?$select=')) {
        return {
          value: [
            {
              id: 'inline-1',
              name: 'sofa-photo.jpg',
              contentType: 'image/jpeg',
              size: inlineJpeg.length,
              isInline: true,
              contentId: 'photo-1'
            }
          ]
        };
      }
      if (endpoint.endsWith('/attachments/inline-1')) {
        return {
          '@odata.type': '#microsoft.graph.fileAttachment',
          contentBytes: inlineJpeg.toString('base64')
        };
      }
      if (endpoint.includes('/messages/inline-message?$select=body')) {
        return {
          body: {
            content: '<html><body><img src="data:image/png;base64,' + tinyPng.toString('base64') + '"></body></html>'
          }
        };
      }
      throw new Error('Unexpected Graph call: ' + endpoint);
    }
  });

  assert.equal(result.attachments.length, 2);
  assert.equal(result.attachments[0].name, 'sofa-photo.jpg');
  assert.equal(result.attachments[0].isInline, true);
  assert.equal(result.attachments[0].contentId, 'photo-1');
  assert.equal(result.attachments[0].source, 'inline_attachment');
  assert.equal(result.attachments[1].name, 'inline-image-1.png');
  assert.equal(result.attachments[1].isInline, true);
  assert.equal(result.attachments[1].source, 'body_data_uri');
  assert.equal(fs.existsSync(result.attachments[0].path), true);
  assert.equal(fs.existsSync(result.attachments[1].path), true);
});

test('sanitizeFileName prevents path traversal names', () => {
  assert.equal(helpers.sanitizeFileName('../../secret.pdf'), 'secret.pdf');
  assert.equal(helpers.sanitizeFileName('quote:<bad>?.pdf'), 'quote_bad_.pdf');
  assert.equal(helpers.sanitizeFileName(''), 'attachment');
});

test('exact ottoman subject beats nearby sofa thread candidates', function() {
  const hints = helpers.buildThreadResolverHints(
    'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table',
    {}
  );
  const selection = helpers.selectThreadCandidate({
    sofaThread: [
      threadMessage('m1', 'sofaThread', 'Quote Request - Long Valley Living / Loggia / Sofa', '2026-03-20T15:00:00.000Z', 'Sofa quote details')
    ],
    ottomanThread: [
      threadMessage('m2', 'ottomanThread', 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table', '2026-03-21T15:00:00.000Z', 'Ottoman coffee table quote details')
    ]
  }, hints, 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table');

  assert.equal(selection.status, 'selected');
  assert.equal(selection.candidate.conversationId, 'ottomanThread');
  assert.match(selection.candidate.latestSubject, /Ottoman Coffee Table/i);
});

test('exact sofa subject still selects the sofa thread', function() {
  const hints = helpers.buildThreadResolverHints(
    'Quote Request - Long Valley Living / Loggia / Sofa',
    {}
  );
  const selection = helpers.selectThreadCandidate({
    sofaThread: [
      threadMessage('m3', 'sofaThread', 'Quote Request - Long Valley Living / Loggia / Sofa', '2026-03-21T15:00:00.000Z', 'Sofa quote details')
    ],
    ottomanThread: [
      threadMessage('m4', 'ottomanThread', 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table', '2026-03-20T15:00:00.000Z', 'Ottoman quote details')
    ]
  }, hints, 'Quote Request - Long Valley Living / Loggia / Sofa');

  assert.equal(selection.status, 'selected');
  assert.equal(selection.candidate.conversationId, 'sofaThread');
  assert.match(selection.candidate.latestSubject, /Sofa/i);
});

test('generic Long Valley task context uses ottoman discriminator instead of silently opening sofa', function() {
  const hints = helpers.buildThreadResolverHints(
    'Quote Request - Long Valley Living / Loggia',
    {
      sourceTaskText: 'QUOTE: Clements Design (Madison Williams) — Long Valley Living ottoman coffee table',
      requiredTokens: ['ottoman'],
      preferredPhrases: ['ottoman coffee table']
    }
  );
  const selection = helpers.selectThreadCandidate({
    sofaThread: [
      threadMessage('m5', 'sofaThread', 'Quote Request - Long Valley Living / Loggia / Sofa', '2026-03-22T15:00:00.000Z', 'Sofa quote details')
    ],
    ottomanThread: [
      threadMessage('m6', 'ottomanThread', 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table', '2026-03-21T15:00:00.000Z', 'Ottoman coffee table quote details')
    ]
  }, hints, 'Quote Request - Long Valley Living / Loggia');

  assert.equal(selection.status, 'selected');
  assert.equal(selection.candidate.conversationId, 'ottomanThread');
});

test('generic Long Valley prefix without a discriminator fails safe as ambiguous', function() {
  const hints = helpers.buildThreadResolverHints(
    'Quote Request - Long Valley Living / Loggia',
    {}
  );
  const selection = helpers.selectThreadCandidate({
    sofaThread: [
      threadMessage('m7', 'sofaThread', 'Quote Request - Long Valley Living / Loggia / Sofa', '2026-03-22T15:00:00.000Z', 'Sofa quote details')
    ],
    ottomanThread: [
      threadMessage('m8', 'ottomanThread', 'Quote Request - Long Valley Living / Loggia / Ottoman Coffee Table', '2026-03-21T15:00:00.000Z', 'Ottoman coffee table quote details')
    ]
  }, hints, 'Quote Request - Long Valley Living / Loggia');

  assert.equal(selection.status, 'ambiguous');
  assert.match(selection.message, /two likely threads/i);
});

test('normalizeGraphThreadMessages keeps candidate messages usable for subject-fetch fallback', function() {
  const messages = helpers.normalizeGraphThreadMessages([
    threadMessage(
      'newer',
      'conv-holly',
      'Re: Prestigio Quote: Personal / Outdoor Furniture — $14,870',
      '2026-04-10T15:28:07Z',
      'Latest Holly follow-up asking about turnaround.'
    ),
    threadMessage(
      'older',
      'conv-holly',
      'Prestigio Quote: Personal / Outdoor Furniture — $14,870',
      '2026-03-02T23:53:00Z',
      'Original quote send.'
    )
  ]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 'older');
  assert.equal(messages[1].id, 'newer');
  assert.match(messages[1].body, /turnaround/i);
});
