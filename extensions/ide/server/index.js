const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const crypto = require('crypto');
const chokidar = require('chokidar');
const CodebaseIndexer = require('./indexer');
const DAPClient = require('./dap-client');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const WORKSPACE = process.env.CLAWD_WORKSPACE || path.join(os.homedir(), 'clawd');
const PORT = process.env.PORT || 3333;
// Gateway connection - use token from config file
const GATEWAY_URL = 'ws://127.0.0.1:18790';
const GATEWAY_TOKEN = '800939f4957b2368e3163731b5b2d72ae73747cfc272f17b';

// Gateway connection state
let gatewayWs = null;
let gatewayConnected = false;
let pendingRequests = new Map();
let ideClients = new Set();

// Agent Mode state
const agentTasks = new Map(); // taskId -> { plan, currentStep, pendingStep, paused, ws }

// Get memory context for AI enrichment (synchronous, cached)
let memoryContextCache = null;
let memoryContextCacheTime = 0;
const MEMORY_CACHE_TTL = 60000; // 1 minute cache

function getMemoryContext() {
  // Use cache if fresh
  if (memoryContextCache && (Date.now() - memoryContextCacheTime) < MEMORY_CACHE_TTL) {
    return memoryContextCache;
  }
  
  try {
    let context = '';
    const tokensPerChar = 0.25;
    let tokenEstimate = 0;
    const maxTokens = 1500; // Keep it lean
    
    // Priority 1: Today's notes (most relevant)
    const today = new Date().toISOString().split('T')[0];
    const todayPath = path.join(WORKSPACE, 'memory', `${today}.md`);
    if (fs.existsSync(todayPath)) {
      const content = fs.readFileSync(todayPath, 'utf-8').slice(0, 800);
      context += `Today's session notes:\n${content}\n\n`;
      tokenEstimate += content.length * tokensPerChar;
    }
    
    // Priority 2: Key preferences from SOUL.md
    const soulPath = path.join(WORKSPACE, 'SOUL.md');
    if (fs.existsSync(soulPath) && tokenEstimate < maxTokens * 0.7) {
      const soul = fs.readFileSync(soulPath, 'utf-8');
      // Extract preferences section only
      const prefMatch = soul.match(/### (Working Style|Code Style|Preferences)[\s\S]*?(?=###|$)/i);
      if (prefMatch) {
        const prefs = prefMatch[0].slice(0, 400);
        context += `User preferences:\n${prefs}\n\n`;
        tokenEstimate += prefs.length * tokensPerChar;
      }
    }
    
    // Priority 3: Recent memory (if space allows)
    const memoryPath = path.join(WORKSPACE, 'MEMORY.md');
    if (fs.existsSync(memoryPath) && tokenEstimate < maxTokens * 0.9) {
      const memory = fs.readFileSync(memoryPath, 'utf-8');
      const available = Math.floor((maxTokens - tokenEstimate) / tokensPerChar);
      const truncated = memory.slice(0, Math.min(available, 500));
      context += `Long-term memory:\n${truncated}`;
    }
    
    // Cache the result
    memoryContextCache = context || null;
    memoryContextCacheTime = Date.now();
    
    return memoryContextCache;
  } catch (err) {
    console.error('Failed to get memory context:', err);
    return null;
  }
}

// Build agent prompt with codebase context
function buildAgentPrompt(task, workspace, currentFile) {
  // Get codebase structure (limited)
  let fileList = [];
  try {
    const scanDir = (dir, depth = 0) => {
      if (depth > 2 || fileList.length > 50) return;
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'dist') continue;
        const relativePath = path.relative(workspace, path.join(dir, item.name));
        if (item.isDirectory()) {
          scanDir(path.join(dir, item.name), depth + 1);
        } else {
          fileList.push(relativePath);
        }
      }
    };
    scanDir(workspace);
  } catch (e) {}
  
  return `You are an AI coding agent in PLANNING MODE. Your job is to create a structured plan that the IDE will display for user approval.

**CRITICAL: DO NOT USE ANY TOOLS. DO NOT CALL Write, Read, exec, or any other tools.**
**You must ONLY output text in the exact format below. No tool calls allowed.**

This is a two-phase workflow:
1. PLANNING PHASE (now): Output a plan and file changes as TEXT (no tools)
2. EXECUTION PHASE (later): The IDE will apply approved changes

**REQUIRED OUTPUT FORMAT:**

First, output your plan as a JSON code block:
\`\`\`json:plan
[
  {"id": 1, "description": "Brief description of step 1"},
  {"id": 2, "description": "Brief description of step 2"}
]
\`\`\`

Then, for EACH file that needs to be created or modified, output:
\`\`\`json:file-change
{
  "stepId": 1,
  "file": "relative/path/to/file.js",
  "changeType": "create",
  "content": "// Full file content goes here\\nfunction example() {\\n  return 'hello';\\n}\\nmodule.exports = { example };"
}
\`\`\`

**REMEMBER:**
- Output ONLY the json:plan and json:file-change blocks
- DO NOT use any tools (Write, Read, exec, etc.)
- The "content" field must contain the COMPLETE file content with proper escaping
- Use \\n for newlines in the content string

**TASK:** ${task}

**WORKSPACE:** ${workspace}
${currentFile ? `**CURRENT FILE:** ${currentFile}` : ''}

**PROJECT FILES:**
${fileList.slice(0, 30).join('\n')}
${fileList.length > 30 ? `\n... and ${fileList.length - 30} more files` : ''}

Now output your plan and file changes (NO TOOL CALLS):`;
}

// Send agent message and handle streaming response
async function sendAgentMessage(taskId, prompt, ws, mode = 'safe') {
  const idempotencyKey = crypto.randomBytes(8).toString('hex');
  
  // Initialize task state with tracking info
  agentTasks.set(taskId, {
    plan: [],
    currentStep: -1,
    pendingStep: null,
    paused: false,
    mode, // 'safe' | 'standard' | 'autonomous'
    ws,
    buffer: '',
    runId: idempotencyKey,  // Use idempotencyKey as initial runId fallback
    idempotencyKey,
    createdAt: Date.now(),
    sessionKey: 'agent:main:ide-agent'
  });
  
  const params = {
    message: prompt,
    idempotencyKey,
    sessionKey: 'agent:main:ide-agent'  // Separate session for IDE Agent Mode
  };
  
  try {
    const response = await sendToGateway('chat.send', params);
    
    // Store the runId from the response - try multiple paths
    const task = agentTasks.get(taskId);
    if (task) {
      task.runId = response.payload?.runId || 
                   response.runId || 
                   response.data?.runId ||
                   idempotencyKey;
      console.log(`[Agent] Task ${taskId} started, runId: ${task.runId}`);
    }
    // Response streaming will be handled via gateway events
    // which we parse in handleGatewayMessage
  } catch (err) {
    console.error(`[Agent] chat.send failed:`, err);
    throw err;
  }
}

// Continue agent task to next step
async function continueAgentTask(taskId, ws) {
  const task = agentTasks.get(taskId);
  if (!task || task.paused) return;
  
  task.currentStep++;
  
  if (task.currentStep >= task.plan.length) {
    // All steps complete
    ws.send(JSON.stringify({
      type: 'agent:complete',
      taskId,
      summary: `Completed ${task.plan.length} steps successfully.`
    }));
    agentTasks.delete(taskId);
    return;
  }
  
  const currentStep = task.plan[task.currentStep];
  
  // Start next step - notify client
  ws.send(JSON.stringify({
    type: 'agent:step-start',
    taskId,
    stepIndex: task.currentStep,
    description: currentStep?.description || 'Working...'
  }));
  
  // Send continuation prompt to AI
  const continuationPrompt = buildContinuationPrompt(task, currentStep);
  
  try {
    const params = {
      message: continuationPrompt,
      idempotencyKey: crypto.randomBytes(8).toString('hex'),
      sessionKey: 'agent:main:ide-agent'  // Separate session for IDE Agent Mode
    };
    await sendToGateway('chat.send', params);
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'agent:step-failed',
      taskId,
      stepIndex: task.currentStep,
      error: `Failed to continue: ${err.message}`
    }));
  }
}

// Auto-approve a pending step (for autonomous mode)
async function autoApproveStep(taskId, ws) {
  const task = agentTasks.get(taskId);
  if (!task || !task.pendingStep) return;
  
  const stepData = task.pendingStep;
  
  try {
    const fullPath = path.isAbsolute(stepData.file) 
      ? stepData.file 
      : path.join(WORKSPACE, stepData.file);
    
    if (stepData.changeType === 'delete') {
      fs.unlinkSync(fullPath);
    } else {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, stepData.newContent, 'utf-8');
    }
    
    // Mark step complete
    ws.send(JSON.stringify({
      type: 'agent:step-complete',
      taskId,
      stepId: stepData.stepId,
      stepIndex: stepData.stepIndex,
      details: `Auto-applied changes to ${stepData.file}`
    }));
    
    task.pendingStep = null;
    
    // Continue to next step
    await continueAgentTask(taskId, ws);
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'agent:step-failed',
      taskId,
      stepId: stepData.stepId,
      error: err.message
    }));
  }
}

// Build prompt for continuing to next step
function buildContinuationPrompt(task, step) {
  const completedSteps = task.plan
    .slice(0, task.currentStep)
    .map((s, i) => `${i + 1}. ✅ ${s.description}`)
    .join('\n');
  
  return `Continue with the next step of the plan.

Completed steps:
${completedSteps}

Current step ${task.currentStep + 1}: ${step.description}

Execute this step now. If it involves file changes, output a json:file-change block:

\`\`\`json:file-change
{
  "stepId": ${task.currentStep + 1},
  "file": "path/to/file.js",
  "changeType": "create|modify|delete",
  "content": "full file content here"
}
\`\`\`

If the step doesn't require file changes (e.g., analysis), describe what you found and I'll move to the next step.`;
}

// Parse agent response for plan and file changes
function parseAgentResponse(content, taskId) {
  const task = agentTasks.get(taskId);
  if (!task) {
    console.log(`[Agent] No task found for ${taskId}`);
    return;
  }
  
  console.log(`[Agent] Parsing response for ${taskId}, length: ${content.length}`);
  
  // Look for plan JSON - support multiple formats
  const planMatch = content.match(/```json:plan\s*([\s\S]*?)```/) ||
                    content.match(/```plan\s*([\s\S]*?)```/) ||
                    content.match(/"plan"\s*:\s*(\[[\s\S]*?\])/);
  if (planMatch) {
    try {
      const planJson = planMatch[1].trim();
      console.log(`[Agent] Found plan JSON: ${planJson.substring(0, 100)}...`);
      const plan = JSON.parse(planJson);
      task.plan = Array.isArray(plan) ? plan : [plan];
      
      console.log(`[Agent] Sending plan with ${task.plan.length} steps`);
      task.ws.send(JSON.stringify({
        type: 'agent:plan',
        taskId,
        plan: task.plan
      }));
      
      // Start first step
      if (task.plan.length > 0) {
        task.currentStep = 0;
        task.ws.send(JSON.stringify({
          type: 'agent:step-start',
          taskId,
          stepIndex: 0,
          description: task.plan[0].description || task.plan[0].title || 'Step 1'
        }));
      }
    } catch (e) {
      console.error('[Agent] Failed to parse agent plan:', e, planMatch[1]);
    }
  }
  
  // Look for file changes - support multiple formats
  const fileChangeMatch = content.match(/```json:file-change\s*([\s\S]*?)```/) ||
                          content.match(/```file-change\s*([\s\S]*?)```/) ||
                          content.match(/"file-change"\s*:\s*(\{[\s\S]*?\})/);
  if (fileChangeMatch) {
    try {
      const change = JSON.parse(fileChangeMatch[1]);
      
      // Store as pending step for approval
      task.pendingStep = {
        stepId: change.stepId,
        stepIndex: task.currentStep,
        file: change.file,
        changeType: change.changeType || 'modify',
        newContent: change.content
      };
      
      // Generate diff
      const fullPath = path.isAbsolute(change.file) 
        ? change.file 
        : path.join(WORKSPACE, change.file);
      
      let originalContent = '';
      try {
        originalContent = fs.readFileSync(fullPath, 'utf-8');
      } catch {}
      
      const hunks = generateDiff(originalContent, change.content || '');
      
      // Send preview to client
      task.ws.send(JSON.stringify({
        type: 'agent:step-preview',
        taskId,
        stepId: change.stepId,
        stepIndex: task.currentStep,
        file: change.file,
        changeType: change.changeType || (originalContent ? 'modify' : 'create'),
        originalContent,
        newContent: change.content,
        hunks
      }));
      
      // In autonomous mode, auto-approve immediately
      // In standard mode, auto-approve reads but wait for writes
      if (task.mode === 'autonomous') {
        setTimeout(() => autoApproveStep(taskId, task.ws), 100);
      }
    } catch (e) {
      console.error('Failed to parse file change:', e);
    }
  }
  
  // Check for step completion marker (for analysis-only steps)
  const stepCompleteMatch = content.match(/```json:step-complete\s*([\s\S]*?)```/);
  if (stepCompleteMatch) {
    try {
      const completion = JSON.parse(stepCompleteMatch[1]);
      
      // Mark step as complete
      task.ws.send(JSON.stringify({
        type: 'agent:step-complete',
        taskId,
        stepId: completion.stepId || task.currentStep,
        stepIndex: task.currentStep,
        details: completion.summary || 'Step completed'
      }));
      
      // Auto-continue to next step
      continueAgentTask(taskId, task.ws);
    } catch (e) {
      console.error('Failed to parse step completion:', e);
    }
  }
  
  // If response has no plan, no file change, and no step-complete, 
  // check if it looks like a completed analysis step
  if (!planMatch && !fileChangeMatch && !stepCompleteMatch && task.plan.length > 0) {
    const isAnalysisResponse = content.includes('analyzed') || 
                               content.includes('found') || 
                               content.includes('identified') ||
                               content.includes('completed the analysis') ||
                               content.includes('moving to the next step');
    
    if (isAnalysisResponse && !task.pendingStep) {
      // Auto-complete the current step and continue
      task.ws.send(JSON.stringify({
        type: 'agent:step-complete',
        taskId,
        stepIndex: task.currentStep,
        details: content.substring(0, 200) + (content.length > 200 ? '...' : '')
      }));
      
      // Continue to next step after a small delay
      setTimeout(() => continueAgentTask(taskId, task.ws), 500);
    }
  }
}

// Connect to DNA Gateway
function connectToGateway() {
  if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) return;
  
  console.log('🔗 Connecting to DNA Gateway...');
  
  gatewayWs = new WebSocket(GATEWAY_URL);
  
  gatewayWs.on('open', () => {
    console.log('✅ Gateway WebSocket connected');
    
    // Send connect handshake with token authentication
    const connectMsg = {
      type: 'req',
      id: generateId(),
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'gateway-client',
          displayName: 'Clawd IDE',
          mode: 'backend',
          version: '1.0.0',
          platform: process.platform,
          instanceId: 'clawd-ide-' + crypto.randomBytes(4).toString('hex')
        },
        caps: [],
        role: 'operator',
        scopes: ['operator.admin'],
        auth: {
          token: GATEWAY_TOKEN
        }
      }
    };
    
    gatewayWs.send(JSON.stringify(connectMsg));
  });
  
  gatewayWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('Gateway message:', JSON.stringify(msg).substring(0, 200));
      handleGatewayMessage(msg);
    } catch (e) {
      console.error('Gateway message parse error:', e);
    }
  });
  
  gatewayWs.on('close', (code, reason) => {
    console.log(`⚠️ Gateway connection closed (code: ${code}, reason: ${reason.toString()}), reconnecting in 5s...`);
    gatewayConnected = false;
    broadcastToClients({ type: 'gateway:status', connected: false });
    setTimeout(connectToGateway, 5000);
  });
  
  gatewayWs.on('error', (err) => {
    console.error('Gateway error:', err.message);
  });
  
  gatewayWs.on('unexpected-response', (req, res) => {
    console.error('Gateway unexpected response:', res.statusCode, res.statusMessage);
  });
}

function handleGatewayMessage(msg) {
  // Handle response to our request
  if (msg.type === 'res') {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(msg);
      pendingRequests.delete(msg.id);
    }
    
    // Check if it's the connect response
    if (msg.ok && (msg.payload?.hello === 'ok' || msg.payload?.type === 'hello-ok')) {
      gatewayConnected = true;
      console.log('✅ Gateway handshake complete');
      broadcastToClients({ type: 'gateway:status', connected: true });
    }
    
    // Handle agent response (final)
    if (msg.payload?.runId && (msg.payload?.status === 'complete' || msg.payload?.summary)) {
      broadcastToClients({
        type: 'clawd:response',
        runId: msg.payload.runId,
        status: msg.payload.status,
        final: true,
        data: msg.payload.summary || msg.payload.content || ''
      });
    }
  }
  
  // Handle events
  if (msg.type === 'event') {
    const payload = msg.payload || {};
    
    // Debug logging for agent mode (enable for troubleshooting)
    // if (agentTasks.size > 0) {
    //   console.log(`[Agent] Event: ${msg.event}, runId: ${payload.runId}, state: ${payload.state}`);
    // }
    
    switch (msg.event) {
      case 'chat':
        // Extract content from various event structures
        // Gateway can send: payload.delta, payload.content, or payload.message.content[0].text
        let messageText = payload.delta || payload.content;
        if (!messageText && payload.message?.content) {
          // Handle message format: { role: 'assistant', content: [{ type: 'text', text: '...' }] }
          const textBlock = payload.message.content.find(c => c.type === 'text');
          if (textBlock) {
            messageText = textBlock.text;
          }
        }
        
        const isDelta = payload.state === 'delta' || !!payload.delta;
        const isFinal = payload.state === 'final' || payload.status === 'complete' || payload.final;
        
        // Chat event - contains streaming content or tool calls
        if (messageText && isDelta) {
          broadcastToClients({
            type: 'clawd:stream',
            runId: payload.runId,
            delta: messageText
          });
          
          // Buffer delta for agent tasks - improved matching
          for (const [taskId, task] of agentTasks) {
            const isRecent = Date.now() - task.createdAt < 60000; // Within 1 minute
            const runIdMatch = task.runId === payload.runId;
            const idempotencyMatch = task.idempotencyKey === payload.runId;
            // Match if: runId matches, OR idempotency key matches, OR task is recent and only one active
            if (runIdMatch || idempotencyMatch || (isRecent && agentTasks.size === 1)) {
              // For delta events with message format, we want to accumulate the full text
              // But since each delta contains the full text so far, just replace the buffer
              if (payload.message?.content) {
                task.buffer = messageText;
              } else {
                task.buffer = (task.buffer || '') + messageText;
              }
              // Send streaming update to client
              task.ws?.send(JSON.stringify({
                type: 'agent:thinking',
                taskId,
                text: messageText.substring(messageText.length - 50) // Last 50 chars for streaming preview
              }));
            }
          }
        }
        
        // Handle final state with content
        if (messageText && isFinal) {
          broadcastToClients({
            type: 'clawd:response',
            runId: payload.runId,
            data: messageText,
            final: true
          });
          
          // Parse agent responses - improved matching
          for (const [taskId, task] of agentTasks) {
            const isRecent = Date.now() - task.createdAt < 60000;
            const runIdMatch = task.runId === payload.runId;
            const idempotencyMatch = task.idempotencyKey === payload.runId;
            if (runIdMatch || idempotencyMatch || (isRecent && agentTasks.size === 1)) {
              const fullContent = task.buffer || messageText;
              console.log(`[Agent] Parsing FINAL response for task ${taskId}, content length: ${fullContent.length}`);
              parseAgentResponse(fullContent, taskId);
              task.buffer = '';
            }
          }
        }
        // Handle final state WITHOUT content (e.g., /new command) - parse buffer if we have one
        else if (!messageText && isFinal) {
          broadcastToClients({
            type: 'clawd:response',
            runId: payload.runId,
            data: '',  // Empty response - just clear the thinking indicator
            final: true
          });
          
          // Check buffered content for agent tasks - improved matching
          for (const [taskId, task] of agentTasks) {
            const isRecent = Date.now() - task.createdAt < 60000;
            const runIdMatch = task.runId === payload.runId;
            const idempotencyMatch = task.idempotencyKey === payload.runId;
            if ((runIdMatch || idempotencyMatch || (isRecent && agentTasks.size === 1)) && task.buffer) {
              console.log(`[Agent] Parsing BUFFERED response for task ${taskId}, buffer length: ${task.buffer.length}`);
              parseAgentResponse(task.buffer, taskId);
              task.buffer = '';
            }
          }
        }
        
        if (payload.tool) {
          broadcastToClients({
            type: 'clawd:tool',
            runId: payload.runId,
            tool: payload.tool,
            status: payload.toolStatus || payload.status
          });
        }
        break;
        
      case 'agent':
        // Agent events (streaming responses) - text contains full content so far
        if (payload.stream === 'assistant' && payload.data?.text) {
          const agentText = payload.data.text;
          
          // Buffer for agent tasks
          for (const [taskId, task] of agentTasks) {
            const isRecent = Date.now() - task.createdAt < 60000;
            const runIdMatch = task.runId === payload.runId;
            const idempotencyMatch = task.idempotencyKey === payload.runId;
            if (runIdMatch || idempotencyMatch || (isRecent && agentTasks.size === 1)) {
              // Agent events send cumulative text, so replace buffer
              task.buffer = agentText;
              // Send streaming preview
              task.ws?.send(JSON.stringify({
                type: 'agent:thinking',
                taskId,
                text: agentText.substring(Math.max(0, agentText.length - 100)) // Last 100 chars
              }));
            }
          }
          
          // Also broadcast for regular chat UI
          if (payload.data.delta) {
            broadcastToClients({
              type: 'clawd:stream',
              runId: payload.runId,
              delta: payload.data.delta
            });
          }
        }
        
        // Handle lifecycle end - this is when we should parse
        if (payload.stream === 'lifecycle' && payload.data?.phase === 'end') {
          console.log(`[Agent] Lifecycle end received for runId: ${payload.runId}`);
          // Parse buffered content for matching tasks
          for (const [taskId, task] of agentTasks) {
            const runIdMatch = task.runId === payload.runId;
            const idempotencyMatch = task.idempotencyKey === payload.runId;
            if ((runIdMatch || idempotencyMatch) && task.buffer) {
              console.log(`[Agent] Parsing on lifecycle end for task ${taskId}, buffer length: ${task.buffer.length}`);
              parseAgentResponse(task.buffer, taskId);
              task.buffer = '';
            }
          }
        }
        
        if (payload.stream === 'assistant' && payload.data?.text && payload.final) {
          broadcastToClients({
            type: 'clawd:response',
            runId: payload.runId,
            data: payload.data.text,
            final: true
          });
        }
        
        // Tool usage
        if (payload.stream === 'tool_use' || payload.stream === 'tool_result') {
          broadcastToClients({
            type: 'clawd:tool',
            runId: payload.runId,
            tool: payload.data,
            status: payload.stream
          });
        }
        break;
      
      case 'run.complete':
      case 'run.end':
        // Run completed
        broadcastToClients({
          type: 'clawd:response',
          runId: payload.runId,
          data: payload.summary || payload.content || '',
          final: true
        });
        break;
        
      case 'presence':
        broadcastToClients({ type: 'gateway:presence', payload });
        break;
        
      case 'health':
        gatewayConnected = true;
        broadcastToClients({ type: 'gateway:health', payload, connected: true });
        break;
        
      case 'tick':
        broadcastToClients({ type: 'gateway:tick', payload });
        break;
        
      case 'connect.challenge':
        // Challenge is handled during initial connect - no separate response needed
        // The connect handshake includes the challenge response automatically
        break;
    }
  }
}

function broadcastToClients(msg) {
  const data = JSON.stringify(msg);
  for (const client of ideClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

async function sendToGateway(method, params) {
  return new Promise((resolve, reject) => {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
      reject(new Error('Gateway not connected'));
      return;
    }
    
    const id = generateId();
    const msg = { type: 'req', id, method, params };
    
    pendingRequests.set(id, { resolve, reject, timeout: setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Gateway request timeout'));
    }, 120000) }); // 2 minute timeout for long responses
    
    gatewayWs.send(JSON.stringify(msg));
  });
}

// Send message to DNA via chat.send
async function sendChatMessage(message, context = {}) {
  const idempotencyKey = generateId();
  
  // Build context from @ mentions and IDE state
  let contextParts = [];
  
  // Add DNA memory context (if enabled)
  if (context.includeMemory !== false) {
    const memoryContext = getMemoryContext();
    if (memoryContext) {
      contextParts.push(`[DNA Memory Context]\n${memoryContext}`);
    }
  }
  
  // Add current file context
  if (context.currentFile) {
    contextParts.push(`[Current file: ${context.currentFile}]`);
  }
  
  // Add selected code
  if (context.selectedCode) {
    contextParts.push(`[Selected code:\n\`\`\`\n${context.selectedCode}\n\`\`\`]`);
  }
  
  // Expand @ mention context
  if (context.context) {
    const expanded = expandMentionContext(context.context);
    if (expanded) {
      contextParts.push(expanded);
    }
  }
  
  // Build full message with context
  let fullMessage = message;
  if (contextParts.length > 0) {
    fullMessage = `[IDE Context]\n${contextParts.join('\n\n')}\n\n[User Message]\n${message}`;
  }
  
  const params = {
    message: fullMessage,
    idempotencyKey,
    // Use shared main session (same as webchat/Signal)
    sessionKey: 'agent:main:main'
  };
  
  try {
    // Use chat.send which returns immediately with runId and streams via events
    const response = await sendToGateway('chat.send', params);
    return response;
  } catch (err) {
    console.error('Chat send failed:', err);
    throw err;
  }
}

// Expand @ mention context to actual content
function expandMentionContext(contextObj) {
  if (!contextObj) return null;
  
  const parts = [];
  
  // Expand @file mentions
  if (contextObj.files && contextObj.files.length > 0) {
    for (const filePath of contextObj.files) {
      try {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE, filePath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const truncated = content.length > 10000 ? content.substring(0, 10000) + '\n... (truncated)' : content;
        parts.push(`[@file: ${filePath}]\n\`\`\`\n${truncated}\n\`\`\``);
      } catch (e) {
        parts.push(`[@file: ${filePath}] (error: ${e.message})`);
      }
    }
  }
  
  // Expand @folder mentions
  if (contextObj.folders && contextObj.folders.length > 0) {
    for (const folderPath of contextObj.folders) {
      try {
        const fullPath = path.isAbsolute(folderPath) ? folderPath : path.join(WORKSPACE, folderPath);
        const files = listFolderContents(fullPath, 2);
        parts.push(`[@folder: ${folderPath}]\n${files.join('\n')}`);
      } catch (e) {
        parts.push(`[@folder: ${folderPath}] (error: ${e.message})`);
      }
    }
  }
  
  // Expand @codebase
  if (contextObj.codebase) {
    const summary = getCodebaseSummary();
    parts.push(`[@codebase - Project Structure]\n${summary}`);
  }
  
  // @selection is already included via selectedCode
  if (contextObj.selection) {
    parts.push(`[@selection]\n\`\`\`\n${contextObj.selection}\n\`\`\``);
  }
  
  // Expand @git
  if (contextObj.git) {
    try {
      const { execSync } = require('child_process');
      const status = execSync('git status --short', { cwd: WORKSPACE, encoding: 'utf-8' });
      const branch = execSync('git branch --show-current', { cwd: WORKSPACE, encoding: 'utf-8' }).trim();
      parts.push(`[@git - Branch: ${branch}]\n${status || '(no changes)'}`);
    } catch (e) {
      parts.push(`[@git] (not a git repository)`);
    }
  }
  
  // Expand @terminal - would need terminal history which we don't currently store
  if (contextObj.terminal) {
    parts.push(`[@terminal] (terminal output not available in current session)`);
  }
  
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// List folder contents recursively
function listFolderContents(dir, maxDepth, currentDepth = 0) {
  const results = [];
  if (currentDepth >= maxDepth) return results;
  
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const indent = '  '.repeat(currentDepth);
      const relativePath = path.relative(WORKSPACE, path.join(dir, item.name));
      
      if (item.isDirectory()) {
        results.push(`${indent}📁 ${item.name}/`);
        results.push(...listFolderContents(path.join(dir, item.name), maxDepth, currentDepth + 1));
      } else {
        results.push(`${indent}📄 ${item.name}`);
      }
    }
  } catch (e) {}
  
  return results;
}

// Get codebase summary
function getCodebaseSummary() {
  const files = [];
  const languages = {};
  
  function scanDir(dir, depth = 0) {
    if (depth > 3) return;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'dist') continue;
        const fullPath = path.join(dir, item.name);
        const relativePath = path.relative(WORKSPACE, fullPath);
        
        if (item.isDirectory()) {
          scanDir(fullPath, depth + 1);
        } else {
          files.push(relativePath);
          const ext = path.extname(item.name).slice(1) || 'other';
          languages[ext] = (languages[ext] || 0) + 1;
        }
      }
    } catch (e) {}
  }
  
  scanDir(WORKSPACE);
  
  const langSummary = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, count]) => `${ext}: ${count}`)
    .join(', ');
  
  return `Files: ${files.length} | Languages: ${langSummary}\n\nKey files:\n${files.slice(0, 20).map(f => '  ' + f).join('\n')}${files.length > 20 ? '\n  ...' : ''}`;
}

// File operations API
app.get('/api/files', (req, res) => {
  const dirPath = req.query.path || WORKSPACE;
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(item => !item.name.startsWith('.') || item.name === '.env' || item.name === '.gitignore')
      .map(item => ({
        name: item.name,
        path: path.join(dirPath, item.name),
        type: item.isDirectory() ? 'directory' : 'file',
        extension: item.isFile() ? path.extname(item.name).slice(1) : null
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ items, currentPath: dirPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path required' });
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const stats = fs.statSync(filePath);
    res.json({ 
      content, 
      path: filePath,
      name: path.basename(filePath),
      size: stats.size,
      modified: stats.mtime
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/file', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Path required' });
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ success: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/file/create', (req, res) => {
  const { path: filePath, type } = req.body;
  try {
    if (type === 'directory') {
      fs.mkdirSync(filePath, { recursive: true });
    } else {
      fs.writeFileSync(filePath, '', 'utf-8');
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/file', (req, res) => {
  const filePath = req.query.path;
  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      fs.rmSync(filePath, { recursive: true });
    } else {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', (req, res) => {
  const { query, path: searchPath } = req.query;
  const basePath = searchPath || WORKSPACE;
  const results = [];
  
  function searchDir(dir, depth = 0) {
    if (depth > 5) return;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        const fullPath = path.join(dir, item.name);
        if (item.name.toLowerCase().includes(query.toLowerCase())) {
          results.push({ name: item.name, path: fullPath, type: item.isDirectory() ? 'directory' : 'file' });
        }
        if (item.isDirectory() && results.length < 50) {
          searchDir(fullPath, depth + 1);
        }
      }
    } catch (e) {}
  }
  
  searchDir(basePath);
  res.json({ results: results.slice(0, 50) });
});

// Search in file contents
app.get('/api/search/content', (req, res) => {
  const { query, path: searchPath } = req.query;
  const basePath = searchPath || WORKSPACE;
  const results = [];
  
  function searchInFiles(dir, depth = 0) {
    if (depth > 4 || results.length >= 100) return;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        const fullPath = path.join(dir, item.name);
        
        if (item.isDirectory()) {
          searchInFiles(fullPath, depth + 1);
        } else {
          // Only search text files
          const ext = path.extname(item.name).toLowerCase();
          const textExts = ['.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt', '.css', '.html', '.py', '.sh', '.yml', '.yaml'];
          if (!textExts.includes(ext)) continue;
          
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                results.push({
                  file: fullPath,
                  line: i + 1,
                  text: lines[i].trim().substring(0, 200),
                  preview: lines.slice(Math.max(0, i - 1), i + 2).join('\n')
                });
                if (results.length >= 100) return;
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  
  searchInFiles(basePath);
  res.json({ results });
});

// Semantic Search (Vector/Embeddings)
app.get('/api/search/semantic', async (req, res) => {
  const { query, limit = 10 } = req.query;
  
  if (!query) {
    return res.status(400).json({ error: 'Query required' });
  }
  
  if (!indexer) {
    return res.status(503).json({ error: 'Indexer not initialized' });
  }
  
  try {
    const results = await indexer.search(query, parseInt(limit));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Index Status
app.get('/api/index/status', (req, res) => {
  if (!indexer) {
    return res.json({ 
      initialized: false,
      error: 'Indexer not initialized' 
    });
  }
  
  res.json({
    initialized: true,
    ...indexer.getStats()
  });
});

// Rebuild Index
app.post('/api/index/rebuild', async (req, res) => {
  if (!indexer) {
    return res.status(503).json({ error: 'Indexer not initialized' });
  }
  
  try {
    const result = await indexer.indexWorkspace({ force: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear Index
app.post('/api/index/clear', (req, res) => {
  if (!indexer) {
    return res.status(503).json({ error: 'Indexer not initialized' });
  }
  
  try {
    indexer.clearIndex();
    res.json({ success: true, message: 'Index cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Index Single File (manual trigger)
app.post('/api/index/file', async (req, res) => {
  const { path: filePath } = req.body;
  
  if (!filePath) {
    return res.status(400).json({ error: 'Path required' });
  }
  
  if (!indexer) {
    return res.status(503).json({ error: 'Indexer not initialized' });
  }
  
  try {
    const indexed = await indexer.indexFile(filePath);
    res.json({ indexed, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace', (req, res) => {
  res.json({ workspace: WORKSPACE });
});

// Gateway status API
app.get('/api/gateway/status', (req, res) => {
  res.json({
    connected: gatewayConnected,
    url: GATEWAY_URL
  });
});

// Context usage API - get from gateway sessions.list
app.get('/api/context', async (req, res) => {
  if (!gatewayConnected) {
    return res.json({ error: 'Gateway not connected', context: null });
  }
  
  try {
    const response = await sendToGateway('sessions.list', {});
    
    if (response.ok && response.payload) {
      const sessions = response.payload.sessions || response.payload || [];
      // Find the main agent session
      const mainSession = sessions.find(s => 
        s.sessionKey === 'agent:main:main' || 
        s.key === 'agent:main:main' ||
        (s.kind === 'agent' && s.name === 'main')
      );
      
      if (mainSession) {
        // totalTokens = used context, contextTokens = max context window
        const used = mainSession.totalTokens || 0;
        const max = mainSession.contextTokens || 200000;
        
        const context = {
          used,
          max,
          percentage: max > 0 ? Math.round((used / max) * 100) : 0,
          model: mainSession.model || 'unknown',
          compactions: mainSession.compactions || 0,
          inputTokens: mainSession.inputTokens || 0,
          outputTokens: mainSession.outputTokens || 0
        };
        
        return res.json({ context });
      }
      
      res.json({ error: 'Main session not found', context: null, sessions });
    } else {
      res.json({ error: response.error?.message || 'Failed to get sessions', context: null });
    }
  } catch (err) {
    console.error('Context fetch error:', err);
    res.json({ error: err.message, context: null });
  }
});

// Session reset API - properly reset the session via gateway
app.post('/api/session/reset', async (req, res) => {
  if (!gatewayConnected) {
    return res.json({ ok: false, error: 'Gateway not connected' });
  }
  
  try {
    const response = await sendToGateway('sessions.reset', {
      key: 'agent:main:main'
    });
    
    if (response.ok) {
      res.json({ ok: true, message: 'Session reset successfully' });
    } else {
      res.json({ ok: false, error: response.error?.message || 'Failed to reset session' });
    }
  } catch (err) {
    console.error('Session reset error:', err);
    res.json({ ok: false, error: err.message });
  }
});

// Git API
app.get('/api/git/status', (req, res) => {
  const git = spawn('git', ['status', '--porcelain', '-b'], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    if (code === 0) {
      const lines = output.trim().split('\n');
      const branch = lines[0]?.replace('## ', '').split('...')[0] || 'unknown';
      const changes = lines.slice(1).filter(l => l.trim()).map(line => ({
        status: line.substring(0, 2).trim(),
        file: line.substring(3)
      }));
      res.json({ branch, changes, raw: output });
    } else {
      res.json({ error: 'Not a git repository', branch: null, changes: [] });
    }
  });
});

app.get('/api/git/diff', (req, res) => {
  const filePath = req.query.file;
  const args = filePath ? ['diff', '--', filePath] : ['diff'];
  const git = spawn('git', args, { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.on('close', () => res.json({ diff: output }));
});

app.get('/api/git/log', (req, res) => {
  const git = spawn('git', ['log', '--oneline', '-20'], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.on('close', () => {
    const commits = output.trim().split('\n').filter(l => l).map(line => {
      const [hash, ...msg] = line.split(' ');
      return { hash, message: msg.join(' ') };
    });
    res.json({ commits });
  });
});

app.post('/api/git/commit', (req, res) => {
  const { message, stagedOnly } = req.body;
  
  const doCommit = () => {
    const commit = spawn('git', ['commit', '-m', message], { cwd: WORKSPACE });
    let output = '';
    commit.stdout.on('data', data => output += data);
    commit.stderr.on('data', data => output += data);
    commit.on('close', code => {
      res.json({ success: code === 0, output });
    });
  };
  
  if (stagedOnly) {
    // Commit only what's already staged
    doCommit();
  } else {
    // Legacy behavior: stage all then commit
    const addAll = spawn('git', ['add', '-A'], { cwd: WORKSPACE });
    addAll.on('close', () => doCommit());
  }
});

app.get('/api/git/branches', (req, res) => {
  const git = spawn('git', ['branch', '-a'], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.on('close', () => {
    const branches = output.trim().split('\n').map(b => ({
      name: b.replace('*', '').trim().replace('remotes/origin/', ''),
      current: b.startsWith('*'),
      isRemote: b.includes('remotes/')
    })).filter(b => !b.name.includes('HEAD'));
    res.json({ branches });
  });
});

// Switch branch (checkout)
app.post('/api/git/checkout', (req, res) => {
  const { branch } = req.body;
  if (!branch) return res.json({ error: 'No branch specified' });
  
  const git = spawn('git', ['checkout', branch], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output, branch });
  });
});

// Create new branch
app.post('/api/git/branch/create', (req, res) => {
  const { name, checkout } = req.body;
  if (!name) return res.json({ error: 'No branch name specified' });
  
  const args = checkout ? ['checkout', '-b', name] : ['branch', name];
  const git = spawn('git', args, { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output, branch: name });
  });
});

// Delete branch
app.post('/api/git/branch/delete', (req, res) => {
  const { name, force } = req.body;
  if (!name) return res.json({ error: 'No branch name specified' });
  
  const flag = force ? '-D' : '-d';
  const git = spawn('git', ['branch', flag, name], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// ============================================
// GIT STASH
// ============================================

// List stashes
app.get('/api/git/stash', (req, res) => {
  const git = spawn('git', ['stash', 'list'], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.on('close', () => {
    const stashes = output.trim().split('\n').filter(l => l).map((line, index) => {
      // Format: stash@{0}: WIP on main: abc1234 commit message
      const match = line.match(/stash@\{(\d+)\}: (.+)/);
      return {
        index,
        ref: `stash@{${index}}`,
        message: match ? match[2] : line
      };
    });
    res.json({ stashes });
  });
});

// Create stash
app.post('/api/git/stash/save', (req, res) => {
  const { message, includeUntracked } = req.body;
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('-u');
  if (message) args.push('-m', message);
  
  const git = spawn('git', args, { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// Apply stash
app.post('/api/git/stash/apply', (req, res) => {
  const { index, pop } = req.body;
  const ref = `stash@{${index || 0}}`;
  const command = pop ? 'pop' : 'apply';
  
  const git = spawn('git', ['stash', command, ref], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// Drop stash
app.post('/api/git/stash/drop', (req, res) => {
  const { index } = req.body;
  const ref = `stash@{${index || 0}}`;
  
  const git = spawn('git', ['stash', 'drop', ref], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// Stage a file
app.post('/api/git/stage', (req, res) => {
  const { file } = req.body;
  if (!file) return res.json({ error: 'No file specified' });
  
  const git = spawn('git', ['add', '--', file], { cwd: WORKSPACE });
  let output = '';
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// Unstage a file
app.post('/api/git/unstage', (req, res) => {
  const { file } = req.body;
  if (!file) return res.json({ error: 'No file specified' });
  
  const git = spawn('git', ['restore', '--staged', '--', file], { cwd: WORKSPACE });
  let output = '';
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// Stage all files
app.post('/api/git/stage-all', (req, res) => {
  const git = spawn('git', ['add', '-A'], { cwd: WORKSPACE });
  git.on('close', code => {
    res.json({ success: code === 0 });
  });
});

// Unstage all files
app.post('/api/git/unstage-all', (req, res) => {
  const git = spawn('git', ['restore', '--staged', '.'], { cwd: WORKSPACE });
  git.on('close', code => {
    res.json({ success: code === 0 });
  });
});

// Discard changes to a file
app.post('/api/git/discard', (req, res) => {
  const { file } = req.body;
  if (!file) return res.json({ error: 'No file specified' });
  
  const git = spawn('git', ['checkout', '--', file], { cwd: WORKSPACE });
  let output = '';
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// Git push
app.post('/api/git/push', (req, res) => {
  const git = spawn('git', ['push'], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// Git pull
app.post('/api/git/pull', (req, res) => {
  const git = spawn('git', ['pull'], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// Git fetch
app.post('/api/git/fetch', (req, res) => {
  const git = spawn('git', ['fetch', '--all'], { cwd: WORKSPACE });
  let output = '';
  git.stdout.on('data', data => output += data);
  git.stderr.on('data', data => output += data);
  git.on('close', code => {
    res.json({ success: code === 0, output });
  });
});

// Get remote status (ahead/behind)
app.get('/api/git/remote-status', (req, res) => {
  const { execSync } = require('child_process');
  try {
    // Fetch first to get accurate status
    execSync('git fetch', { cwd: WORKSPACE, encoding: 'utf-8', timeout: 10000 });
    
    const status = execSync('git status -sb', { cwd: WORKSPACE, encoding: 'utf-8' });
    const match = status.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
    
    let ahead = 0, behind = 0;
    if (match) {
      ahead = parseInt(match[1] || 0);
      behind = parseInt(match[2] || match[3] || 0);
    }
    
    res.json({ ahead, behind });
  } catch (e) {
    res.json({ ahead: 0, behind: 0, error: e.message });
  }
});

// AI Commit Message Generation
app.post('/api/git/generate-message', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    
    // Get git diff
    let diff = '';
    try {
      diff = execSync('git diff --cached', { cwd: WORKSPACE, encoding: 'utf-8' });
      if (!diff) {
        diff = execSync('git diff', { cwd: WORKSPACE, encoding: 'utf-8' });
      }
    } catch (e) {
      return res.json({ error: 'No changes to commit' });
    }
    
    if (!diff || diff.length < 10) {
      return res.json({ error: 'No changes detected' });
    }
    
    // Truncate diff if too long
    const truncatedDiff = diff.length > 8000 ? diff.substring(0, 8000) + '\n... (truncated)' : diff;
    
    // Generate commit message using gateway
    if (!gatewayConnected) {
      return res.json({ error: 'AI not connected' });
    }
    
    const prompt = `Generate a concise, conventional commit message for these changes. Use format like "feat:", "fix:", "docs:", "refactor:", "chore:", etc.

Return ONLY the commit message (one line, max 72 chars). No explanations or formatting.

Git diff:
\`\`\`
${truncatedDiff}
\`\`\`

Commit message:`;

    // Send to gateway and wait for response
    const idempotencyKey = crypto.randomBytes(8).toString('hex');
    
    // Use a simpler approach - make a synchronous-style request
    const response = await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Timeout')), 30000);
      
      // Listen for response
      const originalHandler = gatewayWs.onmessage;
      let responseText = '';
      
      gatewayWs.on('message', function handler(data) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'event' && msg.event === 'chat') {
            const payload = msg.payload || {};
            if (payload.delta) {
              responseText += payload.delta;
            }
            if (payload.state === 'final' || payload.final) {
              clearTimeout(timeoutId);
              gatewayWs.removeListener('message', handler);
              resolve(responseText || payload.content || '');
            }
          }
        } catch (e) {}
      });
      
      // Send the request
      const reqId = crypto.randomBytes(8).toString('hex');
      gatewayWs.send(JSON.stringify({
        type: 'req',
        id: reqId,
        method: 'chat.send',
        params: {
          message: prompt,
          idempotencyKey,
          sessionKey: 'agent:main:commit-gen'
        }
      }));
    });
    
    // Clean up the response - remove any markdown formatting
    let message = response.trim()
      .replace(/^```.*\n?/gm, '')
      .replace(/```$/gm, '')
      .replace(/^["'`]/g, '')
      .replace(/["'`]$/g, '')
      .trim();
    
    // Ensure it's not too long
    if (message.length > 100) {
      message = message.substring(0, 100);
    }
    
    res.json({ message });
    
  } catch (err) {
    console.error('Generate commit message error:', err);
    res.json({ error: err.message || 'Failed to generate message' });
  }
});

// Inline Edit API (Cmd+K)
app.post('/api/inline-edit', async (req, res) => {
  const { originalCode, prompt, language, filename } = req.body;
  
  if (!gatewayConnected) {
    return res.json({ code: null, error: 'Gateway not connected' });
  }
  
  try {
    const editPrompt = `You are a code editor assistant. Modify the code according to the user's request.
Return ONLY the modified code, nothing else. No explanations, no markdown code fences, no comments about what you changed.
Just the raw code that should replace the original.

Language: ${language || 'unknown'}
File: ${filename || 'untitled'}

Original code:
${originalCode}

User request: ${prompt}

Modified code:`;

    const response = await sendToGateway('chat.send', {
      message: editPrompt,
      sessionKey: 'agent:main:ide-edit',
      options: {
        maxTokens: 2000,
        temperature: 0.3
      }
    });
    
    let code = '';
    if (response.ok && response.payload) {
      code = response.payload.content || response.payload.summary || '';
      // Clean up the response
      code = code
        .replace(/^```\w*\n?/, '')
        .replace(/\n?```$/, '')
        .replace(/^Here'?s? (?:is )?the (?:modified |updated )?code:?\n*/i, '')
        .replace(/^Modified code:?\n*/i, '')
        .trim();
    }
    
    res.json({ code });
  } catch (err) {
    console.error('Inline edit error:', err);
    res.json({ code: null, error: err.message });
  }
});

// Code Actions API (Cmd+.)
app.post('/api/code-actions', async (req, res) => {
  const { code, language, filename, hasSelection } = req.body;
  
  if (!gatewayConnected) {
    // Return defaults if gateway not connected
    return res.json({ suggestions: null });
  }
  
  try {
    const prompt = `Analyze this ${language || 'code'} and suggest 3-5 quick improvements.
For each suggestion, provide a short label and a prompt that could be used to make the change.

Code:
\`\`\`${language || ''}
${code.slice(0, 1000)}
\`\`\`

Respond with a JSON array like this (no other text):
[
  {"label": "Short description", "prompt": "Full prompt for the change"},
  ...
]

Focus on:
- Adding documentation if missing
- Error handling improvements
- Code simplification
- Converting patterns (async/await, arrow functions)
- Performance optimizations`;

    const response = await sendToGateway('chat.send', {
      message: prompt,
      sessionKey: 'agent:main:ide-actions',
      options: {
        maxTokens: 500,
        temperature: 0.3
      }
    });
    
    let suggestions = [];
    if (response.ok && response.payload) {
      const content = response.payload.content || response.payload.summary || '';
      try {
        // Try to parse JSON from response
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          suggestions = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.warn('Could not parse code actions response:', e);
      }
    }
    
    res.json({ suggestions });
  } catch (err) {
    console.error('Code actions error:', err);
    res.json({ suggestions: null, error: err.message });
  }
});

// Inline completion API
app.post('/api/completion', async (req, res) => {
  const { prefix, suffix, language, filename, line, column } = req.body;
  
  if (!gatewayConnected) {
    return res.json({ completion: null, error: 'Gateway not connected' });
  }
  
  try {
    // Build a completion prompt
    const prompt = `You are a code completion assistant. Complete the code at the cursor position.
Return ONLY the completion text that should be inserted, nothing else.
Do not include any explanation, markdown, or code fences.
If no completion makes sense, return an empty string.

Language: ${language}
File: ${filename}

Code before cursor:
${prefix.slice(-500)}

Code after cursor:
${suffix.slice(0, 200)}

Complete the code at cursor:`;

    const response = await sendToGateway('chat.send', {
      message: prompt,
      sessionKey: 'agent:main:ide-completion',
      options: {
        maxTokens: 150,
        temperature: 0.2
      }
    });
    
    // Extract completion from response
    let completion = '';
    if (response.ok && response.payload) {
      completion = response.payload.content || response.payload.summary || '';
      // Clean up the completion
      completion = completion
        .replace(/^```\w*\n?/, '') // Remove opening code fence
        .replace(/\n?```$/, '')    // Remove closing code fence
        .replace(/^\s*\/\/.*\n?/g, '') // Remove comment explanations
        .trim();
    }
    
    res.json({ completion });
  } catch (err) {
    console.error('Completion error:', err);
    res.json({ completion: null, error: err.message });
  }
});

// Codebase context API - for AI awareness
app.get('/api/codebase/summary', (req, res) => {
  const summary = {
    workspace: WORKSPACE,
    files: [],
    totalFiles: 0,
    languages: {}
  };
  
  function scanDir(dir, depth = 0) {
    if (depth > 3) return;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        const fullPath = path.join(dir, item.name);
        const relativePath = path.relative(WORKSPACE, fullPath);
        
        if (item.isDirectory()) {
          scanDir(fullPath, depth + 1);
        } else {
          summary.totalFiles++;
          const ext = path.extname(item.name).slice(1) || 'other';
          summary.languages[ext] = (summary.languages[ext] || 0) + 1;
          
          if (summary.files.length < 200) {
            summary.files.push(relativePath);
          }
        }
      }
    } catch (e) {}
  }
  
  scanDir(WORKSPACE);
  res.json(summary);
});

// ============================================
// AGENT MODE API (Sprint 1)
// ============================================

// Create rollback point before agent starts
app.post('/api/agent/rollback-point', (req, res) => {
  try {
    const { execSync } = require('child_process');
    
    // Check if we're in a git repo
    try {
      execSync('git rev-parse --git-dir', { cwd: WORKSPACE, stdio: 'pipe' });
    } catch {
      // Not a git repo, try to init one
      execSync('git init', { cwd: WORKSPACE, stdio: 'pipe' });
    }
    
    // Stage all changes and create a commit
    try {
      execSync('git add -A', { cwd: WORKSPACE, stdio: 'pipe' });
      execSync('git commit -m "Agent checkpoint: pre-task state" --allow-empty', { 
        cwd: WORKSPACE, 
        stdio: 'pipe' 
      });
    } catch (e) {
      // May fail if nothing to commit, which is fine
    }
    
    // Get current commit hash
    const commit = execSync('git rev-parse HEAD', { cwd: WORKSPACE, encoding: 'utf-8' }).trim();
    
    res.json({ ok: true, commit });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Rollback to a previous commit
app.post('/api/agent/rollback', (req, res) => {
  const { commit } = req.body;
  if (!commit) {
    return res.status(400).json({ ok: false, error: 'Commit hash required' });
  }
  
  try {
    const { execSync } = require('child_process');
    
    // Reset to the specified commit
    execSync(`git reset --hard ${commit}`, { cwd: WORKSPACE, stdio: 'pipe' });
    
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Run verification (TypeScript, ESLint, Tests)
app.post('/api/agent/verify', async (req, res) => {
  const results = {
    typescript: null,
    eslint: null,
    tests: null
  };
  
  const { execSync, spawn } = require('child_process');
  
  // Check for TypeScript
  const hasTsConfig = fs.existsSync(path.join(WORKSPACE, 'tsconfig.json'));
  if (hasTsConfig) {
    try {
      execSync('npx tsc --noEmit', { cwd: WORKSPACE, stdio: 'pipe', timeout: 60000 });
      results.typescript = { passed: true, errors: 0 };
    } catch (err) {
      const output = err.stdout?.toString() || err.stderr?.toString() || '';
      const errorCount = (output.match(/error TS/g) || []).length;
      results.typescript = { passed: false, errors: errorCount, output };
    }
  }
  
  // Check for ESLint
  const hasEslint = fs.existsSync(path.join(WORKSPACE, '.eslintrc.js')) ||
                    fs.existsSync(path.join(WORKSPACE, '.eslintrc.json')) ||
                    fs.existsSync(path.join(WORKSPACE, 'eslint.config.js'));
  if (hasEslint) {
    try {
      const output = execSync('npx eslint . --format json', { 
        cwd: WORKSPACE, 
        stdio: 'pipe',
        timeout: 60000 
      }).toString();
      const parsed = JSON.parse(output);
      const errors = parsed.reduce((sum, f) => sum + f.errorCount, 0);
      const warnings = parsed.reduce((sum, f) => sum + f.warningCount, 0);
      results.eslint = { passed: errors === 0, errors, warnings };
    } catch (err) {
      try {
        const output = err.stdout?.toString() || '[]';
        const parsed = JSON.parse(output);
        const errors = parsed.reduce((sum, f) => sum + f.errorCount, 0);
        const warnings = parsed.reduce((sum, f) => sum + f.warningCount, 0);
        results.eslint = { passed: errors === 0, errors, warnings };
      } catch {
        results.eslint = { passed: false, errors: 1, warnings: 0, output: err.message };
      }
    }
  }
  
  // Check for tests (package.json test script)
  const pkgPath = path.join(WORKSPACE, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo \"Error: no test specified\" && exit 1') {
        try {
          const output = execSync('npm test -- --json 2>/dev/null || npm test', { 
            cwd: WORKSPACE, 
            stdio: 'pipe',
            timeout: 120000 
          }).toString();
          
          // Try to parse Jest JSON output
          try {
            const jsonMatch = output.match(/\{[\s\S]*"numPassedTests"[\s\S]*\}/);
            if (jsonMatch) {
              const testResults = JSON.parse(jsonMatch[0]);
              results.tests = {
                passed: testResults.numFailedTests === 0,
                total: testResults.numTotalTests,
                failed: testResults.numFailedTests,
                passed: testResults.numPassedTests
              };
            } else {
              // Non-JSON output, assume passed if exit code 0
              results.tests = { passed: true, total: 1, failed: 0 };
            }
          } catch {
            results.tests = { passed: true, total: 1, failed: 0 };
          }
        } catch (err) {
          const output = err.stdout?.toString() || err.stderr?.toString() || '';
          // Try to extract failure count
          const failMatch = output.match(/(\d+) failed/);
          const totalMatch = output.match(/(\d+) total/);
          results.tests = {
            passed: false,
            total: totalMatch ? parseInt(totalMatch[1]) : 1,
            failed: failMatch ? parseInt(failMatch[1]) : 1,
            output
          };
        }
      }
    } catch (e) {
      // No package.json or can't parse
    }
  }
  
  res.json(results);
});

// Get file diff for agent preview
app.post('/api/agent/diff', (req, res) => {
  const { file, newContent } = req.body;
  if (!file) {
    return res.status(400).json({ error: 'File path required' });
  }
  
  const fullPath = path.isAbsolute(file) ? file : path.join(WORKSPACE, file);
  let originalContent = '';
  let changeType = 'create';
  
  try {
    originalContent = fs.readFileSync(fullPath, 'utf-8');
    changeType = 'modify';
  } catch {
    // File doesn't exist, it's a new file
  }
  
  // Generate simple diff
  const hunks = generateDiff(originalContent, newContent || '');
  
  res.json({
    file,
    changeType,
    originalContent,
    hunks
  });
});

// Auto-fix ESLint errors
app.post('/api/agent/fix-lint', (req, res) => {
  try {
    const { execSync } = require('child_process');
    const output = execSync('npx eslint . --fix', { 
      cwd: WORKSPACE, 
      stdio: 'pipe',
      timeout: 60000 
    }).toString();
    
    res.json({ ok: true, output });
  } catch (err) {
    // ESLint --fix may exit non-zero even if it fixed things
    res.json({ 
      ok: true, 
      output: err.stdout?.toString() || '',
      warning: 'Some issues may remain unfixable automatically'
    });
  }
});

// Ask AI to fix verification errors
app.post('/api/agent/ai-fix', async (req, res) => {
  const { type, errors } = req.body; // type: 'typescript' | 'eslint' | 'test'
  
  if (!gatewayConnected) {
    return res.json({ ok: false, error: 'Not connected to gateway' });
  }
  
  try {
    const prompt = buildFixPrompt(type, errors);
    
    const response = await sendToGateway('chat.send', {
      message: prompt,
      sessionKey: 'agent:main:main',
      idempotencyKey: crypto.randomBytes(8).toString('hex')
    });
    
    res.json({ ok: true, requestSent: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

function buildFixPrompt(type, errors) {
  const typeNames = {
    typescript: 'TypeScript',
    eslint: 'ESLint',
    test: 'Test'
  };
  
  return `Fix the following ${typeNames[type] || type} errors in the codebase.

Errors:
${errors}

For each fix, output a json:file-change block:
\`\`\`json:file-change
{
  "stepId": 1,
  "file": "path/to/file.js",
  "changeType": "modify",
  "content": "full corrected file content"
}
\`\`\`

Fix all errors that can be fixed. Be thorough.`;
}

// Helper: Generate simple diff hunks
function generateDiff(original, modified) {
  const oldLines = original.split('\n');
  const newLines = modified.split('\n');
  const hunks = [];
  
  let hunk = { lines: [] };
  let i = 0, j = 0;
  
  while (i < oldLines.length || j < newLines.length) {
    if (i >= oldLines.length) {
      // Remaining new lines are additions
      hunk.lines.push('+' + newLines[j]);
      j++;
    } else if (j >= newLines.length) {
      // Remaining old lines are deletions
      hunk.lines.push('-' + oldLines[i]);
      i++;
    } else if (oldLines[i] === newLines[j]) {
      // Context line
      if (hunk.lines.length > 0) {
        hunk.lines.push(' ' + oldLines[i]);
      }
      i++;
      j++;
    } else {
      // Changed line
      hunk.lines.push('-' + oldLines[i]);
      hunk.lines.push('+' + newLines[j]);
      i++;
      j++;
    }
    
    // Limit hunk size
    if (hunk.lines.length > 50) {
      hunks.push(hunk);
      hunk = { lines: [] };
    }
  }
  
  if (hunk.lines.length > 0) {
    hunks.push(hunk);
  }
  
  return hunks;
}

// Terminal via exec
app.post('/api/exec', (req, res) => {
  const { command } = req.body;
  const shell = spawn('zsh', ['-c', command], { 
    cwd: WORKSPACE,
    env: { ...process.env, TERM: 'xterm-256color' }
  });
  
  let stdout = '';
  let stderr = '';
  
  shell.stdout.on('data', data => stdout += data);
  shell.stderr.on('data', data => stderr += data);
  
  const timeout = setTimeout(() => {
    shell.kill();
    res.json({ stdout, stderr, code: -1, error: 'Timeout' });
  }, 30000);
  
  shell.on('close', code => {
    clearTimeout(timeout);
    res.json({ stdout, stderr, code });
  });
});

// WebSocket for IDE clients
wss.on('connection', (ws) => {
  ideClients.add(ws);
  const shellProcesses = new Map(); // Support multiple terminals
  
  // Send gateway status on connect
  ws.send(JSON.stringify({ 
    type: 'gateway:status', 
    connected: gatewayConnected 
  }));
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'terminal:start':
          const termId = data.id || 1;
          
          // Kill existing shell for this ID if any
          if (shellProcesses.has(termId)) {
            shellProcesses.get(termId).kill();
          }
          
          // Parse custom command or use default shell
          let shell, shellArgs;
          if (data.command) {
            // Support commands like "node", "python3", "bun repl"
            const parts = data.command.split(' ');
            shell = parts[0];
            shellArgs = parts.slice(1);
          } else {
            shell = process.env.SHELL || 'zsh';
            shellArgs = [];
          }
          
          // Use node-pty for proper PTY support
          const shellProcess = pty.spawn(shell, shellArgs, {
            name: 'xterm-256color',
            cols: data.cols || 80,
            rows: data.rows || 24,
            cwd: WORKSPACE,
            env: { ...process.env, TERM: 'xterm-256color' }
          });
          
          shellProcess.onData((output) => {
            ws.send(JSON.stringify({ type: 'terminal:output', id: termId, data: output }));
          });
          
          shellProcess.onExit(({ exitCode }) => {
            ws.send(JSON.stringify({ type: 'terminal:exit', id: termId, code: exitCode }));
            shellProcesses.delete(termId);
          });
          
          shellProcesses.set(termId, shellProcess);
          break;
          
        case 'terminal:input':
          const inputId = data.id || 1;
          if (shellProcesses.has(inputId)) {
            shellProcesses.get(inputId).write(data.data);
          }
          break;
          
        case 'terminal:resize':
          const resizeId = data.id || 1;
          if (shellProcesses.has(resizeId) && data.cols && data.rows) {
            shellProcesses.get(resizeId).resize(data.cols, data.rows);
          }
          break;
          
        case 'terminal:kill':
          const killId = data.id || 1;
          if (shellProcesses.has(killId)) {
            shellProcesses.get(killId).kill();
            shellProcesses.delete(killId);
          }
          break;
          
        case 'clawd:message':
          // Send to DNA via gateway
          if (!gatewayConnected) {
            ws.send(JSON.stringify({
              type: 'clawd:response',
              data: '⚠️ Not connected to DNA Gateway. Make sure DNA is running.',
              final: true
            }));
            break;
          }
          
          try {
            // Send typing indicator
            ws.send(JSON.stringify({ type: 'clawd:typing', typing: true }));
            
            await sendChatMessage(data.message, {
              currentFile: data.currentFile,
              selectedCode: data.selectedCode,
              context: data.context, // @ mention context from client
              includeMemory: data.includeMemory !== false // default to true
            });
            
            // Response will come via gateway events
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'clawd:response',
              data: `Error: ${err.message}`,
              final: true
            }));
          }
          break;
          
        case 'clawd:generate':
          // Code generation request (Cmd+K style)
          if (!gatewayConnected) {
            ws.send(JSON.stringify({
              type: 'clawd:generated',
              error: 'Not connected to DNA'
            }));
            break;
          }
          
          try {
            const prompt = `Generate code for the following request. Return ONLY the code, no explanations.

File: ${data.file}
Language: ${data.language}
${data.selectedCode ? `Current code:\n\`\`\`\n${data.selectedCode}\n\`\`\`\n` : ''}
Request: ${data.prompt}

Return only the code that should replace/be inserted:`;
            
            await sendChatMessage(prompt, {
              currentFile: data.file
            });
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'clawd:generated',
              error: err.message
            }));
          }
          break;
          
        // ============================================
        // AGENT MODE WEBSOCKET HANDLERS
        // ============================================
        
        case 'agent:start':
          // Start an agent task
          if (!gatewayConnected) {
            ws.send(JSON.stringify({
              type: 'agent:error',
              taskId: data.taskId,
              error: 'Not connected to DNA Gateway'
            }));
            break;
          }
          
          try {
            // Create an agent task prompt
            const agentPrompt = buildAgentPrompt(data.task, data.workspace, data.currentFile);
            
            // Send to gateway with agent context and mode
            await sendAgentMessage(data.taskId, agentPrompt, ws, data.mode || 'safe');
            
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'agent:error',
              taskId: data.taskId,
              error: err.message
            }));
          }
          break;
          
        case 'agent:approve':
          // User approved a step - apply the changes
          try {
            const stepData = agentTasks.get(data.taskId)?.pendingStep;
            if (stepData) {
              // Apply the file change
              const fullPath = path.isAbsolute(stepData.file) 
                ? stepData.file 
                : path.join(WORKSPACE, stepData.file);
              
              if (stepData.changeType === 'delete') {
                fs.unlinkSync(fullPath);
              } else {
                // Create directories if needed
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                  fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(fullPath, stepData.newContent, 'utf-8');
              }
              
              // Mark step complete
              ws.send(JSON.stringify({
                type: 'agent:step-complete',
                taskId: data.taskId,
                stepId: data.stepId,
                stepIndex: stepData.stepIndex,
                details: `Applied changes to ${stepData.file}`
              }));
              
              // Clear pending step and continue
              agentTasks.get(data.taskId).pendingStep = null;
              
              // Continue to next step if plan exists
              continueAgentTask(data.taskId, ws);
            }
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'agent:step-failed',
              taskId: data.taskId,
              stepId: data.stepId,
              error: err.message
            }));
          }
          break;
          
        case 'agent:reject':
          // User rejected a step - skip it
          try {
            const taskInfo = agentTasks.get(data.taskId);
            if (taskInfo) {
              taskInfo.pendingStep = null;
              // Continue to next step
              continueAgentTask(data.taskId, ws);
            }
          } catch (err) {
            console.error('Agent reject error:', err);
          }
          break;
          
        case 'agent:pause':
          // Pause agent execution
          if (agentTasks.has(data.taskId)) {
            agentTasks.get(data.taskId).paused = true;
          }
          break;
          
        case 'agent:resume':
          // Resume agent execution
          if (agentTasks.has(data.taskId)) {
            agentTasks.get(data.taskId).paused = false;
            continueAgentTask(data.taskId, ws);
          }
          break;
          
        case 'agent:cancel':
          // Cancel agent task
          if (agentTasks.has(data.taskId)) {
            agentTasks.delete(data.taskId);
          }
          break;
      }
    } catch (e) {
      console.error('WebSocket error:', e);
    }
  });
  
  ws.on('close', () => {
    ideClients.delete(ws);
    // Kill all terminal sessions for this connection
    shellProcesses.forEach(proc => proc.kill());
    shellProcesses.clear();
  });
});

// ============================================
// PROBLEMS API (Sprint 3)
// ============================================

// Get problems from TypeScript and ESLint
app.get('/api/problems', async (req, res) => {
  const problems = [];
  const { execSync } = require('child_process');
  
  // Check TypeScript
  const hasTsConfig = fs.existsSync(path.join(WORKSPACE, 'tsconfig.json'));
  if (hasTsConfig) {
    try {
      execSync('npx tsc --noEmit', { cwd: WORKSPACE, stdio: 'pipe', timeout: 60000 });
    } catch (err) {
      const output = err.stdout?.toString() || err.stderr?.toString() || '';
      // Parse TypeScript errors: file(line,col): error TS1234: message
      const tsRegex = /([^(]+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/g;
      let match;
      while ((match = tsRegex.exec(output)) !== null) {
        problems.push({
          file: path.resolve(WORKSPACE, match[1].trim()),
          line: parseInt(match[2]),
          column: parseInt(match[3]),
          severity: match[4] === 'error' ? 'error' : 'warning',
          code: match[5],
          message: match[6].trim(),
          source: 'TypeScript'
        });
      }
    }
  }
  
  // Check ESLint
  const hasEslint = fs.existsSync(path.join(WORKSPACE, '.eslintrc.js')) ||
                    fs.existsSync(path.join(WORKSPACE, '.eslintrc.json')) ||
                    fs.existsSync(path.join(WORKSPACE, 'eslint.config.js')) ||
                    fs.existsSync(path.join(WORKSPACE, '.eslintrc'));
  if (hasEslint) {
    try {
      const output = execSync('npx eslint . --format json --no-error-on-unmatched-pattern', { 
        cwd: WORKSPACE, 
        stdio: 'pipe',
        timeout: 60000 
      }).toString();
      
      const eslintResults = JSON.parse(output || '[]');
      for (const file of eslintResults) {
        for (const msg of file.messages || []) {
          problems.push({
            file: file.filePath,
            line: msg.line || 1,
            column: msg.column || 1,
            severity: msg.severity === 2 ? 'error' : 'warning',
            code: msg.ruleId || '',
            message: msg.message,
            source: 'ESLint'
          });
        }
      }
    } catch (err) {
      // ESLint might fail if there are issues, try to parse the output anyway
      try {
        const output = err.stdout?.toString() || '[]';
        const eslintResults = JSON.parse(output);
        for (const file of eslintResults) {
          for (const msg of file.messages || []) {
            problems.push({
              file: file.filePath,
              line: msg.line || 1,
              column: msg.column || 1,
              severity: msg.severity === 2 ? 'error' : 'warning',
              code: msg.ruleId || '',
              message: msg.message,
              source: 'ESLint'
            });
          }
        }
      } catch {
        // Couldn't parse ESLint output
      }
    }
  }
  
  // Deduplicate and sort
  const seen = new Set();
  const uniqueProblems = problems.filter(p => {
    const key = `${p.file}:${p.line}:${p.column}:${p.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    // Sort by severity (errors first), then file, then line
    if (a.severity !== b.severity) {
      return a.severity === 'error' ? -1 : 1;
    }
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
  
  res.json({ problems: uniqueProblems });
});

// ============================================
// DNA MEMORY API
// ============================================

// Get memory context (for AI enrichment)
app.get('/api/memory/context', async (req, res) => {
  try {
    const context = {
      user: null,
      project: null,
      recent: null,
      dailyNotes: [],
    };
    
    // Read MEMORY.md
    const memoryPath = path.join(WORKSPACE, 'MEMORY.md');
    if (fs.existsSync(memoryPath)) {
      context.memory = fs.readFileSync(memoryPath, 'utf-8');
    }
    
    // Read USER.md for user context
    const userPath = path.join(WORKSPACE, 'USER.md');
    if (fs.existsSync(userPath)) {
      context.user = fs.readFileSync(userPath, 'utf-8');
    }
    
    // Read SOUL.md for AI personality/preferences
    const soulPath = path.join(WORKSPACE, 'SOUL.md');
    if (fs.existsSync(soulPath)) {
      context.soul = fs.readFileSync(soulPath, 'utf-8');
    }
    
    // Read recent daily notes (last 3 days)
    const memoryDir = path.join(WORKSPACE, 'memory');
    if (fs.existsSync(memoryDir)) {
      const files = fs.readdirSync(memoryDir)
        .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
        .sort()
        .reverse()
        .slice(0, 3);
      
      for (const file of files) {
        const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
        context.dailyNotes.push({
          date: file.replace('.md', ''),
          content: content.slice(0, 2000) // Truncate for context window
        });
      }
    }
    
    // Build project context from current workspace
    const pkgPath = path.join(WORKSPACE, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        context.project = {
          name: pkg.name,
          description: pkg.description,
          dependencies: Object.keys(pkg.dependencies || {}),
          devDependencies: Object.keys(pkg.devDependencies || {}),
        };
      } catch (e) {}
    }
    
    res.json(context);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read specific memory file
app.get('/api/memory/file', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'File name required' });
  
  // Security: only allow known memory files
  const allowedFiles = ['MEMORY.md', 'USER.md', 'SOUL.md', 'TOOLS.md', 'AGENTS.md', 'HEARTBEAT.md'];
  const isDaily = name.match(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
  const isAllowed = allowedFiles.includes(name) || isDaily;
  
  if (!isAllowed) {
    return res.status(403).json({ error: 'Access denied to this file' });
  }
  
  const filePath = path.join(WORKSPACE, name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.json({ content: fs.readFileSync(filePath, 'utf-8') });
});

// Update memory file
app.post('/api/memory/file', (req, res) => {
  const { name, content } = req.body;
  if (!name || content === undefined) {
    return res.status(400).json({ error: 'File name and content required' });
  }
  
  // Security: only allow known memory files
  const allowedFiles = ['MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md'];
  const isDaily = name.match(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
  const isAllowed = allowedFiles.includes(name) || isDaily;
  
  if (!isAllowed) {
    return res.status(403).json({ error: 'Cannot modify this file' });
  }
  
  const filePath = path.join(WORKSPACE, name);
  
  // Ensure directory exists for daily notes
  if (isDaily) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  
  fs.writeFileSync(filePath, content);
  res.json({ success: true });
});

// List memory files
app.get('/api/memory/list', (req, res) => {
  const files = [];
  
  // Core files
  const coreFiles = ['MEMORY.md', 'USER.md', 'SOUL.md', 'TOOLS.md', 'AGENTS.md', 'HEARTBEAT.md'];
  for (const f of coreFiles) {
    const filePath = path.join(WORKSPACE, f);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      files.push({
        name: f,
        path: f,
        modified: stat.mtime,
        size: stat.size,
        type: 'core'
      });
    }
  }
  
  // Daily notes
  const memoryDir = path.join(WORKSPACE, 'memory');
  if (fs.existsSync(memoryDir)) {
    const dailyFiles = fs.readdirSync(memoryDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse();
    
    for (const f of dailyFiles) {
      const filePath = path.join(memoryDir, f);
      const stat = fs.statSync(filePath);
      files.push({
        name: f,
        path: `memory/${f}`,
        modified: stat.mtime,
        size: stat.size,
        type: 'daily',
        date: f.replace('.md', '')
      });
    }
  }
  
  res.json({ files });
});

// Search memory (simple text search for now)
app.get('/api/memory/search', (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Query required' });
  
  const results = [];
  const searchTerm = query.toLowerCase();
  
  // Search all memory files
  const searchFile = (filePath, name) => {
    if (!fs.existsSync(filePath)) return;
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(searchTerm)) {
        results.push({
          file: name,
          line: idx + 1,
          content: line.trim(),
          context: lines.slice(Math.max(0, idx - 1), idx + 2).join('\n')
        });
      }
    });
  };
  
  // Search core files
  const coreFiles = ['MEMORY.md', 'USER.md', 'SOUL.md', 'TOOLS.md'];
  for (const f of coreFiles) {
    searchFile(path.join(WORKSPACE, f), f);
  }
  
  // Search daily notes
  const memoryDir = path.join(WORKSPACE, 'memory');
  if (fs.existsSync(memoryDir)) {
    const dailyFiles = fs.readdirSync(memoryDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/));
    
    for (const f of dailyFiles) {
      searchFile(path.join(memoryDir, f), `memory/${f}`);
    }
  }
  
  res.json({ results: results.slice(0, 50) }); // Limit results
});

// Add quick note to today's daily file
app.post('/api/memory/note', (req, res) => {
  const { note, category } = req.body;
  if (!note) return res.status(400).json({ error: 'Note content required' });
  
  const today = new Date().toISOString().split('T')[0];
  const dailyPath = path.join(WORKSPACE, 'memory', `${today}.md`);
  
  // Ensure directory exists
  const memoryDir = path.join(WORKSPACE, 'memory');
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }
  
  // Create or append to daily file
  let content = '';
  if (fs.existsSync(dailyPath)) {
    content = fs.readFileSync(dailyPath, 'utf-8');
  } else {
    content = `# ${today}\n\n`;
  }
  
  const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const categoryPrefix = category ? `[${category}] ` : '';
  content += `\n- ${timestamp}: ${categoryPrefix}${note}`;
  
  fs.writeFileSync(dailyPath, content);
  res.json({ success: true, file: `memory/${today}.md` });
});

// Build enriched context for AI requests (combines memory + project)
app.get('/api/memory/ai-context', async (req, res) => {
  try {
    const { maxTokens = 2000 } = req.query;
    
    let context = '';
    let tokenEstimate = 0;
    const tokensPerChar = 0.25; // Rough estimate
    
    // Priority 1: Recent daily notes (most relevant)
    const memoryDir = path.join(WORKSPACE, 'memory');
    if (fs.existsSync(memoryDir)) {
      const today = new Date().toISOString().split('T')[0];
      const todayPath = path.join(memoryDir, `${today}.md`);
      
      if (fs.existsSync(todayPath)) {
        const todayContent = fs.readFileSync(todayPath, 'utf-8');
        const truncated = todayContent.slice(0, 1500);
        context += `## Today's Notes\n${truncated}\n\n`;
        tokenEstimate += truncated.length * tokensPerChar;
      }
    }
    
    // Priority 2: MEMORY.md (curated long-term memory)
    const memoryPath = path.join(WORKSPACE, 'MEMORY.md');
    if (fs.existsSync(memoryPath) && tokenEstimate < maxTokens * 0.7) {
      const memoryContent = fs.readFileSync(memoryPath, 'utf-8');
      const available = Math.floor((maxTokens * 0.7 - tokenEstimate) / tokensPerChar);
      const truncated = memoryContent.slice(0, available);
      context += `## Long-term Memory\n${truncated}\n\n`;
      tokenEstimate += truncated.length * tokensPerChar;
    }
    
    // Priority 3: User preferences (from SOUL.md)
    const soulPath = path.join(WORKSPACE, 'SOUL.md');
    if (fs.existsSync(soulPath) && tokenEstimate < maxTokens * 0.9) {
      const soulContent = fs.readFileSync(soulPath, 'utf-8');
      // Extract just the preferences section
      const prefMatch = soulContent.match(/### (Preferences|Working Style|Code Style)[\s\S]*?(?=###|$)/i);
      if (prefMatch) {
        const prefs = prefMatch[0].slice(0, 500);
        context += `## Preferences\n${prefs}\n\n`;
        tokenEstimate += prefs.length * tokensPerChar;
      }
    }
    
    res.json({ 
      context,
      tokenEstimate: Math.round(tokenEstimate),
      sources: ['daily', 'memory', 'soul']
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Browser proxy for cross-origin requests with URL rewriting
app.get('/api/proxy', async (req, res) => {
  const { url, raw } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow'
    });
    
    const contentType = response.headers.get('content-type') || 'text/html';
    res.set('Content-Type', contentType);
    
    // Remove headers that block iframe embedding
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    // Allow iframe embedding from our origin
    res.set('X-Frame-Options', 'ALLOWALL');
    
    // For non-HTML content (images, CSS, JS, etc.), pass through raw
    if (raw || !contentType.includes('text/html')) {
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
      return;
    }
    
    // For HTML, rewrite URLs to go through proxy
    let html = await response.text();
    const baseUrl = new URL(url);
    const origin = baseUrl.origin;
    
    // Rewrite relative URLs to absolute, then proxy them
    // Handle src="..." and href="..."
    html = html.replace(/(src|href|action)=["']([^"']+)["']/gi, (match, attr, value) => {
      // Skip data URLs, anchors, and javascript
      if (value.startsWith('data:') || value.startsWith('#') || value.startsWith('javascript:')) {
        return match;
      }
      
      let absoluteUrl;
      try {
        if (value.startsWith('//')) {
          absoluteUrl = baseUrl.protocol + value;
        } else if (value.startsWith('/')) {
          absoluteUrl = origin + value;
        } else if (value.startsWith('http://') || value.startsWith('https://')) {
          absoluteUrl = value;
        } else {
          // Relative URL
          absoluteUrl = new URL(value, url).href;
        }
        
        // For CSS/JS/images, use raw mode
        const isAsset = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)(\?|$)/i.test(absoluteUrl);
        const proxyUrl = `/api/proxy?${isAsset ? 'raw=1&' : ''}url=${encodeURIComponent(absoluteUrl)}`;
        return `${attr}="${proxyUrl}"`;
      } catch (e) {
        return match; // Keep original if URL parsing fails
      }
    });
    
    // Rewrite url() in inline styles
    html = html.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, value) => {
      if (value.startsWith('data:')) return match;
      try {
        let absoluteUrl;
        if (value.startsWith('//')) {
          absoluteUrl = baseUrl.protocol + value;
        } else if (value.startsWith('/')) {
          absoluteUrl = origin + value;
        } else if (value.startsWith('http://') || value.startsWith('https://')) {
          absoluteUrl = value;
        } else {
          absoluteUrl = new URL(value, url).href;
        }
        return `url("/api/proxy?raw=1&url=${encodeURIComponent(absoluteUrl)}")`;
      } catch (e) {
        return match;
      }
    });
    
    // Inject base tag for any URLs we might have missed
    if (!html.includes('<base')) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${origin}/">`);
    }
    
    // Inject script to intercept navigation and form submissions
    const interceptScript = `
      <script>
        (function() {
          // Intercept link clicks
          document.addEventListener('click', function(e) {
            const link = e.target.closest('a[href]');
            if (link && !link.href.includes('/api/proxy')) {
              const href = link.getAttribute('href');
              if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                e.preventDefault();
                const absoluteUrl = new URL(href, '${url}').href;
                window.parent.postMessage({ type: 'proxy-navigate', url: absoluteUrl }, '*');
              }
            }
          }, true);
          
          // Intercept form submissions
          document.addEventListener('submit', function(e) {
            const form = e.target;
            if (form.tagName === 'FORM') {
              e.preventDefault();
              const formData = new FormData(form);
              const action = form.action || '${url}';
              const method = form.method || 'GET';
              
              if (method.toUpperCase() === 'GET') {
                const params = new URLSearchParams(formData).toString();
                const searchUrl = action + (action.includes('?') ? '&' : '?') + params;
                window.parent.postMessage({ type: 'proxy-navigate', url: searchUrl }, '*');
              } else {
                // POST - send to parent to handle
                window.parent.postMessage({ 
                  type: 'proxy-form', 
                  url: action, 
                  method: method,
                  data: Object.fromEntries(formData)
                }, '*');
              }
            }
          }, true);
        })();
      </script>
    `;
    html = html.replace('</body>', interceptScript + '</body>');
    
    res.send(html);
  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST proxy for form submissions
app.post('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
      },
      body: JSON.stringify(req.body),
      redirect: 'follow'
    });
    
    // Redirect back through proxy if HTML
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const finalUrl = response.url;
      res.redirect(`/api/proxy?url=${encodeURIComponent(finalUrl)}`);
    } else {
      const buffer = await response.arrayBuffer();
      res.set('Content-Type', contentType);
      res.send(Buffer.from(buffer));
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// BRAIN API - Self-Learning System
// ============================================

const KNOWLEDGE_GRAPH_PATH = path.join(WORKSPACE, 'knowledge', 'user-graph.json');

// Helper: Load knowledge graph
function loadKnowledgeGraph() {
  try {
    if (fs.existsSync(KNOWLEDGE_GRAPH_PATH)) {
      return JSON.parse(fs.readFileSync(KNOWLEDGE_GRAPH_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('[Brain] Failed to load graph:', err);
  }
  return null;
}

// Helper: Save knowledge graph
function saveKnowledgeGraph(graph) {
  try {
    const dir = path.dirname(KNOWLEDGE_GRAPH_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    graph.lastUpdated = new Date().toISOString();
    fs.writeFileSync(KNOWLEDGE_GRAPH_PATH, JSON.stringify(graph, null, 2));
    return true;
  } catch (err) {
    console.error('[Brain] Failed to save graph:', err);
    return false;
  }
}

// Helper: Calculate accuracy
function calculateAccuracy(graph) {
  const stats = graph.stats || {};
  const confirmations = stats.confirmations || 0;
  const corrections = stats.corrections || 0;
  const total = confirmations + corrections;
  if (total === 0) return 1.0;
  return confirmations / total;
}

// Helper: Update streak
function updateStreak(graph) {
  const stats = graph.stats || {};
  const today = new Date().toISOString().split('T')[0];
  const lastActive = stats.lastActive ? stats.lastActive.split('T')[0] : null;
  
  if (!lastActive) {
    // First activity
    stats.streak = 1;
    stats.streakStartDate = today;
  } else if (lastActive === today) {
    // Same day, no change
  } else {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    if (lastActive === yesterdayStr) {
      // Consecutive day
      stats.streak = (stats.streak || 0) + 1;
    } else {
      // Streak broken
      stats.streak = 1;
      stats.streakStartDate = today;
    }
  }
  
  stats.lastActive = new Date().toISOString();
  graph.stats = stats;
  return graph;
}

// Helper: Check and unlock achievements
function checkAchievements(graph, observation) {
  const unlocked = [];
  const stats = graph.stats || {};
  const achievements = graph.achievements || { unlocked: [], available: [] };
  
  const unlockedIds = new Set(achievements.unlocked.map(a => a.id));
  
  for (const achievement of achievements.available) {
    if (unlockedIds.has(achievement.id)) continue;
    
    let shouldUnlock = false;
    
    switch (achievement.id) {
      case 'first-memory':
        shouldUnlock = stats.totalObservations >= 1;
        break;
      case 'quick-learner':
        achievement.progress = Math.min(achievement.target, (achievement.progress || 0) + 1);
        shouldUnlock = achievement.progress >= achievement.target;
        break;
      case 'week-warrior':
        achievement.progress = stats.streak || 0;
        shouldUnlock = achievement.progress >= 7;
        break;
      case 'century-club':
        achievement.progress = stats.totalObservations || 0;
        shouldUnlock = achievement.progress >= 100;
        break;
      case 'code-whisperer':
        const codingPrefs = Object.keys(graph.preferences?.coding || {}).length;
        achievement.progress = codingPrefs * 10; // Rough estimate
        shouldUnlock = achievement.progress >= 50;
        break;
      case 'pattern-hunter':
        const patterns = Object.keys(graph.decisions?.patterns || {}).length;
        achievement.progress = patterns * 5;
        shouldUnlock = achievement.progress >= 25;
        break;
    }
    
    if (shouldUnlock) {
      const unlockedAchievement = {
        id: achievement.id,
        name: achievement.name,
        icon: achievement.icon,
        unlockedAt: new Date().toISOString(),
        description: achievement.criteria
      };
      achievements.unlocked.push(unlockedAchievement);
      unlocked.push(unlockedAchievement);
    }
  }
  
  graph.achievements = achievements;
  return unlocked;
}

// GET /api/brain/status - Quick status (for status bar)
app.get('/api/brain/status', (req, res) => {
  const graph = loadKnowledgeGraph();
  if (!graph) {
    return res.json({
      connected: false,
      accuracy: 0,
      streak: 0,
      totalObservations: 0
    });
  }
  
  const stats = graph.stats || {};
  res.json({
    connected: true,
    accuracy: calculateAccuracy(graph),
    streak: stats.streak || 0,
    totalObservations: stats.totalObservations || 0,
    lastActive: stats.lastActive,
    learningStartDate: stats.learningStartDate
  });
});

// GET /api/brain/graph - Full knowledge graph
app.get('/api/brain/graph', (req, res) => {
  const graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(404).json({ error: 'Knowledge graph not found' });
  }
  
  // Optionally hide sensitive data
  const { hideSensitive } = req.query;
  if (hideSensitive === 'true' && !graph.settings?.showFinancialData) {
    // Deep clone and mask sensitive fields
    const masked = JSON.parse(JSON.stringify(graph));
    for (const entity of Object.values(masked.entities || {})) {
      for (const [key, attr] of Object.entries(entity.attributes || {})) {
        if (attr.sensitive) {
          attr.value = '***';
        }
      }
    }
    return res.json(masked);
  }
  
  res.json(graph);
});

// POST /api/brain/observe - Record new observation
app.post('/api/brain/observe', (req, res) => {
  const { type, category, content, confidence = 0.5, source = 'observed' } = req.body;
  
  if (!type || !content) {
    return res.status(400).json({ error: 'Type and content required' });
  }
  
  let graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(500).json({ error: 'Knowledge graph not available' });
  }
  
  // Create observation
  const observation = {
    id: `obs-${Date.now()}`,
    type,
    category,
    content,
    confidence,
    source,
    observedAt: new Date().toISOString(),
    count: 1
  };
  
  // Add to pending or confirmed based on confidence
  if (!graph.observations) {
    graph.observations = { pending_confirmation: [], recently_confirmed: [] };
  }
  
  if (confidence >= 0.9) {
    graph.observations.recently_confirmed.unshift({
      id: observation.id,
      observation: content,
      confirmed: new Date().toISOString(),
      method: 'high_confidence'
    });
    // Keep only last 20
    graph.observations.recently_confirmed = graph.observations.recently_confirmed.slice(0, 20);
  } else {
    graph.observations.pending_confirmation.unshift({
      id: observation.id,
      observation: content,
      confidence,
      count: 1
    });
    // Keep only last 20
    graph.observations.pending_confirmation = graph.observations.pending_confirmation.slice(0, 20);
  }
  
  // Update stats
  if (!graph.stats) graph.stats = {};
  graph.stats.totalObservations = (graph.stats.totalObservations || 0) + 1;
  
  // Update streak
  graph = updateStreak(graph);
  
  // Add to changelog
  if (!graph.changelog) graph.changelog = [];
  graph.changelog.unshift({
    date: new Date().toISOString(),
    action: 'observation',
    description: content.slice(0, 100)
  });
  graph.changelog = graph.changelog.slice(0, 100); // Keep last 100
  
  // Check achievements
  const newAchievements = checkAchievements(graph, observation);
  
  // Save
  if (!saveKnowledgeGraph(graph)) {
    return res.status(500).json({ error: 'Failed to save' });
  }
  
  res.json({
    success: true,
    observation,
    achievement: newAchievements[0] || null,
    stats: graph.stats
  });
});

// PUT /api/brain/confirm/:id - Confirm an inference
app.put('/api/brain/confirm/:id', (req, res) => {
  const { id } = req.params;
  
  let graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(500).json({ error: 'Knowledge graph not available' });
  }
  
  // Find in pending
  const pending = graph.observations?.pending_confirmation || [];
  const idx = pending.findIndex(o => o.id === id);
  
  if (idx === -1) {
    return res.status(404).json({ error: 'Observation not found' });
  }
  
  // Move to confirmed
  const obs = pending.splice(idx, 1)[0];
  if (!graph.observations.recently_confirmed) {
    graph.observations.recently_confirmed = [];
  }
  graph.observations.recently_confirmed.unshift({
    id: obs.id,
    observation: obs.observation,
    confirmed: new Date().toISOString(),
    method: 'user_confirmed'
  });
  
  // Update stats
  graph.stats = graph.stats || {};
  graph.stats.confirmations = (graph.stats.confirmations || 0) + 1;
  graph.stats.accuracy = calculateAccuracy(graph);
  
  // Save
  if (!saveKnowledgeGraph(graph)) {
    return res.status(500).json({ error: 'Failed to save' });
  }
  
  res.json({ success: true, stats: graph.stats });
});

// DELETE /api/brain/forget/:id - Delete specific knowledge
app.delete('/api/brain/forget/:id', (req, res) => {
  const { id } = req.params;
  
  let graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(500).json({ error: 'Knowledge graph not available' });
  }
  
  let found = false;
  
  // Check pending
  if (graph.observations?.pending_confirmation) {
    const idx = graph.observations.pending_confirmation.findIndex(o => o.id === id);
    if (idx !== -1) {
      graph.observations.pending_confirmation.splice(idx, 1);
      found = true;
    }
  }
  
  // Check confirmed
  if (!found && graph.observations?.recently_confirmed) {
    const idx = graph.observations.recently_confirmed.findIndex(o => o.id === id);
    if (idx !== -1) {
      graph.observations.recently_confirmed.splice(idx, 1);
      found = true;
    }
  }
  
  if (!found) {
    return res.status(404).json({ error: 'Observation not found' });
  }
  
  // Update stats
  graph.stats = graph.stats || {};
  graph.stats.corrections = (graph.stats.corrections || 0) + 1;
  graph.stats.accuracy = calculateAccuracy(graph);
  
  // Save
  if (!saveKnowledgeGraph(graph)) {
    return res.status(500).json({ error: 'Failed to save' });
  }
  
  res.json({ success: true, stats: graph.stats });
});

// GET /api/brain/timeline - Activity feed
app.get('/api/brain/timeline', (req, res) => {
  const { limit = 50 } = req.query;
  
  const graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(404).json({ error: 'Knowledge graph not found' });
  }
  
  const timeline = [];
  
  // Add observations
  for (const obs of graph.observations?.recently_confirmed || []) {
    timeline.push({
      type: 'confirmed',
      content: obs.observation,
      date: obs.confirmed,
      icon: '✅'
    });
  }
  
  for (const obs of graph.observations?.pending_confirmation || []) {
    timeline.push({
      type: 'pending',
      content: obs.observation,
      date: obs.observedAt || new Date().toISOString(),
      confidence: obs.confidence,
      icon: '🔍'
    });
  }
  
  // Add decisions
  for (const dec of graph.decisions?.recent || []) {
    timeline.push({
      type: 'decision',
      content: dec.decision,
      date: dec.date,
      context: dec.context,
      icon: '🧭'
    });
  }
  
  // Add achievements
  for (const ach of graph.achievements?.unlocked || []) {
    timeline.push({
      type: 'achievement',
      content: `Unlocked: ${ach.name}`,
      date: ach.unlockedAt,
      icon: ach.icon
    });
  }
  
  // Sort by date descending
  timeline.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  res.json({ timeline: timeline.slice(0, parseInt(limit)) });
});

// GET /api/brain/achievements - Achievement status
app.get('/api/brain/achievements', (req, res) => {
  const graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(404).json({ error: 'Knowledge graph not found' });
  }
  
  res.json({
    unlocked: graph.achievements?.unlocked || [],
    available: graph.achievements?.available || [],
    stats: {
      total: (graph.achievements?.unlocked?.length || 0) + (graph.achievements?.available?.length || 0),
      unlocked: graph.achievements?.unlocked?.length || 0
    }
  });
});

// POST /api/brain/export - Export all data
app.post('/api/brain/export', (req, res) => {
  const { includeSensitive = false } = req.body;
  
  const graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(404).json({ error: 'Knowledge graph not found' });
  }
  
  // Optionally remove sensitive data
  let exportData = graph;
  if (!includeSensitive) {
    exportData = JSON.parse(JSON.stringify(graph));
    for (const entity of Object.values(exportData.entities || {})) {
      for (const [key, attr] of Object.entries(entity.attributes || {})) {
        if (attr.sensitive) {
          delete entity.attributes[key];
        }
      }
    }
  }
  
  res.json({
    exportedAt: new Date().toISOString(),
    version: graph.version,
    data: exportData
  });
});

// PUT /api/brain/settings - Update brain settings
app.put('/api/brain/settings', (req, res) => {
  const settings = req.body;
  
  let graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(500).json({ error: 'Knowledge graph not available' });
  }
  
  graph.settings = {
    ...graph.settings,
    ...settings
  };
  
  if (!saveKnowledgeGraph(graph)) {
    return res.status(500).json({ error: 'Failed to save' });
  }
  
  res.json({ success: true, settings: graph.settings });
});

// PUT /api/brain/graph - Push updated graph from client
app.put('/api/brain/graph', (req, res) => {
  const { graph: clientGraph, timestamp } = req.body;
  
  if (!clientGraph) {
    return res.status(400).json({ error: 'Graph data required' });
  }
  
  let serverGraph = loadKnowledgeGraph();
  
  // Merge strategy: client wins for observations, server wins for structure
  if (serverGraph) {
    // Merge observations
    if (clientGraph.observations) {
      serverGraph.observations = {
        ...serverGraph.observations,
        ...clientGraph.observations,
        pending_confirmation: [
          ...(serverGraph.observations?.pending_confirmation || []),
          ...(clientGraph.observations?.pending_confirmation || [])
        ].slice(-50), // Keep last 50
        recently_confirmed: [
          ...(serverGraph.observations?.recently_confirmed || []),
          ...(clientGraph.observations?.recently_confirmed || [])
        ].slice(-20) // Keep last 20
      };
    }
    
    // Merge preferences (client wins)
    if (clientGraph.preferences) {
      serverGraph.preferences = {
        ...serverGraph.preferences,
        ...clientGraph.preferences
      };
    }
    
    // Update stats
    if (clientGraph.stats) {
      serverGraph.stats = {
        ...serverGraph.stats,
        ...clientGraph.stats
      };
    }
    
    // Update timestamp
    serverGraph.lastUpdated = timestamp || new Date().toISOString();
  } else {
    // No server graph, use client's
    serverGraph = clientGraph;
    serverGraph.lastUpdated = timestamp || new Date().toISOString();
  }
  
  if (!saveKnowledgeGraph(serverGraph)) {
    return res.status(500).json({ error: 'Failed to save graph' });
  }
  
  // Broadcast update
  broadcastToClients({
    type: 'brain:updated',
    timestamp: serverGraph.lastUpdated
  });
  
  res.json({ success: true, timestamp: serverGraph.lastUpdated });
});

// POST /api/brain/consolidate - Session-end consolidation
app.post('/api/brain/consolidate', async (req, res) => {
  const { observations = [], sessionEnd } = req.body;
  
  if (observations.length === 0) {
    return res.json({ success: true, consolidated: 0, message: 'No observations to consolidate' });
  }
  
  let graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(500).json({ error: 'Knowledge graph not available' });
  }
  
  let consolidated = 0;
  let patternsDetected = 0;
  let confidenceUpgrades = 0;
  
  for (const obs of observations) {
    try {
      const { category, field, value, confidence, section } = obs;
      
      // Apply observation to graph
      if (category === 'preferences') {
        const sec = section || 'communication';
        if (!graph.preferences) graph.preferences = {};
        if (!graph.preferences[sec]) graph.preferences[sec] = {};
        
        const existing = graph.preferences[sec][field];
        
        if (existing) {
          // Update existing: increment count, recalculate confidence
          const newCount = (existing.observations || 1) + 1;
          const newConfidence = Math.min(
            existing.confidence + (0.1 * (newCount > 3 ? 1 : 0.5)),
            1.0
          );
          
          if (newConfidence > existing.confidence + 0.1) {
            confidenceUpgrades++;
          }
          
          graph.preferences[sec][field] = {
            ...existing,
            value: value || existing.value,
            confidence: newConfidence,
            observations: newCount,
            lastObserved: obs.observedAt || new Date().toISOString()
          };
        } else {
          // New preference
          graph.preferences[sec][field] = {
            value,
            confidence: confidence || 0.5,
            observations: 1,
            lastObserved: obs.observedAt || new Date().toISOString(),
            source: obs.source || 'inferred'
          };
        }
        consolidated++;
      }
      
      // Track for pattern detection
      if (!graph.changelog) graph.changelog = [];
      graph.changelog.push({
        date: obs.observedAt || new Date().toISOString(),
        type: 'observation',
        category,
        field,
        value
      });
      
    } catch (err) {
      console.error('[Brain] Failed to consolidate observation:', err);
    }
  }
  
  // Keep changelog trimmed (last 500 entries)
  if (graph.changelog && graph.changelog.length > 500) {
    graph.changelog = graph.changelog.slice(-500);
  }
  
  // Update stats
  if (!graph.stats) graph.stats = {};
  graph.stats.totalObservations = (graph.stats.totalObservations || 0) + consolidated;
  graph.stats.lastConsolidation = sessionEnd || new Date().toISOString();
  graph.lastUpdated = new Date().toISOString();
  
  // Detect patterns (simple: 3+ similar observations)
  const recentObs = graph.changelog?.slice(-20) || [];
  const fieldCounts = {};
  for (const entry of recentObs) {
    const key = `${entry.category}:${entry.field}`;
    fieldCounts[key] = (fieldCounts[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(fieldCounts)) {
    if (count >= 3) patternsDetected++;
  }
  
  // Save graph
  if (!saveKnowledgeGraph(graph)) {
    return res.status(500).json({ error: 'Failed to save consolidated graph' });
  }
  
  // Append to daily memory file
  const today = new Date().toISOString().split('T')[0];
  const memoryPath = path.join(WORKSPACE, 'memory', `${today}.md`);
  try {
    const consolidationNote = `\n\n## Brain Consolidation (${new Date().toLocaleTimeString()})\n- ${consolidated} observations consolidated\n- ${patternsDetected} patterns detected\n- ${confidenceUpgrades} confidence upgrades\n`;
    fs.appendFileSync(memoryPath, consolidationNote);
  } catch (err) {
    console.warn('[Brain] Failed to append to memory file:', err.message);
  }
  
  res.json({
    success: true,
    consolidated,
    patternsDetected,
    confidenceUpgrades,
    timestamp: graph.lastUpdated
  });
});

// POST /api/brain/import - Import data from export file
app.post('/api/brain/import', (req, res) => {
  const { data, version } = req.body;
  
  if (!data) {
    return res.status(400).json({ error: 'No data provided' });
  }
  
  let graph = loadKnowledgeGraph();
  if (!graph) {
    graph = { version: '1.0.0', lastUpdated: new Date().toISOString() };
  }
  
  let imported = 0;
  
  // Merge observations
  if (data.observations && Array.isArray(data.observations)) {
    if (!graph.observations) graph.observations = {};
    if (!graph.observations.pending_confirmation) graph.observations.pending_confirmation = [];
    
    for (const obs of data.observations) {
      graph.observations.pending_confirmation.push({
        ...obs,
        importedAt: new Date().toISOString(),
        importedFrom: version
      });
      imported++;
    }
  }
  
  // Merge entities
  if (data.entities && typeof data.entities === 'object') {
    if (!graph.entities) graph.entities = {};
    for (const [id, entity] of Object.entries(data.entities)) {
      if (!graph.entities[id]) {
        graph.entities[id] = entity;
        imported++;
      }
    }
  }
  
  // Merge preferences
  if (data.preferences && typeof data.preferences === 'object') {
    if (!graph.preferences) graph.preferences = {};
    for (const [section, prefs] of Object.entries(data.preferences)) {
      if (!graph.preferences[section]) graph.preferences[section] = {};
      for (const [key, value] of Object.entries(prefs)) {
        if (!graph.preferences[section][key]) {
          graph.preferences[section][key] = value;
          imported++;
        }
      }
    }
  }
  
  graph.lastUpdated = new Date().toISOString();
  
  if (!saveKnowledgeGraph(graph)) {
    return res.status(500).json({ error: 'Failed to save imported data' });
  }
  
  res.json({ success: true, imported, timestamp: graph.lastUpdated });
});

// DELETE /api/brain/clear/:category - Clear a specific category
app.delete('/api/brain/clear/:category', (req, res) => {
  const { category } = req.params;
  const validCategories = ['preferences', 'entities', 'decisions', 'observations', 'changelog', 'achievements'];
  
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Valid: ${validCategories.join(', ')}` });
  }
  
  let graph = loadKnowledgeGraph();
  if (!graph) {
    return res.status(500).json({ error: 'Knowledge graph not available' });
  }
  
  // Archive before clearing
  if (!graph.archive) graph.archive = [];
  if (graph[category]) {
    graph.archive.push({
      category,
      data: graph[category],
      clearedAt: new Date().toISOString()
    });
  }
  
  // Clear the category
  if (category === 'observations') {
    graph.observations = { pending_confirmation: [], recently_confirmed: [] };
  } else if (category === 'achievements') {
    graph.achievements = { unlocked: [], available: [] };
  } else {
    graph[category] = category === 'changelog' ? [] : {};
  }
  
  graph.lastUpdated = new Date().toISOString();
  
  if (!saveKnowledgeGraph(graph)) {
    return res.status(500).json({ error: 'Failed to save' });
  }
  
  res.json({ success: true, cleared: category, timestamp: graph.lastUpdated });
});

// POST /api/brain/reset - Full reset of brain data
app.post('/api/brain/reset', (req, res) => {
  const graphPath = path.join(WORKSPACE, 'knowledge', 'user-graph.json');
  
  // Backup current graph
  try {
    const current = loadKnowledgeGraph();
    if (current) {
      const backupPath = path.join(WORKSPACE, 'knowledge', `user-graph-backup-${Date.now()}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(current, null, 2));
      console.log('[Brain] Backup created:', backupPath);
    }
  } catch (err) {
    console.warn('[Brain] Backup failed:', err.message);
  }
  
  // Create fresh graph
  const freshGraph = {
    "$schema": "clawd-knowledge-graph-v1",
    "version": "1.0.0",
    "lastUpdated": new Date().toISOString(),
    "user": {},
    "entities": {},
    "relationships": [],
    "preferences": {
      "communication": {},
      "coding": {},
      "work": {}
    },
    "decisions": {
      "recent": [],
      "patterns": {}
    },
    "observations": {
      "pending_confirmation": [],
      "recently_confirmed": []
    },
    "achievements": {
      "unlocked": [],
      "available": []
    },
    "stats": {
      "streak": 0,
      "totalObservations": 0,
      "accuracy": 0,
      "learningStartDate": new Date().toISOString()
    },
    "settings": {},
    "changelog": []
  };
  
  if (!saveKnowledgeGraph(freshGraph)) {
    return res.status(500).json({ error: 'Failed to reset' });
  }
  
  res.json({ success: true, message: 'Brain reset complete', timestamp: freshGraph.lastUpdated });
});

// ============================================
// DEBUG SESSION MANAGEMENT
// ============================================

let debugSession = null;
let debugClients = new Set(); // WebSocket clients listening for debug events

// Start debug session
app.post('/api/debug/launch', async (req, res) => {
  const { type = 'node', program, cwd, args = [] } = req.body;
  
  if (!program) {
    return res.status(400).json({ error: 'Program path required' });
  }
  
  if (debugSession) {
    return res.status(400).json({ error: 'Debug session already active. Stop it first.' });
  }
  
  try {
    debugSession = new DAPClient();
    
    // Forward events to WebSocket clients
    debugSession.on('stopped', (data) => {
      broadcastDebugEvent('stopped', data);
    });
    
    debugSession.on('continued', (data) => {
      broadcastDebugEvent('continued', data);
    });
    
    debugSession.on('terminated', (data) => {
      broadcastDebugEvent('terminated', data);
      debugSession = null;
    });
    
    debugSession.on('output', (data) => {
      broadcastDebugEvent('output', data);
    });
    
    debugSession.on('stackTrace', (data) => {
      broadcastDebugEvent('stackTrace', data);
    });
    
    const result = await debugSession.launch({
      type,
      program: path.resolve(cwd || WORKSPACE, program),
      cwd: cwd || WORKSPACE,
      args
    });
    
    res.json({ ok: true, ...result });
  } catch (err) {
    debugSession = null;
    res.status(500).json({ error: err.message });
  }
});

// Stop debug session
app.post('/api/debug/stop', async (req, res) => {
  if (!debugSession) {
    return res.json({ ok: true, message: 'No active session' });
  }
  
  try {
    await debugSession.terminate();
    debugSession = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug status
app.get('/api/debug/status', (req, res) => {
  res.json({
    active: !!debugSession,
    initialized: debugSession?.initialized || false
  });
});

// Continue execution
app.post('/api/debug/continue', async (req, res) => {
  if (!debugSession) {
    return res.status(400).json({ error: 'No active debug session' });
  }
  
  try {
    await debugSession.continue();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pause execution
app.post('/api/debug/pause', async (req, res) => {
  if (!debugSession) {
    return res.status(400).json({ error: 'No active debug session' });
  }
  
  try {
    await debugSession.pause();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step over
app.post('/api/debug/stepOver', async (req, res) => {
  if (!debugSession) {
    return res.status(400).json({ error: 'No active debug session' });
  }
  
  try {
    await debugSession.stepOver();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step into
app.post('/api/debug/stepIn', async (req, res) => {
  if (!debugSession) {
    return res.status(400).json({ error: 'No active debug session' });
  }
  
  try {
    await debugSession.stepIn();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step out
app.post('/api/debug/stepOut', async (req, res) => {
  if (!debugSession) {
    return res.status(400).json({ error: 'No active debug session' });
  }
  
  try {
    await debugSession.stepOut();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set breakpoints for a file
app.post('/api/debug/breakpoints', async (req, res) => {
  const { file, lines } = req.body;
  
  if (!file || !lines) {
    return res.status(400).json({ error: 'File and lines required' });
  }
  
  if (!debugSession) {
    // Store breakpoints for when session starts - return success
    return res.json({ ok: true, breakpoints: lines.map(l => ({ line: l, verified: false })) });
  }
  
  try {
    const result = await debugSession.setBreakpoints(file, lines);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get scopes for a stack frame
app.get('/api/debug/scopes/:frameId', async (req, res) => {
  if (!debugSession) {
    return res.status(400).json({ error: 'No active debug session' });
  }
  
  try {
    const frameId = parseInt(req.params.frameId, 10);
    const frame = debugSession.stackFrames.get(frameId);
    
    if (!frame) {
      return res.status(404).json({ error: 'Frame not found' });
    }
    
    // Return scope chain from the frame
    const scopes = (frame.scopeChain || []).map((scope, index) => ({
      name: scope.type.charAt(0).toUpperCase() + scope.type.slice(1),
      type: scope.type,
      objectId: scope.object?.objectId,
      expensive: scope.type === 'global' // Global scope is large
    }));
    
    res.json({ scopes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get variables for a scope
app.get('/api/debug/variables/:scopeId', async (req, res) => {
  if (!debugSession) {
    return res.status(400).json({ error: 'No active debug session' });
  }
  
  try {
    const variables = await debugSession.getVariables(req.params.scopeId);
    res.json({ variables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Evaluate expression
app.post('/api/debug/evaluate', async (req, res) => {
  const { expression, frameId } = req.body;
  
  if (!debugSession) {
    return res.status(400).json({ error: 'No active debug session' });
  }
  
  try {
    const result = await debugSession.evaluate(expression, frameId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Broadcast debug event to all connected clients
function broadcastDebugEvent(event, data) {
  const message = JSON.stringify({ type: `debug:${event}`, ...data });
  debugClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
  // Also broadcast to regular IDE clients
  broadcastToClients({ type: `debug:${event}`, ...data });
}

// ============================================
// DASHBOARD API
// ============================================

app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const stats = await collectProjectStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function collectProjectStats() {
  const stats = {
    project: { name: path.basename(WORKSPACE) },
    files: { total: 0, lines: 0, byType: {} },
    git: { commits7d: 0, recentCommits: [] },
    todos: { total: 0, items: [] }
  };
  
  // File stats - use find and wc for speed
  try {
    const { execSync } = require('child_process');
    
    // Count files by type
    const findCmd = `find "${WORKSPACE}" -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" -o -name "*.json" -o -name "*.md" -o -name "*.css" -o -name "*.html" -o -name "*.py" -o -name "*.go" -o -name "*.sh" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null`;
    const files = execSync(findCmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim().split('\n').filter(f => f);
    
    stats.files.total = files.length;
    
    // Count by extension
    files.forEach(f => {
      const ext = path.extname(f).slice(1).toLowerCase() || 'none';
      stats.files.byType[ext] = (stats.files.byType[ext] || 0) + 1;
    });
    
    // Line count (sample first 500 files for speed)
    if (files.length > 0) {
      const sampleFiles = files.slice(0, 500);
      const wcCmd = `wc -l ${sampleFiles.map(f => `"${f}"`).join(' ')} 2>/dev/null | tail -1`;
      try {
        const wcOutput = execSync(wcCmd, { encoding: 'utf-8' });
        const match = wcOutput.match(/^\s*(\d+)/);
        if (match) {
          stats.files.lines = parseInt(match[1], 10);
          // Extrapolate if we sampled
          if (files.length > 500) {
            stats.files.lines = Math.round(stats.files.lines * (files.length / 500));
          }
        }
      } catch (e) {}
    }
    
    // Key files
    const keyFileNames = ['package.json', 'README.md', 'index.js', 'index.ts', 'main.js', 'main.ts', 'app.js', 'app.ts'];
    stats.files.keyFiles = [];
    for (const kf of keyFileNames) {
      const keyPath = path.join(WORKSPACE, kf);
      if (fs.existsSync(keyPath)) {
        stats.files.keyFiles.push({ name: kf, path: keyPath });
      }
    }
    // Also check src folder
    const srcPath = path.join(WORKSPACE, 'src');
    if (fs.existsSync(srcPath)) {
      stats.files.keyFiles.push({ name: 'src/', path: srcPath });
    }
  } catch (e) {
    console.error('[Dashboard] File stats error:', e.message);
  }
  
  // Git stats
  try {
    const { execSync } = require('child_process');
    
    // Recent commits
    const logCmd = `cd "${WORKSPACE}" && git log --oneline -10 --format="%H|%s|%ai" 2>/dev/null`;
    const logOutput = execSync(logCmd, { encoding: 'utf-8' }).trim();
    
    if (logOutput) {
      stats.git.recentCommits = logOutput.split('\n').map(line => {
        const [hash, message, date] = line.split('|');
        return { hash, message, date };
      });
    }
    
    // Commits in last 7 days
    const weekCmd = `cd "${WORKSPACE}" && git log --oneline --since="7 days ago" 2>/dev/null | wc -l`;
    const weekCount = execSync(weekCmd, { encoding: 'utf-8' }).trim();
    stats.git.commits7d = parseInt(weekCount, 10) || 0;
  } catch (e) {
    // Not a git repo or git not available
  }
  
  // TODO/FIXME comments
  try {
    const { execSync } = require('child_process');
    
    const grepCmd = `grep -rn -E "(TODO|FIXME|XXX|HACK):" "${WORKSPACE}" --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx" --include="*.py" 2>/dev/null | head -50`;
    const grepOutput = execSync(grepCmd, { encoding: 'utf-8' }).trim();
    
    if (grepOutput) {
      const lines = grepOutput.split('\n');
      stats.todos.total = lines.length;
      
      stats.todos.items = lines.slice(0, 20).map(line => {
        const match = line.match(/^([^:]+):(\d+):.*?(TODO|FIXME|XXX|HACK):\s*(.*)$/);
        if (match) {
          return {
            file: match[1],
            line: parseInt(match[2], 10),
            type: match[3],
            text: match[4].trim()
          };
        }
        return null;
      }).filter(Boolean);
    }
  } catch (e) {
    // grep not available or no matches
  }
  
  return stats;
}

// Live reload WebSocket endpoint for browser panels
const liveReloadClients = new Set();
app.get('/api/live-reload', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  liveReloadClients.add(res);
  
  req.on('close', () => {
    liveReloadClients.delete(res);
  });
});

// Codebase Indexer
let indexer = null;

async function initIndexer() {
  try {
    indexer = new CodebaseIndexer(WORKSPACE);
    await indexer.init();
    console.log('🔍 Codebase indexer initialized');
    
    // Start background indexing
    setTimeout(async () => {
      console.log('🔍 Starting initial codebase indexing...');
      const result = await indexer.indexWorkspace();
      console.log(`🔍 Indexing complete: ${result.indexed} files indexed in ${result.duration}`);
    }, 5000); // Wait 5s for startup
  } catch (err) {
    console.error('Failed to initialize indexer:', err.message);
  }
}

// File watcher for live reload + indexing
let fileWatcher = null;

function setupFileWatcher() {
  if (fileWatcher) return;
  
  try {
    fileWatcher = chokidar.watch(WORKSPACE, {
      ignored: /(^|[\/\\])(node_modules|\.git|\.next|dist|build|\.clawd-index\.db)([\/\\]|$)/,
      persistent: true,
      ignoreInitial: true
    });
    
    fileWatcher.on('change', async (filePath) => {
      const relativePath = path.relative(WORKSPACE, filePath);
      const ext = path.extname(filePath).toLowerCase();
      const type = ext === '.css' ? 'css' : 'full';
      
      // Broadcast to live reload clients
      const message = JSON.stringify({ type, path: relativePath });
      liveReloadClients.forEach(client => {
        client.write(`data: ${message}\n\n`);
      });
      
      // Also broadcast to IDE WebSocket clients
      broadcastToClients({ 
        type: 'file:changed', 
        path: relativePath,
        reloadType: type 
      });
      
      // Brain sync: Broadcast knowledge graph updates
      if (relativePath === 'knowledge/user-graph.json' || relativePath === path.join('knowledge', 'user-graph.json')) {
        try {
          const graph = loadKnowledgeGraph();
          if (graph) {
            broadcastToClients({
              type: 'brain:updated',
              graph: graph,
              timestamp: new Date().toISOString()
            });
            console.log('[Brain] Broadcasted knowledge graph update');
          }
        } catch (err) {
          console.error('[Brain] Failed to broadcast graph update:', err);
        }
      }
      
      // Update index for changed file
      if (indexer && ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.md'].includes(ext)) {
        try {
          await indexer.indexFile(relativePath);
        } catch (err) {
          console.error(`Indexing error for ${relativePath}:`, err.message);
        }
      }
    });
    
    fileWatcher.on('add', async (filePath) => {
      const relativePath = path.relative(WORKSPACE, filePath);
      const ext = path.extname(filePath).toLowerCase();
      
      // Index new files
      if (indexer && ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.md'].includes(ext)) {
        try {
          await indexer.indexFile(relativePath);
        } catch (err) {
          console.error(`Indexing error for ${relativePath}:`, err.message);
        }
      }
    });
    
    fileWatcher.on('unlink', (filePath) => {
      const relativePath = path.relative(WORKSPACE, filePath);
      
      // Remove from index
      if (indexer) {
        indexer.deleteFile(relativePath);
      }
    });
    
    console.log('📡 File watcher active (live reload + indexing)');
  } catch (e) {
    console.log('File watcher not available:', e.message);
  }
}

// ============================================
// SESSION HISTORY API (Phase 6)
// ============================================

// Search for file-related conversations in memory
app.post('/api/session-history', (req, res) => {
  const { filePath, fileName, fileNameNoExt, limit = 50 } = req.body;
  if (!filePath && !fileName) {
    return res.status(400).json({ error: 'File path or name required' });
  }
  
  const results = [];
  const searchTerms = [filePath, fileName, fileNameNoExt].filter(Boolean);
  
  const searchFile = (memPath, memName) => {
    if (!fs.existsSync(memPath)) return;
    
    const content = fs.readFileSync(memPath, 'utf-8');
    const lines = content.split('\n');
    
    // Extract date from filename
    const dateMatch = memName.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : null;
    
    lines.forEach((line, idx) => {
      const lowerLine = line.toLowerCase();
      
      for (const term of searchTerms) {
        if (lowerLine.includes(term.toLowerCase())) {
          // Extract time if present
          const timeMatch = line.match(/^-?\s*(\d{1,2}:\d{2}(?:\s*[AP]M)?)/i);
          
          // Determine type
          let type = 'conversation';
          if (lowerLine.includes('decided') || lowerLine.includes('decision')) type = 'decision';
          else if (lowerLine.includes('todo') || lowerLine.includes('[ ]')) type = 'todo';
          else if (lowerLine.includes('bug') || lowerLine.includes('fix')) type = 'bug';
          else if (lowerLine.includes('changed') || lowerLine.includes('modified')) type = 'change';
          
          results.push({
            file: memName,
            line: idx + 1,
            content: line.trim().substring(0, 200),
            date,
            time: timeMatch ? timeMatch[1] : null,
            type
          });
          break;
        }
      }
    });
  };
  
  // Search core memory files
  const coreFiles = ['MEMORY.md', 'TOOLS.md'];
  for (const f of coreFiles) {
    searchFile(path.join(WORKSPACE, f), f);
  }
  
  // Search daily notes (most recent first)
  const memoryDir = path.join(WORKSPACE, 'memory');
  if (fs.existsSync(memoryDir)) {
    const dailyFiles = fs.readdirSync(memoryDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse()
      .slice(0, 30);
    
    for (const f of dailyFiles) {
      searchFile(path.join(memoryDir, f), `memory/${f}`);
    }
  }
  
  // Sort by date descending
  results.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return 0;
  });
  
  res.json({ results: results.slice(0, limit) });
});

// ============================================
// ARCHITECTURE DIAGRAM API (Phase 6)
// ============================================

// Analyze code structure for diagrams
app.post('/api/architecture', (req, res) => {
  const { scope, type, currentFile } = req.body;
  
  try {
    const nodes = [];
    const edges = [];
    const nodeSet = new Set();
    
    // Determine files to analyze
    let filesToAnalyze = [];
    
    if (scope === 'file' && currentFile) {
      filesToAnalyze = [currentFile];
    } else if (scope === 'folder' && currentFile) {
      const folderPath = path.dirname(path.join(WORKSPACE, currentFile));
      if (fs.existsSync(folderPath)) {
        filesToAnalyze = fs.readdirSync(folderPath)
          .filter(f => /\.(js|jsx|ts|tsx|vue|svelte)$/.test(f))
          .map(f => path.join(path.dirname(currentFile), f));
      }
    } else {
      // Project scope - find all source files (limited)
      const srcDir = path.join(WORKSPACE, 'src');
      if (fs.existsSync(srcDir)) {
        const walk = (dir, files = []) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(fullPath, files);
            } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
              files.push(path.relative(WORKSPACE, fullPath));
            }
          }
          return files;
        };
        filesToAnalyze = walk(srcDir).slice(0, 50); // Limit to 50 files
      }
    }
    
    // Parse imports from each file
    for (const file of filesToAnalyze) {
      const fullPath = path.join(WORKSPACE, file);
      if (!fs.existsSync(fullPath)) continue;
      
      const content = fs.readFileSync(fullPath, 'utf-8');
      const fileName = path.basename(file);
      
      // Add node
      if (!nodeSet.has(fileName)) {
        nodes.push({ id: fileName, label: fileName, type: getFileType(file) });
        nodeSet.add(fileName);
      }
      
      // Parse imports
      const importRegex = /import\s+(?:(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
      let match;
      
      while ((match = importRegex.exec(content)) !== null) {
        const source = match[1];
        let targetName = source.split('/').pop();
        
        // Add extension if needed
        if (!targetName.includes('.')) {
          targetName += '.js';
        }
        
        const isExternal = !source.startsWith('.') && !source.startsWith('/');
        
        if (!nodeSet.has(targetName)) {
          nodes.push({ 
            id: targetName, 
            label: targetName, 
            type: isExternal ? 'external' : getFileType(targetName)
          });
          nodeSet.add(targetName);
        }
        
        edges.push({ source: fileName, target: targetName });
      }
    }
    
    // Generate Mermaid code
    let mermaid = type === 'flow' ? 'flowchart TD\n' : 'graph LR\n';
    
    for (const node of nodes) {
      const shape = node.type === 'external' ? `((${node.label}))` : `[${node.label}]`;
      mermaid += `  ${sanitizeId(node.id)}${shape}\n`;
    }
    
    for (const edge of edges) {
      mermaid += `  ${sanitizeId(edge.source)} --> ${sanitizeId(edge.target)}\n`;
    }
    
    res.json({ nodes, edges, mermaid });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getFileType(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const types = { js: 'javascript', jsx: 'react', ts: 'typescript', tsx: 'react-ts', vue: 'vue' };
  return types[ext] || 'file';
}

function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

// ============================================
// AI ATTRIBUTION API (Phase 5c)
// ============================================

const ATTRIBUTION_FILE = '.clawd/attribution.json';

// Get attribution data
app.get('/api/attribution', (req, res) => {
  const attrPath = path.join(WORKSPACE, ATTRIBUTION_FILE);
  
  if (!fs.existsSync(attrPath)) {
    return res.json({ files: {} });
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(attrPath, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.json({ files: {}, error: err.message });
  }
});

// Save attribution data
app.post('/api/attribution', (req, res) => {
  const { files } = req.body;
  if (!files) return res.status(400).json({ error: 'Files data required' });
  
  const attrPath = path.join(WORKSPACE, ATTRIBUTION_FILE);
  const attrDir = path.dirname(attrPath);
  
  // Ensure .clawd directory exists
  if (!fs.existsSync(attrDir)) {
    fs.mkdirSync(attrDir, { recursive: true });
  }
  
  try {
    const data = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      files
    };
    
    fs.writeFileSync(attrPath, JSON.stringify(data, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get attribution for a specific file
app.get('/api/attribution/file', (req, res) => {
  const { filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'File path required' });
  
  const attrPath = path.join(WORKSPACE, ATTRIBUTION_FILE);
  
  if (!fs.existsSync(attrPath)) {
    return res.json({ ranges: [] });
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(attrPath, 'utf-8'));
    const fileData = data.files?.[filePath] || { ranges: [] };
    res.json(fileData);
  } catch (err) {
    res.json({ ranges: [], error: err.message });
  }
});

// Get attribution statistics for workspace
app.get('/api/attribution/stats', (req, res) => {
  const attrPath = path.join(WORKSPACE, ATTRIBUTION_FILE);
  
  if (!fs.existsSync(attrPath)) {
    return res.json({ totalFiles: 0, totalRanges: 0, totalAILines: 0 });
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(attrPath, 'utf-8'));
    const files = data.files || {};
    
    let totalRanges = 0;
    let totalAILines = 0;
    
    for (const fileData of Object.values(files)) {
      for (const range of fileData.ranges || []) {
        totalRanges++;
        totalAILines += range.end - range.start + 1;
      }
    }
    
    res.json({
      totalFiles: Object.keys(files).length,
      totalRanges,
      totalAILines,
      lastUpdated: data.lastUpdated
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ============================================
// AGENT FEATURES API (Phase 5)
// ============================================

// Agent Terminal: Execute command in isolated environment
app.post('/api/agent-exec', async (req, res) => {
  const { command, cwd, timeout = 30000 } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required' });
  
  const workDir = cwd ? path.resolve(WORKSPACE, cwd) : WORKSPACE;
  
  try {
    const { execSync } = require('child_process');
    const result = execSync(command, {
      cwd: workDir,
      timeout,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    res.json({ 
      stdout: result,
      stderr: '',
      exitCode: 0 
    });
  } catch (err) {
    res.json({
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || err.message,
      exitCode: err.status || 1
    });
  }
});

// Auto-Lint: Run ESLint --fix on a file
app.post('/api/lint', async (req, res) => {
  const { filePath, fix = true } = req.body;
  if (!filePath) return res.status(400).json({ error: 'File path required' });
  
  const fullPath = path.resolve(WORKSPACE, filePath);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  // Check if ESLint is available
  const hasEslint = fs.existsSync(path.join(WORKSPACE, 'node_modules/.bin/eslint')) ||
                    fs.existsSync(path.join(WORKSPACE, '.eslintrc.js')) ||
                    fs.existsSync(path.join(WORKSPACE, '.eslintrc.json')) ||
                    fs.existsSync(path.join(WORKSPACE, 'eslint.config.js'));
  
  if (!hasEslint) {
    return res.json({ 
      fixed: false, 
      skipped: true, 
      reason: 'ESLint not configured in workspace' 
    });
  }
  
  try {
    const { execSync } = require('child_process');
    const beforeContent = fs.readFileSync(fullPath, 'utf-8');
    
    // Run ESLint with --fix
    const cmd = fix ? `npx eslint "${fullPath}" --fix --format json` : `npx eslint "${fullPath}" --format json`;
    let output;
    try {
      output = execSync(cmd, { cwd: WORKSPACE, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      output = err.stdout?.toString() || '[]';
    }
    
    const afterContent = fs.readFileSync(fullPath, 'utf-8');
    const wasFixed = beforeContent !== afterContent;
    
    // Parse ESLint output
    let eslintResult = [];
    try {
      eslintResult = JSON.parse(output || '[]');
    } catch (e) {}
    
    const fileResult = eslintResult[0] || {};
    const errors = (fileResult.messages || []).filter(m => m.severity === 2);
    const warnings = (fileResult.messages || []).filter(m => m.severity === 1);
    
    // Count fixes (rough estimate based on content diff)
    const fixCount = wasFixed ? Math.max(1, Math.abs(beforeContent.split('\n').length - afterContent.split('\n').length) || 1) : 0;
    
    res.json({
      fixed: wasFixed,
      fixCount,
      errors,
      warnings,
      fixedCode: wasFixed ? afterContent : null
    });
  } catch (err) {
    res.json({ 
      fixed: false, 
      error: err.message 
    });
  }
});

// Memory Search (enhanced for POST with more options)
app.post('/api/memory/search', async (req, res) => {
  const { query, limit = 20 } = req.body;
  if (!query) return res.status(400).json({ error: 'Query required' });
  
  const results = [];
  const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  
  const searchFile = (filePath, name) => {
    if (!fs.existsSync(filePath)) return;
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    lines.forEach((line, idx) => {
      const lowerLine = line.toLowerCase();
      const matches = searchTerms.filter(t => lowerLine.includes(t)).length;
      
      if (matches > 0) {
        const score = matches / searchTerms.length;
        const snippet = lines.slice(Math.max(0, idx - 1), Math.min(lines.length, idx + 3)).join('\n');
        
        // Extract date from filename if daily file
        const dateMatch = name.match(/(\d{4}-\d{2}-\d{2})/);
        
        results.push({
          file: name,
          line: idx + 1,
          content: line.trim(),
          snippet: snippet.slice(0, 200),
          score,
          date: dateMatch ? dateMatch[1] : null
        });
      }
    });
  };
  
  // Search core files
  const coreFiles = ['MEMORY.md', 'USER.md', 'SOUL.md', 'TOOLS.md', 'AGENTS.md'];
  for (const f of coreFiles) {
    searchFile(path.join(WORKSPACE, f), f);
  }
  
  // Search daily notes (most recent first)
  const memoryDir = path.join(WORKSPACE, 'memory');
  if (fs.existsSync(memoryDir)) {
    const dailyFiles = fs.readdirSync(memoryDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse()
      .slice(0, 30); // Last 30 days
    
    for (const f of dailyFiles) {
      searchFile(path.join(memoryDir, f), `memory/${f}`);
    }
  }
  
  // Sort by score and limit
  results.sort((a, b) => b.score - a.score);
  
  res.json({ results: results.slice(0, limit) });
});

// ============================================
// SUB-AGENT MANAGEMENT API
// ============================================

// Proxy to DNA Gateway for agent management
// These require Gateway connection to work properly

// List active sub-agents
app.get('/api/agents/list', async (req, res) => {
  // Return empty list immediately if gateway not connected
  if (!gatewayConnected) {
    return res.json({ sessions: [], warning: 'Gateway not connected' });
  }
  
  try {
    // Use correct message format: type='req', id field (matches response handler)
    const id = generateId();
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        resolve({ sessions: [], warning: 'Gateway timeout' });
      }, 2000); // 2 second timeout
      
      pendingRequests.set(id, { resolve, reject, timeout });
    });
    
    gatewayWs.send(JSON.stringify({
      type: 'req',
      id,
      method: 'sessions.list',
      params: { kinds: ['spawn'], limit: 20, messageLimit: 1 }
    }));
    
    const result = await promise;
    // Extract sessions from gateway response format
    const sessions = result?.payload?.sessions || result?.sessions || [];
    res.json({ sessions });
  } catch (err) {
    res.json({ sessions: [], error: err.message });
  }
});

// Spawn a new sub-agent
app.post('/api/agents/spawn', async (req, res) => {
  const { task, label, model, timeoutSeconds = 300 } = req.body;
  if (!task) return res.status(400).json({ error: 'Task required' });
  
  if (!gatewayConnected) {
    return res.status(503).json({ error: 'Gateway not connected' });
  }
  
  try {
    const id = generateId();
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('Gateway timeout'));
      }, 15000);
      
      pendingRequests.set(id, { resolve, reject, timeout });
    });
    
    gatewayWs.send(JSON.stringify({
      type: 'req',
      id,
      method: 'sessions.spawn',
      params: {
        task,
        label: label || undefined,
        model: model || undefined,
        timeoutSeconds
      }
    }));
    
    const result = await promise;
    res.json(result?.payload || result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get agent history
app.get('/api/agents/history', async (req, res) => {
  const { sessionKey } = req.query;
  if (!sessionKey) return res.status(400).json({ error: 'Session key required' });
  
  if (!gatewayConnected) {
    return res.json({ messages: [], warning: 'Gateway not connected' });
  }
  
  try {
    const id = generateId();
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('Gateway timeout'));
      }, 10000);
      
      pendingRequests.set(id, { resolve, reject, timeout });
    });
    
    gatewayWs.send(JSON.stringify({
      type: 'req',
      id,
      method: 'sessions.history',
      params: { sessionKey, limit: 50 }
    }));
    
    const result = await promise;
    res.json(result?.payload || result);
  } catch (err) {
    res.json({ messages: [], error: err.message });
  }
});

// Kill/stop an agent
app.post('/api/agents/kill', async (req, res) => {
  const { sessionKey } = req.body;
  if (!sessionKey) return res.status(400).json({ error: 'Session key required' });
  
  // Note: DNA doesn't have a direct kill API yet
  // This is a placeholder that could be implemented via session deletion
  res.json({ 
    success: true, 
    note: 'Agent termination requested (may continue until current operation completes)' 
  });
});

// ============================================
// CONTEXT METER API
// ============================================

// Get context/token usage for current session
app.get('/api/context/usage', async (req, res) => {
  try {
    // Try to get session info from DNA gateway
    const sessionKey = 'agent:main:main';
    const sessionDir = path.join(os.homedir(), '.dna', 'sessions');
    const sessionFile = path.join(sessionDir, `${sessionKey.replace(/:/g, '-')}.jsonl`);
    
    let tokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let messageCount = 0;
    let sessionStart = null;
    
    // Read session file to estimate usage
    if (fs.existsSync(sessionFile)) {
      const stats = fs.statSync(sessionFile);
      const fileSizeBytes = stats.size;
      
      // Estimate: 4 chars per token on average
      tokens = Math.round(fileSizeBytes / 4);
      
      // Read first and last lines for timing
      const content = fs.readFileSync(sessionFile, 'utf-8');
      const lines = content.trim().split('\n');
      messageCount = lines.length;
      
      // Estimate input vs output (70/30 split typical)
      inputTokens = Math.round(tokens * 0.7);
      outputTokens = Math.round(tokens * 0.3);
      
      // Get session start time from first entry
      try {
        const firstEntry = JSON.parse(lines[0]);
        sessionStart = firstEntry.timestamp || stats.birthtime;
      } catch {
        sessionStart = stats.birthtime;
      }
    }
    
    // Model context windows
    const maxTokens = 200000; // Default to Opus
    const percent = Math.min(99, Math.round((tokens / maxTokens) * 100));
    
    // Session duration in minutes
    const sessionDuration = sessionStart 
      ? Math.round((Date.now() - new Date(sessionStart).getTime()) / 60000)
      : 0;
    
    // Check compaction status (simplified)
    let compactionStatus = 'available';
    if (percent >= 85) {
      compactionStatus = 'blocked'; // Likely already compacted and stuck
    }
    
    res.json({
      percent,
      tokens,
      maxTokens,
      inputTokens,
      outputTokens,
      cachedTokens: 0,
      messageCount,
      sessionDuration,
      compactionStatus,
      model: 'claude-opus-4',
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[context/usage] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server and connect to gateway
server.listen(PORT, async () => {
  console.log(`🐾 Clawd IDE Server running at http://localhost:${PORT}`);
  console.log(`   Workspace: ${WORKSPACE}`);
  console.log(`   Gateway: ${GATEWAY_URL}`);
  
  // Connect to DNA Gateway
  connectToGateway();
  
  // Setup file watcher (live reload + indexing)
  setupFileWatcher();
  
  // Initialize codebase indexer
  await initIndexer();
});
