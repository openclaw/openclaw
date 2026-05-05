const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAliasCandidates,
  resolveCommunicationTarget
} = require('./resolve-communication-target');

function qr(data, meta = {}) {
  return {
    __queryResult: true,
    data,
    meta
  };
}

function mailboxSearcher(label, threadsByAlias) {
  const searcher = async (alias) => threadsByAlias[alias] || null;
  searcher.label = label;
  searcher.provider = 'microsoft';
  return searcher;
}

function contextualMailboxSearcher(label, provider, handler) {
  const searcher = async (context) => handler(context);
  searcher.label = label;
  searcher.provider = provider;
  searcher.searchKind = 'contextual';
  return searcher;
}

function createDeps(overrides = {}) {
  return {
    itemLookup: async () => qr([]),
    projectOverview: async () => qr({ summary: null, items: [] }),
    clientItems: async () => qr([]),
    projectContacts: async () => qr([]),
    mailboxSearchers: [],
    ...overrides
  };
}

test('Addison Austin resolves through project overview into project contacts', async () => {
  const contact = { name: 'Addison Austin Studio', email: 'team@addisonaustin.com' };
  const result = await resolveCommunicationTarget('Addison Austin', createDeps({
    projectOverview: async (term) => (
      term === 'Addison Austin'
        ? qr({
            summary: { project_name: 'Addison Austin', client_name: 'Addison Austin' },
            items: [{ sidemark: 'Royere Sofa', project: 'Addison Austin', client: 'Addison Austin' }]
          })
        : qr({ summary: null, items: [] })
    ),
    projectContacts: async (term) => (
      term === 'Addison Austin'
        ? qr([{ project_name: 'Addison Austin', designers: [contact] }])
        : qr([])
    )
  }));

  assert.equal(result.found_in, 'project_contacts');
  assert.equal(result.provider, 'prestigio_app');
  assert.equal(result.matched_project, 'Addison Austin');
  assert.equal(result.matched_contact.email, contact.email);
  assert.equal(result.entity_resolved_via, 'project_overview');
  assert.equal(result.aliases_tried[0], 'Addison Austin');
  assert.ok(result.aliases_tried.includes('AddisonAustin'));
});

test('ESC 7 shorthand normalizes to ESC7 and resolves cleanly', async () => {
  const aliases = buildAliasCandidates('ESC 7 team');
  assert.deepEqual(aliases, ['ESC 7 team', 'ESC 7', 'ESC7', 'ESC-7']);

  const seenTerms = [];
  const result = await resolveCommunicationTarget('ESC 7 team', createDeps({
    projectContacts: async (term) => {
      seenTerms.push(term);
      return term === 'ESC7'
        ? qr([{ project_name: 'ESC 7', designers: [{ name: 'ESC 7 Team', email: 'ops@esc7.com' }] }])
        : qr([]);
    }
  }));

  assert.equal(result.found_in, 'project_contacts');
  assert.equal(result.provider, 'prestigio_app');
  assert.equal(result.matched_project, 'ESC 7');
  assert.equal(result.matched_contact.email, 'ops@esc7.com');
  assert.ok(seenTerms.includes('ESC7'));
});

test('item-linked project resolves to app contacts with matched item provenance', async () => {
  const result = await resolveCommunicationTarget('Royere Sofa', createDeps({
    itemLookup: async (term) => (
      term === 'Royere Sofa'
        ? qr([{ sidemark: 'Royere Sofa', project: 'Addison Austin', client: 'Addison Austin' }])
        : qr([])
    ),
    projectContacts: async (term) => (
      term === 'Addison Austin'
        ? qr([{
            project_name: 'Addison Austin',
            designers: [{ name: 'Addison Team', email: 'design@addisonaustin.com' }]
          }])
        : qr([])
    )
  }));

  assert.equal(result.found_in, 'project_contacts');
  assert.equal(result.provider, 'prestigio_app');
  assert.equal(result.matched_project, 'Addison Austin');
  assert.equal(result.matched_item, 'Royere Sofa');
  assert.equal(result.entity_resolved_via, 'item_lookup');
});

test('falls back to mailbox history when app contacts are empty', async () => {
  const result = await resolveCommunicationTarget('Harbor House', createDeps({
    projectOverview: async (term) => (
      term === 'Harbor House'
        ? qr({
            summary: { project_name: 'Harbor House', client_name: 'Harbor House' },
            items: [{ sidemark: 'Banquette', project: 'Harbor House', client: 'Harbor House' }]
          })
        : qr({ summary: null, items: [] })
    ),
    mailboxSearchers: [
      mailboxSearcher('chris@prestigiocustom.com', {
        'Harbor House': {
          conversationId: 'thread-1',
          subject: 'Re: Harbor House missing dimensions',
          messages: [
            {
              from: 'Chris <chris@prestigiocustom.com>',
              to: 'Harbor House Team <team@harborhouse.com>',
              cc: '',
              date: '2026-03-20T18:00:00.000Z'
            },
            {
              from: 'Harbor House Team <team@harborhouse.com>',
              to: 'Chris <chris@prestigiocustom.com>',
              cc: 'Designer <designer@harborhouse.com>',
              date: '2026-03-21T17:00:00.000Z'
            }
          ]
        }
      })
    ]
  }));

  assert.equal(result.found_in, 'mailbox_history');
  assert.equal(result.provider, 'microsoft');
  assert.equal(result.matched_project, 'Harbor House');
  assert.equal(result.recipients[0].email, 'team@harborhouse.com');
  assert.equal(result.recipients[1].email, 'designer@harborhouse.com');
  assert.equal(result.history_hits[0].mailbox, 'chris@prestigiocustom.com');
  assert.ok(result.matched_thread_subjects[0].includes('Harbor House'));
  assert.ok(result.matched_recipients.includes('team@harborhouse.com'));
});

test('uses Gmail mailbox history when Gmail produces the strongest candidate', async () => {
  const result = await resolveCommunicationTarget('ESC 7 team', createDeps({
    mailboxSearchers: [
      contextualMailboxSearcher('chris91744@gmail.com', 'gmail', async (context) => {
        assert.ok(context.aliases.includes('ESC7'));
        return {
          provider: 'gmail',
          mailbox: 'chris91744@gmail.com',
          found_in: 'mailbox_history',
          confidence: 0.84,
          aliases_tried: context.aliases,
          matched_thread_subjects: ['ESC 7 missing dimensions'],
          matched_recipients: ['ops@esc7.com', 'pm@esc7.com'],
          recipients: [
            { name: 'ESC 7 Ops', email: 'ops@esc7.com', last_seen: '2026-03-21T17:00:00.000Z' },
            { name: 'ESC 7 PM', email: 'pm@esc7.com', last_seen: '2026-03-20T17:00:00.000Z' }
          ],
          winner_reason: 'subject matched ESC 7 and recent external recipients repeated in the thread'
        };
      })
    ]
  }));

  assert.equal(result.found_in, 'mailbox_history');
  assert.equal(result.provider, 'gmail');
  assert.equal(result.recipients[0].email, 'ops@esc7.com');
  assert.ok(result.matched_thread_subjects.includes('ESC 7 missing dimensions'));
  assert.ok(result.matched_recipients.includes('pm@esc7.com'));
  assert.match(result.history_winner_reason, /subject matched ESC 7/i);
});

test('prefers the stronger provider result when Microsoft and Gmail both return candidates', async () => {
  const result = await resolveCommunicationTarget('Harbor House', createDeps({
    mailboxSearchers: [
      mailboxSearcher('chris@prestigiocustom.com', {
        'Harbor House': {
          conversationId: 'thread-1',
          subject: 'Harbor House request',
          messages: [
            {
              from: 'Chris <chris@prestigiocustom.com>',
              to: 'Old Team <old@harborhouse.com>',
              cc: '',
              date: '2025-01-01T10:00:00.000Z'
            }
          ]
        }
      }),
      contextualMailboxSearcher('chris91744@gmail.com', 'gmail', async () => ({
        provider: 'gmail',
        mailbox: 'chris91744@gmail.com',
        found_in: 'mailbox_history',
        confidence: 0.88,
        aliases_tried: ['Harbor House'],
        matched_thread_subjects: ['Harbor House missing dimensions'],
        matched_recipients: ['team@harborhouse.com'],
        recipients: [
          { name: 'Harbor House Team', email: 'team@harborhouse.com', last_seen: '2026-03-21T10:00:00.000Z' }
        ],
        winner_reason: 'gmail had the more recent and more relevant thread'
      }))
    ]
  }));

  assert.equal(result.provider, 'gmail');
  assert.equal(result.recipients[0].email, 'team@harborhouse.com');
  assert.equal(result.history_candidates.length, 2);
  assert.match(result.history_winner_reason, /gmail/i);
});

test('returns an explicit none result on total miss', async () => {
  const result = await resolveCommunicationTarget('No Such Team', createDeps());

  assert.equal(result.found_in, 'none');
  assert.equal(result.provider, null);
  assert.equal(result.matched_project, null);
  assert.equal(result.matched_contact, null);
  assert.deepEqual(result.recipients, []);
  assert.equal(result.entity_resolved_via, 'none');
});
