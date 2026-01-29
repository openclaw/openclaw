// ============================================
// VOICE COMMANDS MODULE
// ============================================
// Uses Web Speech API for voice-to-text input
// Depends on: state (global), showNotification, sendAiMessage

const voiceState = {
  recognition: null,
  isListening: false,
  transcript: '',
  continuous: false,
  targetInput: null, // 'chat' | 'agent' | 'search' | 'inline'
};

// Check if browser supports speech recognition
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSupported = !!SpeechRecognition;

function initVoiceCommands() {
  if (!speechSupported) {
    console.warn('Speech recognition not supported in this browser');
    return;
  }
  
  voiceState.recognition = new SpeechRecognition();
  voiceState.recognition.continuous = false;
  voiceState.recognition.interimResults = true;
  voiceState.recognition.lang = 'en-US';
  
  voiceState.recognition.onstart = () => {
    voiceState.isListening = true;
    updateVoiceUI(true);
    showNotification('🎤 Listening...', 'info');
  };
  
  voiceState.recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';
    
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }
    
    voiceState.transcript = finalTranscript || interimTranscript;
    
    // Update target input with transcript
    if (voiceState.targetInput) {
      updateTargetInput(voiceState.transcript, !finalTranscript);
    }
    
    // If final, process the command
    if (finalTranscript) {
      processVoiceCommand(finalTranscript);
    }
  };
  
  voiceState.recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    voiceState.isListening = false;
    updateVoiceUI(false);
    
    if (event.error === 'no-speech') {
      showNotification('No speech detected', 'warning');
    } else if (event.error === 'not-allowed') {
      showNotification('Microphone access denied', 'error');
    } else {
      showNotification(`Voice error: ${event.error}`, 'error');
    }
  };
  
  voiceState.recognition.onend = () => {
    voiceState.isListening = false;
    updateVoiceUI(false);
    
    // Restart if continuous mode
    if (voiceState.continuous && voiceState.recognition) {
      setTimeout(() => {
        if (voiceState.continuous) {
          voiceState.recognition.start();
        }
      }, 100);
    }
  };
  
  // Add keyboard shortcut hint
  console.log('🎤 Voice commands initialized. Press Cmd+Shift+V to toggle voice input.');
}

function toggleVoiceInput(target = 'chat') {
  if (!speechSupported) {
    showNotification('Voice input not supported in this browser. Try Chrome or Edge.', 'error');
    return;
  }
  
  if (voiceState.isListening) {
    stopVoiceInput();
  } else {
    startVoiceInput(target);
  }
}

function startVoiceInput(target = 'chat') {
  if (!voiceState.recognition) {
    initVoiceCommands();
  }
  
  voiceState.targetInput = target;
  voiceState.transcript = '';
  
  try {
    voiceState.recognition.start();
  } catch (e) {
    // Already started
    console.warn('Recognition already started');
  }
}

function stopVoiceInput() {
  if (voiceState.recognition) {
    voiceState.continuous = false;
    voiceState.recognition.stop();
  }
  voiceState.isListening = false;
  updateVoiceUI(false);
}

function updateTargetInput(text, isInterim) {
  const target = voiceState.targetInput;
  let inputEl = null;
  
  switch (target) {
    case 'chat':
      inputEl = document.getElementById('aiInput');
      break;
    case 'agent':
      inputEl = document.getElementById('agentTaskText');
      break;
    case 'search':
      inputEl = document.getElementById('searchInput');
      break;
    case 'inline':
      inputEl = document.getElementById('inlineEditInput');
      break;
  }
  
  if (inputEl) {
    inputEl.value = text;
    // Show interim indicator
    if (isInterim) {
      inputEl.style.opacity = '0.7';
    } else {
      inputEl.style.opacity = '1';
    }
  }
}

function updateVoiceUI(isListening) {
  // Update all voice buttons
  document.querySelectorAll('.voice-btn').forEach(btn => {
    btn.classList.toggle('listening', isListening);
    btn.textContent = isListening ? '🔴' : '🎤';
    btn.title = isListening ? 'Stop listening' : 'Start voice input';
  });
  
  // Update status bar if exists
  const statusIndicator = document.getElementById('voiceStatus');
  if (statusIndicator) {
    statusIndicator.classList.toggle('active', isListening);
  }
}

function processVoiceCommand(text) {
  const lowerText = text.toLowerCase().trim();
  
  // Check for special commands
  if (lowerText.startsWith('clawd ') || lowerText.startsWith('claude ')) {
    // Direct AI command - send to chat
    const command = text.replace(/^(clawd|claude)\s+/i, '');
    sendVoiceToChat(command);
    return;
  }
  
  // Check for action commands
  const actionCommands = {
    'save file': () => saveCurrentFile(),
    'save': () => saveCurrentFile(),
    'undo': () => state.editor?.trigger('keyboard', 'undo'),
    'redo': () => state.editor?.trigger('keyboard', 'redo'),
    'copy': () => document.execCommand('copy'),
    'paste': () => document.execCommand('paste'),
    'cut': () => document.execCommand('cut'),
    'select all': () => state.editor?.setSelection(state.editor.getModel().getFullModelRange()),
    'new file': () => createNewFile(),
    'new folder': () => createNewFolder(),
    'open terminal': () => toggleTerminal(),
    'close terminal': () => toggleTerminal(),
    'toggle terminal': () => toggleTerminal(),
    'open settings': () => openSettings(),
    'run agent': () => startAgentTask(),
    'cancel': () => stopVoiceInput(),
    'stop': () => stopVoiceInput(),
    'stop listening': () => stopVoiceInput(),
  };
  
  for (const [command, action] of Object.entries(actionCommands)) {
    if (lowerText === command || lowerText.startsWith(command + ' ')) {
      action();
      showNotification(`✓ ${command}`, 'success');
      return;
    }
  }
  
  // Navigation commands
  if (lowerText.startsWith('go to line ')) {
    const lineNum = parseInt(lowerText.replace('go to line ', ''));
    if (!isNaN(lineNum) && state.editor) {
      state.editor.revealLineInCenter(lineNum);
      state.editor.setPosition({ lineNumber: lineNum, column: 1 });
      showNotification(`→ Line ${lineNum}`, 'success');
    }
    return;
  }
  
  if (lowerText.startsWith('search for ') || lowerText.startsWith('find ')) {
    const query = text.replace(/^(search for|find)\s+/i, '');
    openGlobalSearch();
    const input = document.getElementById('searchInput');
    if (input) {
      input.value = query;
      handleSearch({ target: input });
    }
    return;
  }
  
  // If no command matched and target is chat, send as chat message
  if (voiceState.targetInput === 'chat') {
    sendVoiceToChat(text);
  }
}

function sendVoiceToChat(text) {
  const input = document.getElementById('aiInput');
  if (input) {
    input.value = text;
    // Simulate send button click or enter
    const sendBtn = document.querySelector('.ai-send-btn');
    if (sendBtn) {
      sendBtn.click();
    } else {
      // Trigger the send function directly
      if (typeof sendAiMessage === 'function') {
        sendAiMessage();
      }
    }
  }
}

// Keyboard shortcut handler
function setupVoiceShortcut() {
  document.addEventListener('keydown', (e) => {
    // Cmd+Shift+V - Toggle voice input
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'v') {
      e.preventDefault();
      
      // Determine target based on focus
      let target = 'chat';
      const activeEl = document.activeElement;
      
      if (activeEl) {
        if (activeEl.id === 'agentTaskText') target = 'agent';
        else if (activeEl.id === 'searchInput') target = 'search';
        else if (activeEl.id === 'inlineEditInput') target = 'inline';
      }
      
      toggleVoiceInput(target);
    }
  });
}

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initVoiceCommands();
    setupVoiceShortcut();
  });
} else {
  initVoiceCommands();
  setupVoiceShortcut();
}

// Export to window
window.voiceState = voiceState;
window.speechSupported = speechSupported;
window.toggleVoiceInput = toggleVoiceInput;
window.startVoiceInput = startVoiceInput;
window.stopVoiceInput = stopVoiceInput;
window.initVoiceCommands = initVoiceCommands;
