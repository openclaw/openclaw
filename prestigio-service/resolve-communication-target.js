const INTERNAL_DOMAINS = ['prestigiocustom.com'];
const INTERNAL_EMAILS = [
  'chris91744@gmail.com'
];
const GENERIC_TARGET_WORDS = [
  'team',
  'designer',
  'designers',
  'client',
  'clients',
  'vendor',
  'vendors',
  'group',
  'crew'
];

function buildAliasCandidates(search) {
  const raw = String(search || '').trim();
  if (!raw) return [];

  const normalized = raw
    .replace(/[|/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stripped = normalized
    .split(' ')
    .filter((part) => GENERIC_TARGET_WORDS.indexOf(part.toLowerCase()) === -1)
    .join(' ')
    .trim();

  const compact = stripped.replace(/[^a-zA-Z0-9]/g, '');
  const aliases = [raw, normalized, stripped].filter(Boolean);

  if (compact && compact !== stripped) {
    aliases.push(compact);
  }

  const lettersDigits = compact.match(/^([a-zA-Z]+)(\d+)$/);
  if (lettersDigits) {
    aliases.push(`${lettersDigits[1]} ${lettersDigits[2]}`);
    aliases.push(`${lettersDigits[1]}-${lettersDigits[2]}`);
  }

  const spacedLettersDigits = stripped.match(/^([a-zA-Z]+)\s+(\d+)$/);
  if (spacedLettersDigits) {
    aliases.push(`${spacedLettersDigits[1]}${spacedLettersDigits[2]}`);
  }

  return uniq(
    aliases
      .map((value) => value.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  );
}

async function resolveCommunicationTarget(search, deps) {
  if (!search) {
    throw new Error('search param required');
  }

  const aliasesTried = buildAliasCandidates(search);
  const entity = await resolveEntity(aliasesTried, deps);
  const projectSearchTerms = uniq(
    [entity.matchedProject, entity.matchedClient, ...aliasesTried].filter(Boolean)
  );

  const appContactResult = await findProjectContacts(projectSearchTerms, deps.projectContacts);
  if (appContactResult.recipients.length > 0) {
    const matchedProject = entity.matchedProject
      || appContactResult.matchedProject
      || appContactResult.recipients[0]?.project_name
      || appContactResult.matchedTerm
      || null;
    return {
      search,
      matched_project: matchedProject,
      matched_item: entity.matchedItem,
      matched_contact: appContactResult.recipients[0],
      recipients: appContactResult.recipients,
      found_in: 'project_contacts',
      provider: 'prestigio_app',
      aliases_tried: aliasesTried,
      confidence: matchedProject ? 0.96 : 0.9,
      entity_resolved_via: entity.resolvedVia,
      project_contacts_query: appContactResult.matchedTerm || matchedProject,
      matched_thread_subjects: [],
      matched_recipients: appContactResult.recipients.map((recipient) => recipient.email)
    };
  }

  const historySearchTerms = uniq(
    [entity.matchedProject, entity.matchedItem, entity.matchedClient, ...aliasesTried].filter(Boolean)
  );
  const history = await findMailboxRecipients({
    search,
    aliases: historySearchTerms,
    matchedProject: entity.matchedProject,
    matchedItem: entity.matchedItem,
    matchedClient: entity.matchedClient
  }, deps.mailboxSearchers || []);
  if (history.recipients.length > 0) {
    return {
      search,
      matched_project: entity.matchedProject || history.projectHint || null,
      matched_item: entity.matchedItem,
      matched_contact: history.recipients[0],
      recipients: history.recipients,
      found_in: history.found_in || 'mailbox_history',
      provider: history.provider || null,
      aliases_tried: aliasesTried,
      confidence: history.confidence,
      entity_resolved_via: entity.resolvedVia,
      history_hits: history.hits,
      history_candidates: history.candidates || [],
      history_winner_reason: history.winner_reason || null,
      matched_thread_subjects: history.matched_thread_subjects || [],
      matched_recipients: history.matched_recipients || [],
      mailbox: history.mailbox || null
    };
  }

  return {
    search,
    matched_project: entity.matchedProject,
    matched_item: entity.matchedItem,
    matched_contact: null,
    recipients: [],
    found_in: 'none',
    provider: null,
    aliases_tried: aliasesTried,
    confidence: entity.matchedProject || entity.matchedItem ? 0.32 : 0.08,
    entity_resolved_via: entity.resolvedVia,
    matched_thread_subjects: [],
    matched_recipients: []
  };
}

async function resolveEntity(aliases, deps) {
  for (const alias of aliases) {
    const itemResult = await deps.itemLookup(alias, 'write');
    const items = extractRows(itemResult);
    if (items.length > 0) {
      const first = items[0];
      return {
        matchedProject: first.project || null,
        matchedItem: first.sidemark || first.item_name || null,
        matchedClient: first.client || null,
        resolvedVia: 'item_lookup'
      };
    }
  }

  for (const alias of aliases) {
    const projectResult = await deps.projectOverview(alias, 'write');
    const project = extractProjectOverview(projectResult);
    if (project) {
      return {
        matchedProject: project.summary?.project_name || project.items?.[0]?.project || alias,
        matchedItem: project.items?.[0]?.sidemark || null,
        matchedClient: project.summary?.client_name || project.items?.[0]?.client || null,
        resolvedVia: 'project_overview'
      };
    }
  }

  for (const alias of aliases) {
    const clientResult = await deps.clientItems(alias, 'write');
    const items = extractRows(clientResult);
    if (items.length > 0) {
      const first = items[0];
      return {
        matchedProject: first.project || null,
        matchedItem: first.sidemark || first.item_name || null,
        matchedClient: first.client || alias,
        resolvedVia: 'client_items'
      };
    }
  }

  return {
    matchedProject: null,
    matchedItem: null,
    matchedClient: null,
    resolvedVia: 'none'
  };
}

async function findProjectContacts(terms, queryFn) {
  for (const term of terms) {
    const result = await queryFn(term, 'full');
    const rows = extractRows(result);
    for (const row of rows) {
      const recipients = normalizeDesignerContacts(row);
      if (recipients.length > 0) {
        return {
          recipients,
          matchedProject: row.project_name || null,
          matchedTerm: term
        };
      }
    }
  }
  return {
    recipients: [],
    matchedProject: null,
    matchedTerm: null
  };
}

async function findMailboxRecipients(context, mailboxSearchers) {
  const providerResults = [];

  for (const searchMailbox of mailboxSearchers) {
    if (searchMailbox.searchKind === 'contextual') {
      const contextualResult = await searchMailbox(context);
      const normalizedContextual = normalizeStructuredMailboxResult(searchMailbox, contextualResult);
      if (normalizedContextual && normalizedContextual.recipients.length > 0) {
        providerResults.push(normalizedContextual);
      }
      continue;
    }

    const accumulator = {
      provider: searchMailbox.provider || 'microsoft',
      mailbox: searchMailbox.label || null,
      hits: [],
      recipientMap: new Map(),
      matchedThreadSubjects: [],
      aliasesTried: [],
      bestLastSeen: null
    };

    for (const alias of context.aliases || []) {
      const thread = await searchMailbox(alias);
      if (!thread || !Array.isArray(thread.messages) || thread.messages.length === 0) {
        continue;
      }

      const recipients = extractRecipientsFromThread(thread, searchMailbox.label, accumulator.provider);
      if (recipients.length === 0) {
        continue;
      }

      accumulator.hits.push({
        mailbox: searchMailbox.label,
        provider: accumulator.provider,
        alias,
        subject: thread.subject || null,
        conversation_id: thread.conversationId || null,
        count: recipients.length
      });
      accumulator.matchedThreadSubjects = uniq(accumulator.matchedThreadSubjects.concat(thread.subject || []));
      accumulator.aliasesTried = uniq(accumulator.aliasesTried.concat(alias));

      recipients.forEach((recipient) => {
        const key = recipient.email.toLowerCase();
        const current = accumulator.recipientMap.get(key);
        if (!current) {
          accumulator.recipientMap.set(key, recipient);
          accumulator.bestLastSeen = laterTimestamp(accumulator.bestLastSeen, recipient.last_seen);
          return;
        }

        current.score += recipient.score;
        current.last_seen = laterTimestamp(current.last_seen, recipient.last_seen);
        current.found_in = 'mailbox_history';
        current.mailboxes = uniq((current.mailboxes || []).concat(recipient.mailboxes || []));
        current.providers = uniq((current.providers || []).concat(recipient.providers || []));
        accumulator.bestLastSeen = laterTimestamp(accumulator.bestLastSeen, current.last_seen);
      });
    }

    if (accumulator.recipientMap.size > 0) {
      providerResults.push(finalizeLegacyMailboxAccumulator(accumulator));
    }
  }

  providerResults.sort((a, b) => compareMailboxResults(a, b));
  if (providerResults.length === 0) {
    return {
      hits: [],
      projectHint: context.matchedProject || context.aliases?.[0] || null,
      recipients: [],
      provider: null,
      mailbox: null,
      found_in: 'mailbox_history',
      confidence: 0,
      matched_thread_subjects: [],
      matched_recipients: [],
      candidates: [],
      winner_reason: null
    };
  }

  const winner = providerResults[0];
  const runnerUp = providerResults[1] || null;

  return {
    hits: providerResults.flatMap((result) => result.hits || []),
    projectHint: context.matchedProject || winner.projectHint || context.aliases?.[0] || null,
    recipients: winner.recipients,
    provider: winner.provider,
    mailbox: winner.mailbox,
    found_in: winner.found_in || 'mailbox_history',
    confidence: winner.confidence,
    matched_thread_subjects: winner.matched_thread_subjects || [],
    matched_recipients: winner.matched_recipients || [],
    candidates: providerResults.map((result) => ({
      provider: result.provider,
      mailbox: result.mailbox,
      confidence: result.confidence,
      matched_thread_subjects: result.matched_thread_subjects,
      matched_recipients: result.matched_recipients,
      hit_count: Array.isArray(result.hits) ? result.hits.length : 0
    })),
    winner_reason: winner.winner_reason || buildWinnerReason(winner, runnerUp)
  };
}

function finalizeLegacyMailboxAccumulator(accumulator) {
  const recipients = Array.from(accumulator.recipientMap.values())
    .sort((a, b) => compareRecipients(a, b))
    .map((recipient) => ({
      name: recipient.name,
      email: recipient.email,
      found_in: 'mailbox_history',
      provider: accumulator.provider,
      mailbox: recipient.mailboxes?.[0] || accumulator.mailbox || null,
      last_seen: recipient.last_seen
    }));

  return {
    provider: accumulator.provider,
    mailbox: accumulator.mailbox,
    found_in: 'mailbox_history',
    projectHint: accumulator.aliasesTried[0] || null,
    recipients,
    confidence: computeMailboxConfidence(
      recipients.length,
      accumulator.hits.length,
      accumulator.bestLastSeen,
      accumulator.aliasesTried.length
    ),
    aliases_tried: accumulator.aliasesTried,
    matched_thread_subjects: accumulator.matchedThreadSubjects.filter(Boolean),
    matched_recipients: recipients.map((recipient) => recipient.email),
    hits: accumulator.hits,
    winner_reason: null
  };
}

function normalizeStructuredMailboxResult(searchMailbox, result) {
  if (!result || !Array.isArray(result.recipients) || result.recipients.length === 0) {
    return null;
  }

  return {
    provider: result.provider || searchMailbox.provider || null,
    mailbox: result.mailbox || searchMailbox.label || null,
    found_in: result.found_in || 'mailbox_history',
    projectHint: result.projectHint || result.search || null,
    recipients: result.recipients.map((recipient) => ({
      name: recipient.name || null,
      email: recipient.email,
      found_in: 'mailbox_history',
      provider: result.provider || searchMailbox.provider || null,
      mailbox: recipient.mailbox || result.mailbox || searchMailbox.label || null,
      last_seen: recipient.last_seen || null
    })),
    confidence: typeof result.confidence === 'number'
      ? result.confidence
      : computeMailboxConfidence(result.recipients.length, 0, result.last_seen || null, (result.aliases_tried || []).length),
    aliases_tried: Array.isArray(result.aliases_tried) ? result.aliases_tried : [],
    matched_thread_subjects: Array.isArray(result.matched_thread_subjects) ? result.matched_thread_subjects : [],
    matched_recipients: Array.isArray(result.matched_recipients)
      ? result.matched_recipients
      : result.recipients.map((recipient) => recipient.email),
    hits: Array.isArray(result.hits) ? result.hits : [],
    winner_reason: result.winner_reason || null
  };
}

function computeMailboxConfidence(recipientCount, hitCount, lastSeen, aliasCount) {
  let confidence = 0.52;
  confidence += Math.min(0.16, recipientCount * 0.04);
  confidence += Math.min(0.12, hitCount * 0.04);
  confidence += Math.min(0.08, aliasCount * 0.02);

  if (lastSeen) {
    const daysAgo = (Date.now() - new Date(lastSeen).getTime()) / (24 * 60 * 60 * 1000);
    if (daysAgo <= 30) confidence += 0.12;
    else if (daysAgo <= 90) confidence += 0.08;
    else if (daysAgo <= 365) confidence += 0.04;
  }

  return Math.max(0.2, Math.min(0.92, Number(confidence.toFixed(2))));
}

function compareMailboxResults(a, b) {
  if ((b.confidence || 0) !== (a.confidence || 0)) {
    return (b.confidence || 0) - (a.confidence || 0);
  }
  if ((b.recipients?.length || 0) !== (a.recipients?.length || 0)) {
    return (b.recipients?.length || 0) - (a.recipients?.length || 0);
  }
  return new Date(b.recipients?.[0]?.last_seen || 0).getTime() - new Date(a.recipients?.[0]?.last_seen || 0).getTime();
}

function buildWinnerReason(winner, runnerUp) {
  const parts = [];
  if (runnerUp && winner.provider !== runnerUp.provider) {
    parts.push(`${winner.provider} outranked ${runnerUp.provider}`);
  }
  if (winner.matched_thread_subjects?.[0]) {
    parts.push(`matched "${winner.matched_thread_subjects[0]}"`);
  }
  if (winner.recipients?.[0]?.email) {
    parts.push(`top recipient ${winner.recipients[0].email}`);
  }
  return parts.join('; ');
}

function extractRecipientsFromThread(thread, mailboxLabel, provider) {
  const messages = Array.isArray(thread.messages) ? thread.messages.slice() : [];
  const scored = new Map();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const isLatest = index === messages.length - 1;
    const isRecent = index >= messages.length - 2;
    const fields = []
      .concat(message.from || [])
      .concat(message.to || [])
      .concat(message.cc || []);

    fields
      .flatMap((value) => splitContacts(value))
      .filter((contact) => contact.email && !isInternalEmail(contact.email))
      .forEach((contact) => {
        const key = contact.email.toLowerCase();
        const current = scored.get(key) || {
          name: contact.name,
          email: contact.email,
          score: 0,
          last_seen: message.date || null,
          mailboxes: [],
          providers: []
        };

        current.name = current.name || contact.name || null;
        current.score += isLatest ? 4 : isRecent ? 2 : 1;
        current.last_seen = laterTimestamp(current.last_seen, message.date || null);
        current.mailboxes = uniq(current.mailboxes.concat(mailboxLabel));
        current.providers = uniq(current.providers.concat(provider || 'microsoft'));
        scored.set(key, current);
      });
  }

  return Array.from(scored.values()).sort((a, b) => compareRecipients(a, b));
}

function normalizeDesignerContacts(row) {
  const designers = Array.isArray(row.designers) ? row.designers : [];
  return designers
    .filter((designer) => designer && designer.email)
    .map((designer) => ({
      name: designer.name || null,
      email: designer.email,
      found_in: 'project_contacts',
      project_name: row.project_name || null
    }));
}

function splitContacts(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitContacts(entry));
  }

  const text = String(value || '').trim();
  if (!text) return [];

  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseContact)
    .filter((contact) => contact.email);
}

function parseContact(value) {
  const match = String(value || '').match(/^(.*?)(?:<([^>]+)>)?$/);
  if (!match) {
    return { name: null, email: null };
  }

  const name = match[2] ? match[1].trim().replace(/^"|"$/g, '') : null;
  const email = (match[2] || match[1] || '').trim().toLowerCase();
  return {
    name: name || null,
    email: email.includes('@') ? email : null
  };
}

function isInternalEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return true;
  if (INTERNAL_EMAILS.indexOf(normalized) !== -1) return true;
  return INTERNAL_DOMAINS.some((domain) => normalized.endsWith(`@${domain}`));
}

function extractRows(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (result.__queryResult) return extractRows(result.data);
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.results)) return result.results;
  if (Array.isArray(result.items)) return result.items;
  if (typeof result === 'object') return [result];
  return [];
}

function extractProjectOverview(result) {
  if (!result) return null;
  if (result.__queryResult) return extractProjectOverview(result.data);
  if (result.summary || (Array.isArray(result.items) && result.items.length > 0)) return result;
  if (result.results && (result.results.summary || (Array.isArray(result.results.items) && result.results.items.length > 0))) {
    return result.results;
  }
  return null;
}

function laterTimestamp(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function compareRecipients(a, b) {
  if ((b.score || 0) !== (a.score || 0)) {
    return (b.score || 0) - (a.score || 0);
  }
  return new Date(b.last_seen || 0).getTime() - new Date(a.last_seen || 0).getTime();
}

function uniq(values) {
  return Array.from(new Set(values));
}

module.exports = {
  buildAliasCandidates,
  resolveCommunicationTarget,
  extractRecipientsFromThread,
  splitContacts,
  isInternalEmail
};
