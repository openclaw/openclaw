const fs = require('fs');
const path = require('path');

const CHANNELS = ['instagram', 'site', 'outreach'];

function normalizeIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function compact(values) {
  return (Array.isArray(values) ? values : []).filter(Boolean);
}

function defaultChannelState(channel) {
  return {
    channel,
    status: 'pending',
    actor: null,
    reason: null,
    edits: null,
    created_at: null,
    request_id: null
  };
}

function defaultCandidateState(candidateId) {
  const channels = {};
  for (const channel of CHANNELS) {
    channels[channel] = defaultChannelState(channel);
  }
  return {
    candidate_id: candidateId,
    reviewed: false,
    review_status: 'pending_review',
    queue_visible: true,
    rejected: false,
    rejected_at: null,
    rejected_reason: null,
    snoozed_until: null,
    snoozed_active: false,
    channels,
    approved_channels: [],
    rejected_channels: [],
    pending_channels: CHANNELS.slice(),
    latest_action: null,
    latest_action_at: null,
    latest_actor: null,
    action_count: 0
  };
}

function readApprovalActions(approvalsDir) {
  if (!fs.existsSync(approvalsDir)) return [];
  const actions = [];
  for (const name of fs.readdirSync(approvalsDir).filter(fileName => fileName.endsWith('.json')).sort()) {
    const filePath = path.join(approvalsDir, name);
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const action = normalizeApprovalAction(payload, {
        requestId: path.basename(name, '.json'),
        createdAt: new Date(fs.statSync(filePath).mtimeMs).toISOString()
      });
      if (action) actions.push(action);
    } catch (_) {
      // ignore unreadable action files so one bad action does not break the queue
    }
  }
  actions.sort((left, right) => {
    if (left.created_at !== right.created_at) {
      return String(left.created_at).localeCompare(String(right.created_at));
    }
    return String(left.request_id).localeCompare(String(right.request_id));
  });
  return actions;
}

function normalizeApprovalAction(payload, fallback) {
  if (!payload || typeof payload !== 'object') return null;
  const candidateId = String(payload.candidate_id || '').trim();
  if (!candidateId) return null;
  const action = String(payload.action || '').trim().toLowerCase();
  if (!action) return null;
  const channel = payload.channel && CHANNELS.includes(String(payload.channel)) ? String(payload.channel) : null;
  return {
    request_id: String(payload.requestId || payload.request_id || fallback.requestId || '').trim() || null,
    candidate_id: candidateId,
    actor: String(payload.actor || 'chris').trim() || 'chris',
    action,
    channel,
    edits: payload.edits && typeof payload.edits === 'object' ? payload.edits : null,
    reason: payload.reason ? String(payload.reason) : null,
    snooze_until: normalizeIso(payload.snooze_until),
    created_at: normalizeIso(payload.created_at) || fallback.createdAt
  };
}

function deriveReviewState(candidateState, nowIso) {
  const approvedChannels = [];
  const rejectedChannels = [];
  const pendingChannels = [];
  for (const channel of CHANNELS) {
    const status = candidateState.channels[channel]?.status || 'pending';
    if (status === 'approved') approvedChannels.push(channel);
    else if (status === 'rejected') rejectedChannels.push(channel);
    else pendingChannels.push(channel);
  }

  const snoozedActive = Boolean(candidateState.snoozed_until && candidateState.snoozed_until > nowIso);
  let reviewStatus = 'pending_review';
  if (candidateState.rejected) reviewStatus = 'rejected';
  else if (snoozedActive) reviewStatus = 'snoozed';
  else if (approvedChannels.length === CHANNELS.length) reviewStatus = 'approved_all';
  else if (candidateState.action_count > 0 || rejectedChannels.length > 0 || approvedChannels.length > 0) reviewStatus = 'reviewed';

  return Object.assign(candidateState, {
    reviewed: candidateState.action_count > 0,
    review_status: reviewStatus,
    queue_visible: !candidateState.rejected && !snoozedActive,
    snoozed_active: snoozedActive,
    approved_channels: approvedChannels,
    rejected_channels: rejectedChannels,
    pending_channels: pendingChannels
  });
}

function reduceApprovalActions(actions, existingCandidateIds, nowIso) {
  const stateByCandidate = new Map();
  for (const candidateId of compact(existingCandidateIds)) {
    stateByCandidate.set(candidateId, defaultCandidateState(candidateId));
  }

  for (const action of actions) {
    const current = stateByCandidate.get(action.candidate_id) || defaultCandidateState(action.candidate_id);
    current.action_count += 1;
    current.latest_action = {
      action: action.action,
      channel: action.channel,
      actor: action.actor,
      reason: action.reason,
      request_id: action.request_id,
      created_at: action.created_at
    };
    current.latest_action_at = action.created_at;
    current.latest_actor = action.actor;

    if (action.action === 'approve' && action.channel) {
      current.channels[action.channel] = {
        channel: action.channel,
        status: 'approved',
        actor: action.actor,
        reason: action.reason,
        edits: action.edits,
        created_at: action.created_at,
        request_id: action.request_id
      };
    }

    if (action.action === 'reject') {
      if (action.channel) {
        current.channels[action.channel] = {
          channel: action.channel,
          status: 'rejected',
          actor: action.actor,
          reason: action.reason,
          edits: action.edits,
          created_at: action.created_at,
          request_id: action.request_id
        };
      } else {
        current.rejected = true;
        current.rejected_at = action.created_at;
        current.rejected_reason = action.reason;
      }
    }

    if (action.action === 'snooze') {
      current.snoozed_until = action.snooze_until;
    }

    if (action.action === 'reopen') {
      current.rejected = false;
      current.rejected_at = null;
      current.rejected_reason = null;
      current.snoozed_until = null;
    }

    stateByCandidate.set(action.candidate_id, current);
  }

  const result = {};
  for (const [candidateId, candidateState] of stateByCandidate.entries()) {
    result[candidateId] = deriveReviewState(candidateState, nowIso);
  }
  return result;
}

function buildReviewStatePayload(options) {
  const actions = Array.isArray(options?.actions) ? options.actions : [];
  const candidates = Array.isArray(options?.candidates) ? options.candidates : [];
  const nowIso = options?.nowIso || new Date().toISOString();
  const candidateIds = candidates.map(candidate => candidate.candidate_id);
  const reduced = reduceApprovalActions(actions, candidateIds, nowIso);
  return {
    service: 'marketing-overlay-service',
    review_state_version: 1,
    updated_at: nowIso,
    action_count: actions.length,
    candidate_count: candidateIds.length,
    candidates: reduced
  };
}

function derivePrivacyFlags(candidate) {
  return compact(candidate?.redactions_applied).filter(flag => [
    'client_name_removed',
    'location_removed',
    'internal_notes_excluded'
  ].includes(flag));
}

function applyReviewStateToCandidate(candidate, reviewStatePayload, nowIso) {
  const payload = reviewStatePayload && typeof reviewStatePayload === 'object'
    ? reviewStatePayload
    : { candidates: {} };
  const state = payload.candidates?.[candidate.candidate_id] || deriveReviewState(defaultCandidateState(candidate.candidate_id), nowIso);
  const approvals = Object.assign({}, candidate.approvals || {});
  for (const channel of CHANNELS) {
    approvals[channel] = state.channels[channel]?.status || 'pending';
  }
  return Object.assign({}, candidate, {
    approvals,
    review: Object.assign({}, state, {
      privacy_flags: derivePrivacyFlags(candidate)
    })
  });
}

function queueSortValue(candidate) {
  const reviewStatus = candidate.review?.review_status || 'pending_review';
  return reviewStatus === 'pending_review' ? 0 : 1;
}

function blockerCount(candidate) {
  return Array.isArray(candidate.publish_blockers) ? candidate.publish_blockers.length : 0;
}

function completionAnchor(candidate) {
  return candidate?.evidence?.completion_anchor_at || candidate?.trace?.generated_at || '';
}

function sortCandidatesForQueue(candidates) {
  return candidates.slice().sort((left, right) => {
    const reviewRankDiff = queueSortValue(left) - queueSortValue(right);
    if (reviewRankDiff !== 0) return reviewRankDiff;

    const blockerDiff = blockerCount(left) - blockerCount(right);
    if (blockerDiff !== 0) return blockerDiff;

    if ((left.quality_score || 0) !== (right.quality_score || 0)) {
      return (right.quality_score || 0) - (left.quality_score || 0);
    }

    const anchorDiff = String(completionAnchor(right)).localeCompare(String(completionAnchor(left)));
    if (anchorDiff !== 0) return anchorDiff;

    return String(left.candidate_id).localeCompare(String(right.candidate_id));
  });
}

module.exports = {
  CHANNELS,
  readApprovalActions,
  buildReviewStatePayload,
  applyReviewStateToCandidate,
  sortCandidatesForQueue
};
