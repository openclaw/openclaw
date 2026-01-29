// ============================================
// AGENT TERMINAL MODULE - Dedicated Terminal for Agent Commands
// ============================================
// Provides isolated terminal for agent execution with clear visual distinction

const agentTerminalState = {
  terminal: null,
  fitAddon: null,
  searchAddon: null,
  sessionId: null,
  isRunning: false,
  commandHistory: [],
  historyIndex: -1,
  outputBuffer: [],
  lastCommand: null,
  status: 'idle', // 'idle' | 'running' | 'success' | 'error'
};

/**
 * Initialize the agent terminal
 */
function initAgentTerminal() {
  const container = document.getElementById('agentTerminalContent');
  if (!container || agentTerminalState.terminal) return;
  
  const terminal = new Terminal({
    theme: {
      background: '#0d1117', // Darker than main terminal
      foreground: '#8b949e',
      cursor: '#58a6ff',
      selection: '#264f78',
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
    },
    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
    fontSize: 12,
    cursorBlink: true,
    scrollback: 10000,
    convertEol: true,
  });
  
  const fitAddon = new FitAddon.FitAddon();
  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  
  terminal.open(container);
  fitAddon.fit();
  
  agentTerminalState.terminal = terminal;
  agentTerminalState.fitAddon = fitAddon;
  agentTerminalState.searchAddon = searchAddon;
  
  // Welcome message
  writeAgentTerminalHeader();
  
  // Handle resize
  window.addEventListener('resize', () => {
    if (agentTerminalState.fitAddon) {
      agentTerminalState.fitAddon.fit();
    }
  });
  
  console.log('🤖 Agent terminal initialized');
}

/**
 * Write the header/welcome message to agent terminal
 */
function writeAgentTerminalHeader() {
  const term = agentTerminalState.terminal;
  if (!term) return;
  
  term.writeln('\x1b[38;5;33m╭─────────────────────────────────────────╮\x1b[0m');
  term.writeln('\x1b[38;5;33m│\x1b[0m  \x1b[1;36m🤖 Agent Terminal\x1b[0m                      \x1b[38;5;33m│\x1b[0m');
  term.writeln('\x1b[38;5;33m│\x1b[0m  Isolated shell for agent commands      \x1b[38;5;33m│\x1b[0m');
  term.writeln('\x1b[38;5;33m╰─────────────────────────────────────────╯\x1b[0m');
  term.writeln('');
}

/**
 * Execute a command in the agent terminal
 * @param {string} command - Command to execute
 * @param {Object} options - Execution options
 */
async function agentExec(command, options = {}) {
  const term = agentTerminalState.terminal;
  if (!term) {
    console.error('Agent terminal not initialized');
    return { success: false, error: 'Terminal not initialized' };
  }
  
  const { silent = false, timeout = 30000, cwd = null } = options;
  
  // Update state
  agentTerminalState.isRunning = true;
  agentTerminalState.lastCommand = command;
  agentTerminalState.commandHistory.push(command);
  agentTerminalState.status = 'running';
  updateAgentTerminalStatus('running');
  
  // Show command in terminal
  if (!silent) {
    term.writeln('');
    term.writeln(`\x1b[38;5;245m$ \x1b[38;5;75m${command}\x1b[0m`);
    term.writeln('');
  }
  
  try {
    // Send to server for execution
    const response = await fetch('/api/agent-exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, cwd, timeout })
    });
    
    const result = await response.json();
    
    // Stream output to terminal
    if (result.stdout) {
      for (const line of result.stdout.split('\n')) {
        term.writeln(line);
      }
    }
    
    if (result.stderr) {
      for (const line of result.stderr.split('\n')) {
        term.writeln(`\x1b[31m${line}\x1b[0m`);
      }
    }
    
    // Status indicator
    if (result.exitCode === 0) {
      agentTerminalState.status = 'success';
      updateAgentTerminalStatus('success');
      if (!silent) {
        term.writeln('');
        term.writeln('\x1b[32m✓ Command completed successfully\x1b[0m');
      }
    } else {
      agentTerminalState.status = 'error';
      updateAgentTerminalStatus('error');
      if (!silent) {
        term.writeln('');
        term.writeln(`\x1b[31m✗ Command failed with exit code ${result.exitCode}\x1b[0m`);
      }
    }
    
    agentTerminalState.isRunning = false;
    agentTerminalState.outputBuffer.push({
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timestamp: Date.now()
    });
    
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
    
  } catch (error) {
    agentTerminalState.isRunning = false;
    agentTerminalState.status = 'error';
    updateAgentTerminalStatus('error');
    
    term.writeln(`\x1b[31m✗ Error: ${error.message}\x1b[0m`);
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Execute multiple commands sequentially
 * @param {string[]} commands - Array of commands
 * @param {Object} options - Execution options
 */
async function agentExecSequence(commands, options = {}) {
  const results = [];
  
  for (const command of commands) {
    const result = await agentExec(command, options);
    results.push(result);
    
    if (!result.success && options.stopOnError !== false) {
      break;
    }
  }
  
  return results;
}

/**
 * Write a message to the agent terminal (not a command)
 * @param {string} message - Message to write
 * @param {string} type - Message type: 'info' | 'success' | 'warning' | 'error'
 */
function agentTerminalLog(message, type = 'info') {
  const term = agentTerminalState.terminal;
  if (!term) return;
  
  const colors = {
    info: '\x1b[36m',    // Cyan
    success: '\x1b[32m', // Green
    warning: '\x1b[33m', // Yellow
    error: '\x1b[31m',   // Red
  };
  
  const icons = {
    info: 'ℹ',
    success: '✓',
    warning: '⚠',
    error: '✗',
  };
  
  const color = colors[type] || colors.info;
  const icon = icons[type] || icons.info;
  
  term.writeln(`${color}${icon} ${message}\x1b[0m`);
}

/**
 * Clear the agent terminal
 */
function clearAgentTerminal() {
  const term = agentTerminalState.terminal;
  if (!term) return;
  
  term.clear();
  writeAgentTerminalHeader();
  agentTerminalState.outputBuffer = [];
}

/**
 * Update the agent terminal status indicator in the UI
 * @param {string} status - Status: 'idle' | 'running' | 'success' | 'error'
 */
function updateAgentTerminalStatus(status) {
  const indicator = document.getElementById('agentTerminalStatus');
  if (!indicator) return;
  
  indicator.className = `agent-terminal-status ${status}`;
  
  const text = {
    idle: 'Ready',
    running: 'Running...',
    success: 'Success',
    error: 'Error'
  };
  
  indicator.textContent = text[status] || 'Ready';
}

/**
 * Toggle agent terminal panel visibility
 */
function toggleAgentTerminal() {
  const panel = document.getElementById('agentTerminalPanel');
  if (!panel) return;
  
  const isVisible = !panel.classList.contains('collapsed');
  
  if (isVisible) {
    panel.classList.add('collapsed');
  } else {
    panel.classList.remove('collapsed');
    // Initialize if not done yet
    if (!agentTerminalState.terminal) {
      initAgentTerminal();
    }
    // Fit on show
    setTimeout(() => {
      if (agentTerminalState.fitAddon) {
        agentTerminalState.fitAddon.fit();
      }
    }, 100);
  }
}

/**
 * Get the agent terminal output history
 * @param {number} limit - Number of recent outputs to return
 */
function getAgentTerminalHistory(limit = 10) {
  return agentTerminalState.outputBuffer.slice(-limit);
}

/**
 * Search the agent terminal output
 * @param {string} query - Search query
 */
function searchAgentTerminal(query) {
  const searchAddon = agentTerminalState.searchAddon;
  if (!searchAddon) return;
  
  searchAddon.findNext(query, { caseSensitive: false, regex: false });
}

// Export functions for global access
window.initAgentTerminal = initAgentTerminal;
window.agentExec = agentExec;
window.agentExecSequence = agentExecSequence;
window.agentTerminalLog = agentTerminalLog;
window.clearAgentTerminal = clearAgentTerminal;
window.toggleAgentTerminal = toggleAgentTerminal;
window.getAgentTerminalHistory = getAgentTerminalHistory;
window.searchAgentTerminal = searchAgentTerminal;

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  // Delay init to let main terminal load first
  setTimeout(initAgentTerminal, 500);
});
