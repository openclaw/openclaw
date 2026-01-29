// ============================================
// CLARIFYING QUESTIONS MODULE
// ============================================
// Agent can ask questions while continuing to work
// Questions queue up for user to answer, agent proceeds with assumptions

const clarifyState = {
  questions: [], // { id, question, context, timestamp, answered, answer, assumptions }
  isOpen: false,
  autoAssume: true, // Agent makes assumptions and continues
  assumptionDelay: 10000, // 10 seconds before using assumption
};

/**
 * Initialize clarifying questions module
 */
function initClarifyingQuestions() {
  // Load settings
  const saved = localStorage.getItem('clarifyAutoAssume');
  if (saved !== null) {
    clarifyState.autoAssume = saved === 'true';
  }
  
  console.log('❓ Clarifying questions initialized');
}

/**
 * Handle incoming clarifying question from agent
 * @param {Object} msg - Message with question data
 */
function handleClarifyingQuestion(msg) {
  const question = {
    id: msg.questionId || `q-${Date.now()}`,
    question: msg.question,
    context: msg.context || null,
    options: msg.options || null, // Suggested answers
    assumption: msg.assumption || null, // What agent will assume if no answer
    timestamp: Date.now(),
    answered: false,
    answer: null,
  };
  
  clarifyState.questions.push(question);
  
  // Update badge
  updateQuestionBadge();
  
  // Show notification
  showNotification(`❓ Agent has a question`, 'info', {
    action: {
      label: 'Answer',
      onClick: () => openQuestionPanel()
    }
  });
  
  // Show inline question in agent panel
  showInlineQuestion(question);
  
  // Schedule auto-assumption if enabled
  if (clarifyState.autoAssume && question.assumption) {
    scheduleAutoAssumption(question);
  }
  
  return question.id;
}

/**
 * Show inline question in agent panel
 * @param {Object} question - Question object
 */
function showInlineQuestion(question) {
  const container = document.getElementById('agentStepDescription');
  if (!container) return;
  
  let optionsHTML = '';
  if (question.options && question.options.length > 0) {
    optionsHTML = `
      <div class="clarify-options">
        ${question.options.map((opt, i) => `
          <button class="clarify-option" onclick="answerQuestion('${question.id}', '${escapeHtml(opt)}')">
            ${escapeHtml(opt)}
          </button>
        `).join('')}
      </div>
    `;
  }
  
  let assumptionHTML = '';
  if (question.assumption && clarifyState.autoAssume) {
    assumptionHTML = `
      <div class="clarify-assumption">
        <span class="assumption-label">Will assume:</span>
        <span class="assumption-text">${escapeHtml(question.assumption)}</span>
        <span class="assumption-timer" id="assumption-timer-${question.id}">10s</span>
      </div>
    `;
  }
  
  container.innerHTML = `
    <div class="clarify-question-inline">
      <div class="clarify-icon">❓</div>
      <div class="clarify-content">
        <div class="clarify-text">${escapeHtml(question.question)}</div>
        ${question.context ? `<div class="clarify-context">${escapeHtml(question.context)}</div>` : ''}
        ${optionsHTML}
        <div class="clarify-input-row">
          <input type="text" id="clarify-input-${question.id}" 
                 placeholder="Type your answer..." 
                 onkeydown="if(event.key==='Enter') answerQuestion('${question.id}', this.value)">
          <button onclick="answerQuestion('${question.id}', document.getElementById('clarify-input-${question.id}').value)">
            Answer
          </button>
        </div>
        ${assumptionHTML}
      </div>
    </div>
  `;
}

/**
 * Schedule auto-assumption for a question
 * @param {Object} question - Question object
 */
function scheduleAutoAssumption(question) {
  let timeLeft = clarifyState.assumptionDelay / 1000;
  
  const timer = setInterval(() => {
    timeLeft--;
    
    const timerEl = document.getElementById(`assumption-timer-${question.id}`);
    if (timerEl) {
      timerEl.textContent = `${timeLeft}s`;
    }
    
    if (timeLeft <= 0 || question.answered) {
      clearInterval(timer);
      
      if (!question.answered) {
        useAssumption(question);
      }
    }
  }, 1000);
  
  question._timer = timer;
}

/**
 * Use the agent's assumption as the answer
 * @param {Object} question - Question object
 */
function useAssumption(question) {
  question.answered = true;
  question.answer = question.assumption;
  question.usedAssumption = true;
  
  // Notify agent to continue with assumption
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'agent:answer',
      taskId: state.agent?.taskId,
      questionId: question.id,
      answer: question.assumption,
      isAssumption: true
    }));
  }
  
  // Update UI
  showNotification(`ℹ️ Proceeding with: "${question.assumption}"`, 'info');
  updateQuestionBadge();
}

/**
 * Answer a clarifying question
 * @param {string} questionId - Question ID
 * @param {string} answer - User's answer
 */
function answerQuestion(questionId, answer) {
  if (!answer || !answer.trim()) {
    showNotification('Please provide an answer', 'warning');
    return;
  }
  
  const question = clarifyState.questions.find(q => q.id === questionId);
  if (!question) return;
  
  // Cancel auto-assumption timer
  if (question._timer) {
    clearInterval(question._timer);
  }
  
  question.answered = true;
  question.answer = answer.trim();
  
  // Send answer to agent
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'agent:answer',
      taskId: state.agent?.taskId,
      questionId: question.id,
      answer: question.answer,
      isAssumption: false
    }));
  }
  
  // Update UI
  showNotification('✓ Answer sent', 'success');
  updateQuestionBadge();
  
  // Clear inline question
  const container = document.getElementById('agentStepDescription');
  if (container) {
    container.innerHTML = `
      <div class="agent-thinking">
        <span class="thinking-dots">●●●</span>
        <span class="thinking-text">Continuing with your answer...</span>
      </div>
    `;
  }
}

/**
 * Open the question panel to see all pending questions
 */
function openQuestionPanel() {
  let panel = document.getElementById('clarifyPanel');
  
  if (!panel) {
    panel = createQuestionPanel();
    document.body.appendChild(panel);
  }
  
  renderQuestionList();
  panel.classList.remove('hidden');
  clarifyState.isOpen = true;
}

/**
 * Close question panel
 */
function closeQuestionPanel() {
  const panel = document.getElementById('clarifyPanel');
  if (panel) {
    panel.classList.add('hidden');
  }
  clarifyState.isOpen = false;
}

/**
 * Create question panel HTML
 */
function createQuestionPanel() {
  const panel = document.createElement('div');
  panel.id = 'clarifyPanel';
  panel.className = 'clarify-panel hidden';
  
  panel.innerHTML = `
    <div class="clarify-panel-overlay" onclick="closeQuestionPanel()"></div>
    <div class="clarify-panel-content">
      <div class="clarify-panel-header">
        <span>❓ Questions from Agent</span>
        <button onclick="closeQuestionPanel()">×</button>
      </div>
      <div class="clarify-panel-body" id="clarifyPanelBody">
        <!-- Questions rendered here -->
      </div>
      <div class="clarify-panel-footer">
        <label>
          <input type="checkbox" ${clarifyState.autoAssume ? 'checked' : ''} 
                 onchange="toggleAutoAssume(this.checked)">
          Auto-assume after 10s
        </label>
      </div>
    </div>
  `;
  
  return panel;
}

/**
 * Render the list of questions
 */
function renderQuestionList() {
  const container = document.getElementById('clarifyPanelBody');
  if (!container) return;
  
  const pending = clarifyState.questions.filter(q => !q.answered);
  const answered = clarifyState.questions.filter(q => q.answered);
  
  if (clarifyState.questions.length === 0) {
    container.innerHTML = `
      <div class="clarify-empty">
        <span>No questions from agent</span>
      </div>
    `;
    return;
  }
  
  let html = '';
  
  if (pending.length > 0) {
    html += '<div class="clarify-section-header">Pending</div>';
    for (const q of pending) {
      html += renderQuestionItem(q);
    }
  }
  
  if (answered.length > 0) {
    html += '<div class="clarify-section-header">Answered</div>';
    for (const q of answered.slice(-5)) {
      html += renderQuestionItem(q, true);
    }
  }
  
  container.innerHTML = html;
}

/**
 * Render a single question item
 */
function renderQuestionItem(question, isAnswered = false) {
  const time = new Date(question.timestamp).toLocaleTimeString();
  
  if (isAnswered) {
    return `
      <div class="clarify-item answered">
        <div class="clarify-item-question">${escapeHtml(question.question)}</div>
        <div class="clarify-item-answer">
          ${question.usedAssumption ? '🤖 Assumed:' : '✓'} ${escapeHtml(question.answer)}
        </div>
        <div class="clarify-item-time">${time}</div>
      </div>
    `;
  }
  
  return `
    <div class="clarify-item pending">
      <div class="clarify-item-question">${escapeHtml(question.question)}</div>
      ${question.context ? `<div class="clarify-item-context">${escapeHtml(question.context)}</div>` : ''}
      <div class="clarify-item-input">
        <input type="text" id="panel-input-${question.id}" placeholder="Your answer...">
        <button onclick="answerQuestion('${question.id}', document.getElementById('panel-input-${question.id}').value)">
          Send
        </button>
      </div>
      <div class="clarify-item-time">${time}</div>
    </div>
  `;
}

/**
 * Update the question badge count
 */
function updateQuestionBadge() {
  const pending = clarifyState.questions.filter(q => !q.answered).length;
  const badge = document.getElementById('clarifyBadge');
  
  if (badge) {
    badge.textContent = pending || '';
    badge.classList.toggle('hidden', pending === 0);
  }
}

/**
 * Toggle auto-assume setting
 */
function toggleAutoAssume(enabled) {
  clarifyState.autoAssume = enabled;
  localStorage.setItem('clarifyAutoAssume', enabled.toString());
}

/**
 * Get pending questions count
 */
function getPendingQuestionsCount() {
  return clarifyState.questions.filter(q => !q.answered).length;
}

/**
 * Clear all questions (on task complete/cancel)
 */
function clearQuestions() {
  // Cancel all timers
  for (const q of clarifyState.questions) {
    if (q._timer) clearInterval(q._timer);
  }
  
  clarifyState.questions = [];
  updateQuestionBadge();
}

// Helper
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Export functions
window.initClarifyingQuestions = initClarifyingQuestions;
window.handleClarifyingQuestion = handleClarifyingQuestion;
window.answerQuestion = answerQuestion;
window.openQuestionPanel = openQuestionPanel;
window.closeQuestionPanel = closeQuestionPanel;
window.toggleAutoAssume = toggleAutoAssume;
window.getPendingQuestionsCount = getPendingQuestionsCount;
window.clearQuestions = clearQuestions;

// Initialize on load
document.addEventListener('DOMContentLoaded', initClarifyingQuestions);
