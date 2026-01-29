/**
 * DAP Client - Debug Adapter Protocol client for IDE
 * Communicates with debug adapters (Node.js, Chrome, etc.)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

// DAP message types
const DAP_HEADER_SEPARATOR = '\r\n\r\n';

class DAPClient extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.buffer = '';
    this.seq = 1;
    this.pendingRequests = new Map();
    this.initialized = false;
    this.capabilities = {};
    this.threads = [];
    this.stackFrames = new Map();
    this.scopes = new Map();
    this.variables = new Map();
  }

  /**
   * Start a debug session
   * @param {object} config - Launch configuration
   */
  async launch(config) {
    const { type, program, cwd, args = [], env = {} } = config;
    
    // For Node.js debugging, we use the built-in inspector
    if (type === 'node' || type === 'pwa-node') {
      return this.launchNode(program, cwd, args, env);
    }
    
    throw new Error(`Unsupported debug type: ${type}`);
  }

  /**
   * Launch Node.js debug session using built-in inspector
   */
  async launchNode(program, cwd, args = [], env = {}) {
    const programPath = path.resolve(cwd || process.cwd(), program);
    
    if (!fs.existsSync(programPath)) {
      throw new Error(`Program not found: ${programPath}`);
    }

    // Start Node.js with inspector
    const nodeArgs = [
      '--inspect-brk=0', // Break on first line, random port
      programPath,
      ...args
    ];

    this.process = spawn('node', nodeArgs, {
      cwd: cwd || path.dirname(programPath),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let inspectorUrl = null;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Debug session startup timeout'));
      }, 10000);

      this.process.stderr.on('data', (data) => {
        const output = data.toString();
        console.log('[DAP] stderr:', output);
        
        // Parse inspector URL from Node.js output
        const match = output.match(/Debugger listening on (ws:\/\/[^\s]+)/);
        if (match && !inspectorUrl) {
          inspectorUrl = match[1];
          clearTimeout(timeout);
          this.connectToInspector(inspectorUrl)
            .then(() => resolve({ inspectorUrl }))
            .catch(reject);
        }
      });

      this.process.stdout.on('data', (data) => {
        this.emit('output', { category: 'stdout', output: data.toString() });
      });

      this.process.on('exit', (code, signal) => {
        this.emit('terminated', { exitCode: code, signal });
        this.cleanup();
      });

      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Connect to Node.js inspector via WebSocket
   */
  async connectToInspector(wsUrl) {
    const WebSocket = require('ws');
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', () => {
        console.log('[DAP] Connected to inspector');
        this.initialized = true;
        
        // Enable debugger
        this.sendInspectorCommand('Debugger.enable').then(() => {
          // Enable runtime for console
          return this.sendInspectorCommand('Runtime.enable');
        }).then(() => {
          resolve();
        }).catch(reject);
      });

      this.ws.on('message', (data) => {
        this.handleInspectorMessage(JSON.parse(data.toString()));
      });

      this.ws.on('error', (err) => {
        console.error('[DAP] WebSocket error:', err);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log('[DAP] Inspector connection closed');
        this.emit('terminated', {});
      });
    });
  }

  /**
   * Send command to Node.js inspector
   */
  sendInspectorCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('Inspector not connected'));
        return;
      }

      const id = this.seq++;
      const message = { id, method, params };
      
      this.pendingRequests.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(message));
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Command timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /**
   * Handle messages from Node.js inspector
   */
  handleInspectorMessage(message) {
    // Response to a command
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Event from debugger
    const { method, params } = message;
    
    switch (method) {
      case 'Debugger.paused':
        this.handlePaused(params);
        break;
      case 'Debugger.resumed':
        this.emit('continued', {});
        break;
      case 'Debugger.scriptParsed':
        this.emit('scriptLoaded', {
          path: params.url,
          scriptId: params.scriptId
        });
        break;
      case 'Runtime.consoleAPICalled':
        this.handleConsoleOutput(params);
        break;
      case 'Runtime.exceptionThrown':
        this.emit('output', {
          category: 'stderr',
          output: `Exception: ${params.exceptionDetails?.text || 'Unknown error'}\n`
        });
        break;
    }
  }

  /**
   * Handle debugger paused event
   */
  async handlePaused(params) {
    const { callFrames, reason, hitBreakpoints } = params;
    
    // Store call frames
    this.stackFrames.clear();
    const frames = callFrames.map((frame, index) => {
      const frameData = {
        id: index,
        name: frame.functionName || '(anonymous)',
        source: {
          path: frame.url,
          name: path.basename(frame.url || 'unknown')
        },
        line: frame.location.lineNumber + 1, // 0-indexed to 1-indexed
        column: frame.location.columnNumber + 1,
        scopeChain: frame.scopeChain,
        callFrameId: frame.callFrameId
      };
      this.stackFrames.set(index, frameData);
      return frameData;
    });

    this.emit('stopped', {
      reason: reason || 'breakpoint',
      threadId: 1,
      allThreadsStopped: true,
      hitBreakpointIds: hitBreakpoints
    });

    this.emit('stackTrace', { frames });
  }

  /**
   * Handle console output
   */
  handleConsoleOutput(params) {
    const { type, args } = params;
    const output = args.map(arg => {
      if (arg.type === 'string') return arg.value;
      if (arg.type === 'number') return String(arg.value);
      if (arg.type === 'boolean') return String(arg.value);
      if (arg.type === 'undefined') return 'undefined';
      if (arg.type === 'object') return arg.description || '[object]';
      return String(arg.value || arg.description || arg.type);
    }).join(' ') + '\n';

    this.emit('output', {
      category: type === 'error' ? 'stderr' : 'stdout',
      output
    });
  }

  /**
   * Set breakpoints for a file
   */
  async setBreakpoints(filePath, lines) {
    if (!this.ws) return { breakpoints: [] };

    // Convert file path to URL format for Node.js inspector
    const url = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    
    // Remove existing breakpoints for this file (by setting empty)
    // Then set new ones
    const breakpoints = [];
    
    for (const line of lines) {
      try {
        const result = await this.sendInspectorCommand('Debugger.setBreakpointByUrl', {
          lineNumber: line - 1, // Convert to 0-indexed
          url: url,
          columnNumber: 0
        });
        
        breakpoints.push({
          id: result.breakpointId,
          verified: true,
          line: line
        });
      } catch (err) {
        breakpoints.push({
          verified: false,
          line: line,
          message: err.message
        });
      }
    }
    
    return { breakpoints };
  }

  /**
   * Remove a breakpoint
   */
  async removeBreakpoint(breakpointId) {
    if (!this.ws) return;
    
    try {
      await this.sendInspectorCommand('Debugger.removeBreakpoint', {
        breakpointId
      });
    } catch (err) {
      console.error('[DAP] Failed to remove breakpoint:', err);
    }
  }

  /**
   * Continue execution
   */
  async continue() {
    if (!this.ws) return;
    await this.sendInspectorCommand('Debugger.resume');
  }

  /**
   * Pause execution
   */
  async pause() {
    if (!this.ws) return;
    await this.sendInspectorCommand('Debugger.pause');
  }

  /**
   * Step over (next line)
   */
  async stepOver() {
    if (!this.ws) return;
    await this.sendInspectorCommand('Debugger.stepOver');
  }

  /**
   * Step into function
   */
  async stepIn() {
    if (!this.ws) return;
    await this.sendInspectorCommand('Debugger.stepInto');
  }

  /**
   * Step out of function
   */
  async stepOut() {
    if (!this.ws) return;
    await this.sendInspectorCommand('Debugger.stepOut');
  }

  /**
   * Get variables for a scope
   */
  async getVariables(scopeObjectId) {
    if (!this.ws) return [];
    
    try {
      const result = await this.sendInspectorCommand('Runtime.getProperties', {
        objectId: scopeObjectId,
        ownProperties: false,
        generatePreview: true
      });
      
      return result.result.map(prop => ({
        name: prop.name,
        value: this.formatValue(prop.value),
        type: prop.value?.type || 'undefined',
        variablesReference: prop.value?.objectId ? prop.value.objectId : 0
      }));
    } catch (err) {
      console.error('[DAP] Failed to get variables:', err);
      return [];
    }
  }

  /**
   * Format a value for display
   */
  formatValue(value) {
    if (!value) return 'undefined';
    
    switch (value.type) {
      case 'string':
        return `"${value.value}"`;
      case 'number':
      case 'boolean':
        return String(value.value);
      case 'undefined':
        return 'undefined';
      case 'null':
        return 'null';
      case 'object':
        return value.description || value.className || '[object]';
      case 'function':
        return value.description || '[function]';
      default:
        return String(value.value || value.description || value.type);
    }
  }

  /**
   * Evaluate an expression
   */
  async evaluate(expression, frameId = null) {
    if (!this.ws) return { result: 'Debugger not connected' };
    
    try {
      let result;
      
      if (frameId !== null) {
        const frame = this.stackFrames.get(frameId);
        if (frame?.callFrameId) {
          result = await this.sendInspectorCommand('Debugger.evaluateOnCallFrame', {
            callFrameId: frame.callFrameId,
            expression,
            generatePreview: true
          });
        }
      } else {
        result = await this.sendInspectorCommand('Runtime.evaluate', {
          expression,
          generatePreview: true
        });
      }
      
      return {
        result: this.formatValue(result.result),
        type: result.result?.type,
        variablesReference: result.result?.objectId || 0
      };
    } catch (err) {
      return { result: `Error: ${err.message}` };
    }
  }

  /**
   * Stop debugging session
   */
  async terminate() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    
    this.cleanup();
  }

  /**
   * Clean up resources
   */
  cleanup() {
    this.initialized = false;
    this.pendingRequests.clear();
    this.stackFrames.clear();
    this.scopes.clear();
    this.variables.clear();
  }
}

module.exports = DAPClient;
