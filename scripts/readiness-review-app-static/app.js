const LABEL_FIELDS = [
  'proposal_yes_no',
  'proposal_type',
  'matched_project',
  'matched_item',
  'suggested_update',
  'safe_to_auto_write_later',
  'notes'
];

const TYPE_SHORTCUTS = {
  '1': 'drawing_approval',
  '2': 'drawing_revision',
  '3': 'client_spec_answer',
  '4': 'fabric_problem',
  '5': 'fabric_status',
  '6': 'frame_status',
  '7': 'client_item_status',
  '8': 'none'
};

const storageKeys = {
  rowId: 'readinessReview.lastRowId',
  filterMode: 'readinessReview.filterMode',
  typeFilter: 'readinessReview.typeFilter'
};

const state = {
  rows: [],
  stats: { total: 0, labeled: 0, unlabeled: 0 },
  filterMode: localStorage.getItem(storageKeys.filterMode) || 'unlabeled',
  typeFilter: localStorage.getItem(storageKeys.typeFilter) || 'all',
  currentRowId: localStorage.getItem(storageKeys.rowId) || null,
  dirty: false,
  saving: false,
  saveMessage: 'Not saved',
  backupCreated: null,
  rubric: ''
};

const elements = {
  filterMode: document.getElementById('filterMode'),
  typeFilter: document.getElementById('typeFilter'),
  jumpToRow: document.getElementById('jumpToRow'),
  jumpButton: document.getElementById('jumpButton'),
  statusLine: document.getElementById('statusLine'),
  currentPosition: document.getElementById('currentPosition'),
  progressSummary: document.getElementById('progressSummary'),
  progressFill: document.getElementById('progressFill'),
  savePill: document.getElementById('savePill'),
  backupPill: document.getElementById('backupPill'),
  currentFilterLabel: document.getElementById('currentFilterLabel'),
  subject: document.getElementById('subject'),
  mailbox: document.getElementById('mailbox'),
  latestTimestamp: document.getElementById('latestTimestamp'),
  guessedType: document.getElementById('guessedType'),
  confidence: document.getElementById('confidence'),
  keywords: document.getElementById('keywords'),
  participants: document.getElementById('participants'),
  shortExcerpt: document.getElementById('shortExcerpt'),
  cleanLatestText: document.getElementById('cleanLatestText'),
  cleanThreadExcerpt: document.getElementById('cleanThreadExcerpt'),
  proposalYesNo: document.getElementById('proposalYesNo'),
  proposalType: document.getElementById('proposalType'),
  matchedProject: document.getElementById('matchedProject'),
  matchedItem: document.getElementById('matchedItem'),
  suggestedUpdate: document.getElementById('suggestedUpdate'),
  safeToAutoWriteLater: document.getElementById('safeToAutoWriteLater'),
  notes: document.getElementById('notes'),
  previousButton: document.getElementById('previousButton'),
  nextButton: document.getElementById('nextButton'),
  nextUnlabeledButton: document.getElementById('nextUnlabeledButton'),
  skipButton: document.getElementById('skipButton'),
  saveButton: document.getElementById('saveButton'),
  clearLabelsButton: document.getElementById('clearLabelsButton'),
  copyEvidenceButton: document.getElementById('copyEvidenceButton'),
  rubricText: document.getElementById('rubricText')
};

boot().catch((error) => {
  elements.statusLine.textContent = `Failed to load review data: ${error.message}`;
  markSaveState('Error', 'dirty');
});

async function boot() {
  wireEvents();
  await reloadData();
}

function wireEvents() {
  elements.filterMode.value = state.filterMode;
  elements.filterMode.addEventListener('change', async () => {
    const nextMode = elements.filterMode.value;
    const saved = await saveCurrent({ preserveRow: true });
    if (!saved) {
      elements.filterMode.value = state.filterMode;
      return;
    }

    state.filterMode = nextMode;
    localStorage.setItem(storageKeys.filterMode, state.filterMode);
    if (state.filterMode === 'unlabeled' && getFilteredRows().length === 0) {
      state.currentRowId = null;
    }
    render();
  });

  elements.typeFilter.addEventListener('change', async () => {
    const nextType = elements.typeFilter.value;
    const saved = await saveCurrent({ preserveRow: true });
    if (!saved) {
      elements.typeFilter.value = state.typeFilter;
      return;
    }

    state.typeFilter = nextType;
    localStorage.setItem(storageKeys.typeFilter, state.typeFilter);
    render();
  });

  elements.jumpButton.addEventListener('click', () => jumpToPriority());
  elements.jumpToRow.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpToPriority();
    }
  });

  elements.previousButton.addEventListener('click', () => navigateRelative(-1));
  elements.nextButton.addEventListener('click', () => navigateRelative(1));
  elements.skipButton.addEventListener('click', () => navigateRelative(1));
  elements.nextUnlabeledButton.addEventListener('click', () => navigateToNextUnlabeled());
  elements.saveButton.addEventListener('click', () => saveCurrent({ preserveRow: false }));
  elements.clearLabelsButton.addEventListener('click', () => clearCurrentLabels());
  elements.copyEvidenceButton.addEventListener('click', () => copyEvidence());

  for (const field of ['proposalYesNo', 'proposalType', 'matchedProject', 'matchedItem', 'suggestedUpdate', 'safeToAutoWriteLater', 'notes']) {
    elements[field].addEventListener('input', handleFieldChange);
    elements[field].addEventListener('change', handleFieldChange);
  }

  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

async function reloadData() {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) {
    throw new Error(`Bootstrap failed with ${response.status}`);
  }

  const payload = await response.json();
  state.rows = payload.rows || [];
  state.stats = payload.stats || { total: state.rows.length, labeled: 0, unlabeled: 0 };
  state.rubric = payload.rubric || '';
  state.backupCreated = payload.backupCreated || null;
  elements.rubricText.textContent = state.rubric;

  populateTypeFilter();
  resolveStartingRow();
  render();
}

function populateTypeFilter() {
  const current = elements.typeFilter.value || state.typeFilter;
  const guesses = uniq(state.rows.map((row) => row.candidate_event_type_guess).filter(Boolean)).sort();
  elements.typeFilter.innerHTML = '<option value="all">All guessed types</option>';
  for (const guess of guesses) {
    const option = document.createElement('option');
    option.value = guess;
    option.textContent = guess;
    elements.typeFilter.appendChild(option);
  }

  if (guesses.includes(state.typeFilter)) {
    elements.typeFilter.value = state.typeFilter;
  } else {
    state.typeFilter = 'all';
    elements.typeFilter.value = 'all';
  }

  if (guesses.includes(current)) {
    elements.typeFilter.value = current;
    state.typeFilter = current;
  }
}

function resolveStartingRow() {
  const filtered = getFilteredRows();
  if (filtered.length === 0) {
    state.currentRowId = null;
    return;
  }

  if (state.currentRowId && filtered.some((row) => row.review_priority === state.currentRowId)) {
    return;
  }

  state.currentRowId = filtered[0].review_priority;
  persistCurrentRow();
}

function getFilteredRows() {
  let rows = state.rows.slice();

  if (state.filterMode === 'unlabeled') {
    rows = rows.filter((row) => !isLabeled(row) || row.review_priority === state.currentRowId);
  }

  if (state.typeFilter !== 'all') {
    rows = rows.filter((row) => row.candidate_event_type_guess === state.typeFilter);
  }

  return rows;
}

function getCurrentRow(filteredRows = getFilteredRows()) {
  if (filteredRows.length === 0) return null;
  const existing = filteredRows.find((row) => row.review_priority === state.currentRowId);
  if (existing) return existing;
  state.currentRowId = filteredRows[0].review_priority;
  persistCurrentRow();
  return filteredRows[0];
}

function render() {
  const filteredRows = getFilteredRows();
  const currentRow = getCurrentRow(filteredRows);

  elements.filterMode.value = state.filterMode;
  elements.typeFilter.value = state.typeFilter;

  const currentIndex = currentRow
    ? filteredRows.findIndex((row) => row.review_priority === currentRow.review_priority) + 1
    : 0;

  elements.currentPosition.textContent = `${currentIndex} / ${filteredRows.length}`;
  elements.progressSummary.textContent = `${state.stats.labeled} labeled, ${state.stats.unlabeled} unlabeled`;
  elements.statusLine.textContent = filteredRows.length === 0
    ? 'No rows match the current filter.'
    : `${state.stats.total} total rows available for review.`;
  elements.currentFilterLabel.textContent = state.filterMode === 'unlabeled' ? 'Unlabeled only' : 'All rows';

  const progressPercent = state.stats.total === 0 ? 0 : Math.round((state.stats.labeled / state.stats.total) * 100);
  elements.progressFill.style.width = `${progressPercent}%`;

  if (state.backupCreated) {
    elements.backupPill.classList.remove('hidden');
    elements.backupPill.textContent = `Backup created: ${state.backupCreated}`;
  } else {
    elements.backupPill.classList.add('hidden');
    elements.backupPill.textContent = '';
  }

  if (!currentRow) {
    renderEmptyState();
    return;
  }

  elements.subject.textContent = currentRow.subject || '(no subject)';
  elements.mailbox.textContent = currentRow.mailbox || '';
  elements.latestTimestamp.textContent = formatTimestamp(currentRow.latest_timestamp);
  elements.guessedType.textContent = currentRow.candidate_event_type_guess || '(none)';
  elements.confidence.textContent = currentRow.confidence || '';
  elements.keywords.textContent = currentRow.readiness_keywords_matched || '(none)';
  elements.participants.textContent = currentRow.participants?.length
    ? currentRow.participants.join('\n')
    : '(none)';
  elements.shortExcerpt.textContent = currentRow.short_excerpt || '(none)';
  elements.cleanLatestText.textContent = currentRow.clean_latest_text || '(thread text unavailable)';
  elements.cleanThreadExcerpt.textContent = currentRow.clean_thread_excerpt || '(none)';

  elements.proposalYesNo.value = currentRow.proposal_yes_no || '';
  elements.proposalType.value = currentRow.proposal_type || '';
  elements.matchedProject.value = currentRow.matched_project || '';
  elements.matchedItem.value = currentRow.matched_item || '';
  elements.suggestedUpdate.value = currentRow.suggested_update || '';
  elements.safeToAutoWriteLater.value = currentRow.safe_to_auto_write_later || '';
  elements.notes.value = currentRow.notes || '';

  elements.previousButton.disabled = currentIndex <= 1;
  elements.nextButton.disabled = currentIndex === 0 || currentIndex >= filteredRows.length;
  elements.skipButton.disabled = currentIndex === 0 || currentIndex >= filteredRows.length;
  elements.saveButton.disabled = !state.dirty || state.saving;
}

function renderEmptyState() {
  elements.subject.textContent = 'No matching rows';
  elements.mailbox.textContent = '';
  elements.latestTimestamp.textContent = '';
  elements.guessedType.textContent = '';
  elements.confidence.textContent = '';
  elements.keywords.textContent = '';
  elements.participants.textContent = '';
  elements.shortExcerpt.textContent = 'Switch filters to continue reviewing.';
  elements.cleanLatestText.textContent = '';
  elements.cleanThreadExcerpt.textContent = '';

  elements.proposalYesNo.value = '';
  elements.proposalType.value = '';
  elements.matchedProject.value = '';
  elements.matchedItem.value = '';
  elements.suggestedUpdate.value = '';
  elements.safeToAutoWriteLater.value = '';
  elements.notes.value = '';

  elements.previousButton.disabled = true;
  elements.nextButton.disabled = true;
  elements.skipButton.disabled = true;
  elements.saveButton.disabled = true;
}

function handleFieldChange(event) {
  const currentRow = getCurrentRow();
  if (!currentRow) return;

  const fieldMap = {
    proposalYesNo: 'proposal_yes_no',
    proposalType: 'proposal_type',
    matchedProject: 'matched_project',
    matchedItem: 'matched_item',
    suggestedUpdate: 'suggested_update',
    safeToAutoWriteLater: 'safe_to_auto_write_later',
    notes: 'notes'
  };

  const field = fieldMap[event.target.id];
  if (!field) return;

  currentRow[field] = event.target.value;

  if (field === 'proposal_type') {
    if (event.target.value === 'none') {
      currentRow.proposal_yes_no = 'no';
      elements.proposalYesNo.value = 'no';
    } else if (event.target.value) {
      currentRow.proposal_yes_no = 'yes';
      elements.proposalYesNo.value = 'yes';
    }
  }

  markDirty();
}

async function saveCurrent(options = {}) {
  const currentRow = getCurrentRow();
  if (!currentRow || state.saving) return true;
  if (!state.dirty && !options.force) return true;

  state.saving = true;
  markSaveState('Saving...', 'dirty');

  try {
    const response = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        review_priority: currentRow.review_priority,
        labels: pickLabelFields(currentRow)
      })
    });

    if (!response.ok) {
      throw new Error(`Save failed with ${response.status}`);
    }

    const payload = await response.json();
    state.stats = payload.stats || state.stats;
    state.dirty = false;
    state.backupCreated = payload.backupCreated || state.backupCreated;
    markSaveState(`Saved ${formatSavedAt(payload.savedAt)}`, 'saved');

    render();
    return true;
  } catch (error) {
    markSaveState(`Save failed: ${error.message}`, 'dirty');
    return false;
  } finally {
    state.saving = false;
    render();
  }
}

function pickLabelFields(row) {
  const labels = {};
  for (const field of LABEL_FIELDS) {
    labels[field] = row[field] || '';
  }
  return labels;
}

function markDirty() {
  state.dirty = true;
  markSaveState('Unsaved changes', 'dirty');
  state.stats = buildStatsFromRows(state.rows);
  render();
}

function markSaveState(message, mode) {
  state.saveMessage = message;
  elements.savePill.textContent = message;
  elements.savePill.classList.remove('saved', 'dirty');
  if (mode) {
    elements.savePill.classList.add(mode);
  }
}

async function navigateRelative(delta) {
  const filteredRows = getFilteredRows();
  const currentRow = getCurrentRow(filteredRows);
  if (!currentRow) return;

  const currentIndex = filteredRows.findIndex((row) => row.review_priority === currentRow.review_priority);
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= filteredRows.length) return;

  const saved = await saveCurrent({ preserveRow: true });
  if (!saved) return;

  state.currentRowId = filteredRows[nextIndex].review_priority;
  persistCurrentRow();
  render();
}

async function navigateToNextUnlabeled() {
  const currentRow = getCurrentRow(getFilteredRows());
  if (!currentRow) return;

  const saved = await saveCurrent({ preserveRow: true });
  if (!saved) return;

  const next = findNextUnlabeledAfter(currentRow.review_priority);
  if (!next) return;

  state.currentRowId = next.review_priority;
  persistCurrentRow();
  render();
}

function findNextUnlabeledAfter(reviewPriority) {
  const rows = state.rows.slice().sort((a, b) => Number(a.review_priority) - Number(b.review_priority));
  const index = rows.findIndex((row) => row.review_priority === reviewPriority);
  for (let i = index + 1; i < rows.length; i += 1) {
    if (!isLabeled(rows[i])) return rows[i];
  }
  for (let i = 0; i < rows.length; i += 1) {
    if (!isLabeled(rows[i])) return rows[i];
  }
  return null;
}

function clearCurrentLabels() {
  const currentRow = getCurrentRow();
  if (!currentRow) return;
  for (const field of LABEL_FIELDS) {
    currentRow[field] = '';
  }
  render();
  markDirty();
}

async function jumpToPriority() {
  const reviewPriority = elements.jumpToRow.value.trim().padStart(3, '0');
  if (!reviewPriority) return;
  const saved = await saveCurrent({ preserveRow: true });
  if (!saved) return;
  const filteredRows = getFilteredRows();
  const match = filteredRows.find((row) => row.review_priority === reviewPriority)
    || state.rows.find((row) => row.review_priority === reviewPriority);
  if (!match) return;
  state.currentRowId = match.review_priority;
  persistCurrentRow();
  render();
}

async function copyEvidence() {
  const currentRow = getCurrentRow();
  if (!currentRow) return;
  const text = currentRow.clean_latest_text || currentRow.clean_thread_excerpt || '';
  if (!text) return;
  await navigator.clipboard.writeText(text);
  markSaveState('Evidence copied', state.dirty ? 'dirty' : 'saved');
}

function handleKeydown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTextEditingElement(document.activeElement)) return;

  if (event.key === 'y') {
    setProposalYesNo('yes');
    event.preventDefault();
  } else if (event.key === 'n') {
    setProposalYesNo('no');
    event.preventDefault();
  } else if (event.key === '0') {
    setProposalYesNo('');
    event.preventDefault();
  } else if (TYPE_SHORTCUTS[event.key]) {
    setProposalType(TYPE_SHORTCUTS[event.key]);
    event.preventDefault();
  } else if (event.key === '[') {
    setSafeWrite('yes');
    event.preventDefault();
  } else if (event.key === ']') {
    setSafeWrite('no');
    event.preventDefault();
  } else if (event.key === '-') {
    setSafeWrite('');
    event.preventDefault();
  } else if (event.key === 'j') {
    navigateRelative(1);
    event.preventDefault();
  } else if (event.key === 'k') {
    navigateRelative(-1);
    event.preventDefault();
  } else if (event.key === 'u') {
    navigateToNextUnlabeled();
    event.preventDefault();
  } else if (event.key === 's') {
    saveCurrent({ preserveRow: false });
    event.preventDefault();
  } else if (event.key === 'c') {
    clearCurrentLabels();
    event.preventDefault();
  }
}

function setProposalYesNo(value) {
  const currentRow = getCurrentRow();
  if (!currentRow) return;
  currentRow.proposal_yes_no = value;
  elements.proposalYesNo.value = value;
  markDirty();
}

function setProposalType(value) {
  const currentRow = getCurrentRow();
  if (!currentRow) return;
  currentRow.proposal_type = value;
  elements.proposalType.value = value;
  if (value === 'none') {
    currentRow.proposal_yes_no = 'no';
    elements.proposalYesNo.value = 'no';
  } else if (value) {
    currentRow.proposal_yes_no = 'yes';
    elements.proposalYesNo.value = 'yes';
  }
  markDirty();
}

function setSafeWrite(value) {
  const currentRow = getCurrentRow();
  if (!currentRow) return;
  currentRow.safe_to_auto_write_later = value;
  elements.safeToAutoWriteLater.value = value;
  markDirty();
}

function persistCurrentRow() {
  if (state.currentRowId) {
    localStorage.setItem(storageKeys.rowId, state.currentRowId);
  }
}

function buildStatsFromRows(rows) {
  const labeled = rows.filter(isLabeled).length;
  return {
    total: rows.length,
    labeled,
    unlabeled: rows.length - labeled
  };
}

function isLabeled(row) {
  return LABEL_FIELDS.some((field) => String(row[field] || '').trim() !== '');
}

function isTextEditingElement(element) {
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatSavedAt(value) {
  if (!value) return 'Saved';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saved';
  return `Saved ${date.toLocaleTimeString()}`;
}

function uniq(values) {
  return [...new Set(values)];
}
