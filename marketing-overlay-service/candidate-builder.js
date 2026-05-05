const crypto = require('crypto');
const { rankCompletionPhotos, computeQualityScore } = require('./photo-ranking');
const { sanitizePublicText, collectDefaultRedactions } = require('./redaction');

const QUALIFYING_STATUSES = new Set(['work_complete', 'ready for pick up', 'collected']);

function defaultOverrides() {
  return {
    exclude_projects: [],
    exclude_clients: [],
    exclude_order_items: [],
    exclude_categories: []
  };
}

function normalizeOverrides(overrides) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  const defaults = defaultOverrides();
  return {
    exclude_projects: normalizeStringList(source.exclude_projects || defaults.exclude_projects),
    exclude_clients: normalizeStringList(source.exclude_clients || defaults.exclude_clients),
    exclude_order_items: normalizeStringList(source.exclude_order_items || defaults.exclude_order_items),
    exclude_categories: normalizeStringList(source.exclude_categories || defaults.exclude_categories)
  };
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

function compact(values) {
  return (Array.isArray(values) ? values : []).filter(Boolean);
}

function unique(values) {
  return [...new Set(compact(values))];
}

function listToSentence(values) {
  if (!Array.isArray(values) || values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function formatDimension(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

function completionAnchorForItem(item) {
  return item.delivered_at || item.completed_at || item.work_completed_at || item.updated_at || item.created_at || null;
}

function deriveProject(item) {
  return item.po?.projects || item.quote?.projects || null;
}

function deriveProjectId(item) {
  return item.po?.project_id || item.quote?.project_id || deriveProject(item)?.id || null;
}

function deriveProjectName(item) {
  return deriveProject(item)?.name || item.project_name || null;
}

function deriveClient(item) {
  return deriveProject(item)?.clients || null;
}

function deriveClientName(item) {
  const client = deriveClient(item);
  return client?.company || client?.name || item.design_firm_name || null;
}

function deriveClientId(item) {
  return deriveClient(item)?.id || null;
}

function deriveLegacyDesignerContacts(item) {
  const project = deriveProject(item);
  return compact(project?.collaborating_designers).map(email => ({
    name: null,
    email,
    source: 'legacy_array'
  }));
}

function mergeDesignerContacts(normalizedContacts, legacyContacts) {
  const map = new Map();
  for (const contact of [...compact(normalizedContacts), ...compact(legacyContacts)]) {
    if (!contact?.email) continue;
    map.set(contact.email.toLowerCase(), {
      name: contact.name || null,
      email: contact.email,
      source: contact.source || null
    });
  }
  return Array.from(map.values());
}

function extractMaterials(item, specs) {
  const values = [];
  for (const spec of compact(specs)) {
    values.push(spec.fill_material, spec.insert_type, spec.core_type, spec.wrap_material);
  }
  const textDescription = normalizeText(firstPresent(item.quoting_description, item.description, ''));
  const lower = textDescription.toLowerCase();
  if (lower.includes('boucle')) values.push('boucle');
  if (lower.includes('linen')) values.push('linen');
  if (lower.includes('velvet')) values.push('velvet');
  if (lower.includes('down')) values.push('down');
  if (lower.includes('foam')) values.push('foam');
  return unique(values.map(normalizeText).filter(Boolean)).slice(0, 6);
}

function extractDimensions(item) {
  const labels = [];
  const width = formatDimension(item.width);
  const depth = formatDimension(item.depth);
  const height = formatDimension(item.height);
  const diameter = formatDimension(item.diameter);
  const seatHeight = formatDimension(item.seat_height);
  const insideWidth = formatDimension(item.inside_width);
  const insideDepth = formatDimension(item.inside_depth);

  if (width || depth || height) {
    labels.push([width, depth, height].filter(Boolean).join(' x '));
  }
  if (diameter) labels.push(`diameter ${diameter}`);
  if (seatHeight) labels.push(`seat height ${seatHeight}`);
  if (insideWidth || insideDepth) {
    labels.push(`inside ${[insideWidth, insideDepth].filter(Boolean).join(' x ')}`);
  }
  return unique(labels);
}

function buildItemTitle(item) {
  return normalizeText(firstPresent(item.item_name, item.sidemark, item.category, 'custom piece'));
}

function buildPublicItemPhrase(item) {
  const title = buildItemTitle(item).toLowerCase();
  if (!title) return 'custom piece';
  return title.startsWith('custom ') ? title : `custom ${title}`;
}

function buildPublicHeading(item) {
  const title = buildItemTitle(item);
  return title || 'Custom Piece';
}

function computeSourceSignature(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function normalizeMatchKey(value) {
  return slugify(value || '');
}

function isExcludedByOverrides(item, overrides) {
  const projectId = deriveProjectId(item);
  const projectName = deriveProjectName(item);
  const clientId = deriveClientId(item);
  const clientName = deriveClientName(item);
  const category = item.category;
  const orderItemId = item.id;

  const checks = [
    {
      bucket: overrides.exclude_projects,
      keys: [projectId, projectName]
    },
    {
      bucket: overrides.exclude_clients,
      keys: [clientId, clientName]
    },
    {
      bucket: overrides.exclude_order_items,
      keys: [orderItemId, item.sidemark, item.item_name]
    },
    {
      bucket: overrides.exclude_categories,
      keys: [category]
    }
  ];

  for (const check of checks) {
    const bucket = new Set(check.bucket.map(normalizeMatchKey));
    for (const key of check.keys) {
      if (key && bucket.has(normalizeMatchKey(key))) {
        return true;
      }
    }
  }
  return false;
}

function evaluateEligibility(item, overrides) {
  const reasons = [];
  const disqualifiers = [];
  const photos = Array.isArray(item.completion_photos) ? item.completion_photos.filter(Boolean) : [];

  if (QUALIFYING_STATUSES.has(item.status)) reasons.push('completed_state_detected');
  else disqualifiers.push('non_publishable_status');

  if (photos.length > 0) reasons.push('photos_present');
  else disqualifiers.push('missing_completion_photos');

  if (item.status === 'canceled') disqualifiers.push('canceled');
  if (item.on_hold === true) disqualifiers.push('on_hold');
  if (isExcludedByOverrides(item, overrides)) disqualifiers.push('excluded_by_override');

  return {
    eligible: disqualifiers.length === 0,
    reasons,
    disqualifiers,
    photoCount: photos.length
  };
}

function buildSafeNarrative(item, redactionContext) {
  const raw = normalizeText(firstPresent(item.quoting_description, item.description, ''));
  if (!raw) return { text: '', redactions: [] };
  const sanitized = sanitizePublicText(raw, redactionContext);
  return {
    text: sanitized.text,
    redactions: sanitized.redactions_applied
  };
}

function buildCaption(item, materials, dimensions, safeNarrative, redactionContext) {
  const category = normalizeText(item.category || 'custom piece').toLowerCase();
  const room = normalizeText(item.room || '').toLowerCase();
  const opener = `A recent ${category} completed for a private client project${room ? ` in a ${room} setting` : ''}.`;
  const materialsSentence = materials.length > 0 ? ` Built with ${listToSentence(materials.slice(0, 3))}.` : '';
  const dimensionsSentence = dimensions.length > 0 ? ` Scaled at ${dimensions[0]}.` : '';
  const detailSentence = safeNarrative ? ` ${safeNarrative}` : '';
  return sanitizePublicText(`${opener}${detailSentence}${materialsSentence}${dimensionsSentence}`, redactionContext);
}

function buildAltText(item, materials, redactionContext) {
  const title = buildPublicItemPhrase(item);
  const room = normalizeText(item.room || '').toLowerCase();
  const materialFragment = materials.length > 0 ? ` with ${listToSentence(materials.slice(0, 2))}` : '';
  return sanitizePublicText(
    `Completion photo of a ${title}${room ? ` in a ${room}` : ''}${materialFragment}.`,
    redactionContext
  );
}

function buildCaseStudy(item, materials, dimensions, safeNarrative, redactionContext) {
  const lines = [
    `# ${buildPublicHeading(item)}`,
    '',
    'A recent private-client completion from the Prestigio workroom. This draft remains in shadow mode pending human review.',
    '',
    '## What Was Built',
    `- Category: ${normalizeText(item.category || 'unknown')}`,
    item.room ? `- Room: ${normalizeText(item.room)}` : null,
    materials.length > 0 ? `- Materials: ${listToSentence(materials)}` : null,
    dimensions.length > 0 ? `- Dimensions: ${listToSentence(dimensions)}` : null,
    '',
    '## Draft Story',
    safeNarrative || 'A custom piece completed for a private project, held for review before any public sharing.'
  ].filter(Boolean);
  return sanitizePublicText(lines.join('\n'), redactionContext);
}

function buildOutreachSnippet(item, safeNarrative, redactionContext) {
  const title = buildPublicItemPhrase(item);
  const firstSentence = `We recently completed a ${title} for a private client project and thought the finish, silhouette, and workmanship might be relevant to similar design work.`;
  const followUp = safeNarrative
    ? ` ${safeNarrative}`
    : ' Happy to share images and production notes if it would be helpful.';
  return sanitizePublicText(`${firstSentence}${followUp}`, redactionContext);
}

function buildPublishBlockers(item, eligibility, qualityScore) {
  const blockers = ['pending_human_review'];
  if (!deriveProjectName(item)) blockers.push('missing_project_context');
  if (!firstPresent(item.description, item.quoting_description)) blockers.push('minimal_narrative_context');
  if (eligibility.photoCount < 3) blockers.push('limited_photo_set');
  if (qualityScore < 45) blockers.push('low_quality_score');
  return unique(blockers);
}

function buildRedactionContext(item) {
  return {
    clientName: deriveClientName(item),
    projectName: deriveProjectName(item)
  };
}

function buildCandidatePacket(item, specsByItem, contactsByProject, buildRequest) {
  const specs = specsByItem[item.id] || [];
  const projectId = deriveProjectId(item);
  const projectName = deriveProjectName(item);
  const clientId = deriveClientId(item);
  const clientName = deriveClientName(item);
  const designerContacts = mergeDesignerContacts(
    projectId ? contactsByProject[projectId] : [],
    deriveLegacyDesignerContacts(item)
  );
  const materials = extractMaterials(item, specs);
  const dimensions = extractDimensions(item);
  const photoSelection = rankCompletionPhotos(item.completion_photos || []);
  const redactionContext = buildRedactionContext(item);
  const safeNarrative = buildSafeNarrative(item, redactionContext);
  const caption = buildCaption(item, materials, dimensions, safeNarrative.text, redactionContext);
  const altText = buildAltText(item, materials, redactionContext);
  const caseStudy = buildCaseStudy(item, materials, dimensions, safeNarrative.text, redactionContext);
  const outreach = buildOutreachSnippet(item, safeNarrative.text, redactionContext);
  const redactionsApplied = unique([
    ...collectDefaultRedactions(item),
    ...safeNarrative.redactions,
    ...caption.redactions_applied,
    ...altText.redactions_applied,
    ...caseStudy.redactions_applied,
    ...outreach.redactions_applied
  ]);
  const completionAnchor = completionAnchorForItem(item);
  const qualityScore = computeQualityScore({
    photoCount: photoSelection.photoCount,
    heroImage: photoSelection.heroImage,
    descriptionPresent: Boolean(firstPresent(item.description, item.quoting_description)),
    materialCount: materials.length,
    dimensionCount: dimensions.length,
    roomPresent: Boolean(item.room),
    specCount: specs.length,
    contactCount: designerContacts.length,
    projectNamePresent: Boolean(projectName)
  });

  const signaturePayload = {
    item_id: item.id,
    status: item.status,
    completion_photos: compact(item.completion_photos),
    description: normalizeText(item.description),
    quoting_description: normalizeText(item.quoting_description),
    category: normalizeText(item.category),
    room: normalizeText(item.room),
    work_completed_at: item.work_completed_at || null,
    completed_at: item.completed_at || null,
    delivered_at: item.delivered_at || null,
    updated_at: item.updated_at || null,
    specs: specs.map(spec => ({
      spec_type: spec.spec_type || null,
      cushion_type: spec.cushion_type || null,
      insert_type: spec.insert_type || null,
      fill_material: spec.fill_material || null
    }))
  };

  return {
    candidate_id: `cand_${item.id}`,
    status: 'shadow',
    quality_score: qualityScore,
    publish_blockers: buildPublishBlockers(item, { photoCount: photoSelection.photoCount }, qualityScore),
    redactions_applied: redactionsApplied,
    grouping_basis: {
      type: 'single_order_item',
      order_item_count: 1,
      rationale: 'Phase 1 keeps each candidate aligned to a single qualifying order item to avoid inventing new project-completion truth.'
    },
    source: {
      order_item_ids: [item.id],
      project_id: projectId,
      project_name: projectName,
      client_id: clientId,
      client_name: clientName,
      designer_contacts: designerContacts,
      truth_sources: [
        'order_items',
        'item_specs',
        'projects',
        'clients',
        'project_designers',
        'projects.collaborating_designers'
      ]
    },
    eligibility: {
      has_completion_photos: photoSelection.photoCount > 0,
      photo_count: photoSelection.photoCount,
      qualifying_status: item.status,
      public_ready: 'pending_human_review',
      reasons: [
        'completed_state_detected',
        'photos_present'
      ]
    },
    assets: {
      hero_image: photoSelection.heroImage,
      carousel_order: photoSelection.carouselOrder,
      caption_draft: caption.text,
      alt_text: altText.text,
      case_study_md: caseStudy.text,
      outreach_snippet: outreach.text
    },
    evidence: {
      item_title: buildItemTitle(item),
      item_description: normalizeText(firstPresent(item.quoting_description, item.description, '')),
      category: normalizeText(item.category),
      room: normalizeText(item.room),
      materials,
      dimensions,
      completion_anchor_at: completionAnchor,
      photo_urls: compact(item.completion_photos),
      source_fields_used: compact([
        firstPresent(item.quoting_description, item.description) ? 'description' : null,
        item.category ? 'category' : null,
        item.room ? 'room' : null,
        dimensions.length > 0 ? 'dimensions' : null,
        specs.length > 0 ? 'item_specs' : null
      ])
    },
    approvals: {
      instagram: 'pending',
      site: 'pending',
      outreach: 'pending'
    },
    trace: {
      generated_at: buildRequest.startedAt,
      request_id: buildRequest.requestId,
      build_mode: buildRequest.mode,
      service: 'marketing-overlay-service@phase1',
      source_signature: computeSourceSignature(signaturePayload)
    }
  };
}

function sortCandidates(candidates) {
  return candidates.slice().sort((left, right) => {
    const leftAnchor = firstPresent(left.evidence?.completion_anchor_at, left.trace?.generated_at, '');
    const rightAnchor = firstPresent(right.evidence?.completion_anchor_at, right.trace?.generated_at, '');
    if (leftAnchor !== rightAnchor) {
      return String(rightAnchor).localeCompare(String(leftAnchor));
    }
    if (left.quality_score !== right.quality_score) {
      return right.quality_score - left.quality_score;
    }
    return String(left.candidate_id).localeCompare(String(right.candidate_id));
  });
}

function buildCandidatePackets(options) {
  const items = Array.isArray(options?.items) ? options.items : [];
  const specsByItem = options?.specsByItem || {};
  const contactsByProject = options?.contactsByProject || {};
  const overrides = normalizeOverrides(options?.overrides);
  const buildRequest = options?.buildRequest || {
    requestId: `marketing-build-${Date.now()}`,
    mode: 'backfill',
    startedAt: new Date().toISOString()
  };

  const candidates = [];
  const skippedReasons = {};

  for (const item of items) {
    const eligibility = evaluateEligibility(item, overrides);
    if (!eligibility.eligible) {
      for (const reason of eligibility.disqualifiers) {
        skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
      }
      continue;
    }
    candidates.push(buildCandidatePacket(item, specsByItem, contactsByProject, buildRequest));
  }

  return {
    candidates: sortCandidates(candidates),
    stats: {
      processed_items: items.length,
      candidate_items: candidates.length,
      skipped_items: items.length - candidates.length,
      skipped_reasons: skippedReasons
    }
  };
}

function buildSummaryPayload(candidates, meta) {
  const sorted = Array.isArray(meta?.queueSortedCandidates)
    ? meta.queueSortedCandidates
    : sortCandidates(candidates);
  const queueItems = sorted.filter(candidate => candidate.review?.queue_visible !== false);
  const snoozedCount = sorted.filter(candidate => candidate.review?.review_status === 'snoozed').length;
  const rejectedCount = sorted.filter(candidate => candidate.review?.review_status === 'rejected').length;
  const pendingReviewCount = queueItems.filter(candidate => candidate.review?.review_status === 'pending_review').length;
  const reviewedCount = queueItems.length - pendingReviewCount;
  return {
    service: 'marketing-overlay-service',
    generated_at: meta.generatedAt || new Date().toISOString(),
    review_state_updated_at: meta.reviewStateUpdatedAt || null,
    request_id: meta.requestId || null,
    mode: meta.mode || 'backfill',
    days: meta.days || null,
    source_since: meta.sourceSince || null,
    candidate_count: sorted.length,
    pending_human_review_count: sorted.length,
    queue: {
      visible_count: queueItems.length,
      pending_review_count: pendingReviewCount,
      reviewed_count: reviewedCount,
      snoozed_count: snoozedCount,
      rejected_count: rejectedCount,
      items: queueItems.map(candidate => ({
        candidate_id: candidate.candidate_id,
        review_status: candidate.review?.review_status || 'pending_review',
        quality_score: candidate.quality_score,
        project_name: candidate.source.project_name,
        client_name: candidate.source.client_name,
        order_item_id: candidate.source.order_item_ids[0] || null,
        item_title: candidate.evidence.item_title,
        category: candidate.evidence.category,
        room: candidate.evidence.room,
        publish_blockers: candidate.publish_blockers,
        blocker_count: Array.isArray(candidate.publish_blockers) ? candidate.publish_blockers.length : 0,
        privacy_flags: candidate.review?.privacy_flags || [],
        completion_anchor_at: candidate.evidence.completion_anchor_at,
        detail_file: `by-id/${candidate.candidate_id}.json`
      }))
    },
    stats: meta.stats || null,
    candidates: sorted.map(candidate => ({
      candidate_id: candidate.candidate_id,
      status: candidate.status,
      review_status: candidate.review?.review_status || 'pending_review',
      queue_visible: candidate.review?.queue_visible !== false,
      quality_score: candidate.quality_score,
      project_id: candidate.source.project_id,
      project_name: candidate.source.project_name,
      client_name: candidate.source.client_name,
      order_item_id: candidate.source.order_item_ids[0] || null,
      item_title: candidate.evidence.item_title,
      category: candidate.evidence.category,
      room: candidate.evidence.room,
      public_ready: candidate.eligibility.public_ready,
      publish_blockers: candidate.publish_blockers,
      redactions_applied: candidate.redactions_applied,
      privacy_flags: candidate.review?.privacy_flags || [],
      completion_anchor_at: candidate.evidence.completion_anchor_at,
      hero_image_url: candidate.assets.hero_image?.url || null,
      detail_file: `by-id/${candidate.candidate_id}.json`
    }))
  };
}

module.exports = {
  buildCandidatePackets,
  buildSummaryPayload,
  defaultOverrides,
  normalizeOverrides
};
