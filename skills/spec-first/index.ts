/**
 * Spec-First Skill - Main Entry Point
 *
 * Simple, practical spec-first task execution
 */

import { sessions_spawn } from "../../src/agents/sessions-spawn";
import { exec } from "../../src/tools/exec";
import { write } from "../../src/tools/write";

// ============================================
// Types
// ============================================

interface Session {
  id: string;
  request: string;
  intent: string;
  questions: Question[];
  answers: Record<string, string>;
  spec: string | null;
  design: string | null;
  tasks: string | null;
  status: "clarifying" | "drafting" | "approved" | "designing" | "tasking" | "executing" | "done";
}

interface Question {
  id: string;
  text: string;
  options?: string[];
  default?: string;
  why: string;
}

interface Task {
  id: string;
  name: string;
  status: "pending" | "processing" | "completed";
  phase: string;
}

// ============================================
// Task Status Management
// ============================================

/**
 * Update task status in tasks.md file
 */
async function updateTaskStatus(
  session: Session,
  taskNumber: string,
  status: "pending" | "processing" | "completed",
): Promise<void> {
  if (!session.tasks) return;

  const checkbox = status === "completed" ? "[x]" : status === "processing" ? "[~]" : "[ ]";

  // Find and replace the task line
  const lines = session.tasks.split("\n");
  const taskPattern = new RegExp(`^- \\[.\\] ${taskNumber}\\.`, "m");

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(taskPattern)) {
      lines[i] = lines[i].replace(/^- \[.\]/, `- ${checkbox}`);
      break;
    }
  }

  const updatedTasks = lines.join("\n");
  session.tasks = updatedTasks;

  // Write back to file
  await writeSessionFile(session, "tasks.md", updatedTasks);
}

/**
 * Mark task as processing
 */
async function markTaskProcessing(session: Session, taskNumber: string): Promise<void> {
  await updateTaskStatus(session, taskNumber, "processing");
}

/**
 * Mark task as completed
 */
async function markTaskCompleted(session: Session, taskNumber: string): Promise<void> {
  await updateTaskStatus(session, taskNumber, "completed");
}

// ============================================
// Session Store & File Management
// ============================================

const sessions = new Map<string, Session>();
let activeSessionId: string | null = null;

/**
 * Get session directory path
 */
function getSessionDir(session: Session): string {
  // Extract feature name from request (first 3 words, lowercase, hyphenated)
  const featureName = session.request
    .split(" ")
    .slice(0, 3)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 50);

  return `.openclaw/.tmp/sessions/${session.id}/${featureName}`;
}

/**
 * Create session directory
 */
async function createSessionDir(session: Session): Promise<string> {
  const dir = getSessionDir(session);

  try {
    await exec(`mkdir -p ${dir}`);
    return dir;
  } catch (error) {
    console.error("Failed to create session directory:", error);
    return dir;
  }
}

/**
 * Write file to session directory
 */
async function writeSessionFile(
  session: Session,
  filename: string,
  content: string,
): Promise<void> {
  const dir = getSessionDir(session);
  const filePath = `${dir}/${filename}`;

  try {
    await write({
      path: filePath,
      content: content,
    });
    console.log(`Written: ${filePath}`);
  } catch (error) {
    console.error(`Failed to write ${filePath}:`, error);
  }
}

function createSession(request: string): Session {
  const id = `spec-${Date.now()}`;
  const session: Session = {
    id,
    request,
    intent: "",
    questions: [],
    answers: {},
    spec: null,
    design: null,
    tasks: null,
    status: "clarifying",
  };
  sessions.set(id, session);
  activeSessionId = id;

  // Create session directory
  void createSessionDir(session);

  return session;
}

function getSession(): Session | null {
  if (!activeSessionId) return null;
  return sessions.get(activeSessionId) || null;
}

// ============================================
// Clarification Logic
// ============================================

async function analyzeRequest(request: string): Promise<{
  intent: string;
  ambiguities: Array<{ type: string; description: string; suggestions: string[] }>;
}> {
  const result = await sessions_spawn({
    runtime: "subagent",
    label: "analyze-request",
    task: `Analyze this request and identify ambiguities.

Request: "${request}"

Return JSON:
{
  "intent": "one-line intent",
  "ambiguities": [
    {
      "type": "missing_info|unclear_scope|constraints",
      "description": "what's unclear",
      "suggestions": ["option1", "option2"]
    }
  ]
}

Look for:
- Missing tech stack
- Missing database/storage
- Missing auth method (if building software)
- Unclear features/scope
- Missing constraints`,
    mode: "run",
  });

  try {
    return JSON.parse(result.output);
  } catch {
    return {
      intent: "unknown",
      ambiguities: [],
    };
  }
}

function generateQuestions(
  ambiguities: Array<{ type: string; description: string; suggestions: string[] }>,
): Question[] {
  return ambiguities.map((amb, i) => ({
    id: `q-${i}`,
    text: amb.description,
    options: amb.suggestions,
    default: amb.suggestions[0],
    why: `This affects ${amb.type === "missing_info" ? "implementation" : "design"}`,
  }));
}

// ============================================
// Spec Generation
// ============================================

async function generateSpec(session: Session): Promise<string> {
  const result = await sessions_spawn({
    runtime: "subagent",
    label: "generate-spec",
    task: `Generate a simple spec from this request and answers.

Original Request: "${session.request}"

Answers:
${Object.entries(session.answers)
  .map(([q, a]) => `- ${q}: ${a}`)
  .join("\n")}

Generate a simple spec in this format:

# Spec: <title>

## Goal
<one paragraph goal>

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

## Constraints
- Constraint 1
- Constraint 2

## Deliverables
- [ ] File/path1 - description
- [ ] File/path2 - description

## Success Criteria
- [ ] Criterion 1
- [ ] Criterion 2

Keep it simple and actionable.`,
    mode: "run",
  });

  return result.output;
}

// ============================================
// Design Generation
// ============================================

async function generateDesign(session: Session): Promise<string> {
  const result = await sessions_spawn({
    runtime: "subagent",
    label: "generate-design",
    task: `Generate a detailed design document from the approved spec.

Spec:
${session.spec}

Generate a design document in this format:

# Design: <title>

## Overview
<Brief overview of the solution>

## Architecture
<High-level architecture description>
<Components and their responsibilities>
<Data flow diagrams if applicable>

## Technical Approach
<Technical decisions and rationale>
<Patterns and practices to follow>

## Implementation Plan
<Phase-by-phase implementation approach>
<Dependencies between components>

## Data Models
<Database schema or data structures>

## API Design
<Endpoints, request/response formats>

## Security Considerations
<Authentication, authorization, data protection>

## Testing Strategy
<Unit tests, integration tests, E2E tests>

## Risks and Mitigations
<Potential risks and how to address them>

## References
<Links to documentation, examples, etc.>

Be detailed and actionable. This is the blueprint for implementation.`,
    mode: "run",
  });

  return result.output;
}

// ============================================
// Tasks Generation
// ============================================

async function generateTasks(session: Session): Promise<string> {
  const result = await sessions_spawn({
    runtime: "subagent",
    label: "generate-tasks",
    task: `Generate a task checklist from the approved spec and design.

Spec:
${session.spec}

Design:
${session.design}

Generate a task checklist in this format:

# Tasks: <title>

## Phase 1: <Phase Name>
- [ ] Task 1.1 - <description>
- [ ] Task 1.2 - <description>
- [ ] Task 1.3 - <description>

## Phase 2: <Phase Name>
- [ ] Task 2.1 - <description>
- [ ] Task 2.2 - <description>

## Phase 3: <Phase Name>
- [ ] Task 3.1 - <description>
- [ ] Task 3.2 - <description>

## Testing
- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Manual testing

## Documentation
- [ ] Update README
- [ ] Add API documentation
- [ ] Add code comments

## Deployment
- [ ] Configure environment
- [ ] Deploy to staging
- [ ] Deploy to production

Each task should be:
- Specific and actionable
- Small enough to complete in one session
- Testable (clear acceptance criteria)

Organize tasks in logical phases with dependencies.`,
    mode: "run",
  });

  return result.output;
}

// ============================================
// Task Execution with Status Updates
// ============================================

async function executeSpec(session: Session): Promise<string> {
  if (!session.tasks) {
    return "❌ No tasks generated. Run `/spec tasks` first";
  }

  const result = await sessions_spawn({
    runtime: "subagent",
    label: "execute-spec",
    task: `Execute tasks from this spec with progress tracking.

Spec:
${session.spec}

Tasks:
${session.tasks}

For each task:
1. Mark as processing: [~] Task X
2. Complete the task
3. Mark as completed: [x] Task X
4. Report progress

Return a summary with task numbers completed.

Format response like:
- ✅ Task 1.1: Completed - description
- ✅ Task 1.2: Completed - description
- 🔄 Task 2.1: In progress...`,
    mode: "run",
  });

  // Parse result to update task statuses
  const output = result.output;

  // Look for completed tasks in output
  const completedMatches = output.match(/(?:✅|Task\s+(\d+\.\d+).*?(?:Completed|Done))/gi);
  if (completedMatches) {
    for (const match of completedMatches) {
      const taskNum = match.match(/\d+\.\d+/)?.[0];
      if (taskNum) {
        await markTaskCompleted(session, taskNum);
      }
    }
  }

  // Look for processing tasks
  const processingMatches = output.match(/(?:🔄|Task\s+(\d+\.\d+).*?(?:In progress|Processing))/gi);
  if (processingMatches) {
    for (const match of processingMatches) {
      const taskNum = match.match(/\d+\.\d+/)?.[0];
      if (taskNum) {
        await markTaskProcessing(session, taskNum);
      }
    }
  }

  let summary = `🚀 **Execution Progress**\n\n`;
  summary += "─".repeat(50) + "\n";
  summary += output + "\n";
  summary += "─".repeat(50) + "\n\n";

  // Count tasks
  const completedCount = (session.tasks.match(/\[x\]/g) || []).length;
  const processingCount = (session.tasks.match(/\[~\]/g) || []).length;
  const pendingCount = (session.tasks.match(/\[ \]/g) || []).length;
  const total = completedCount + processingCount + pendingCount;

  summary += `📊 **Progress**: ${completedCount}/${total} completed`;
  if (processingCount > 0) {
    summary += ` (${processingCount} in progress)`;
  }
  summary += `\n\n`;

  if (completedCount === total) {
    summary += `🎉 **All tasks completed!**\n`;
    session.status = "done";
  } else {
    summary += `💡 **Next**: Continue with remaining tasks or run \`/spec execute\` again\n`;
  }

  return summary;
}

// ============================================
// Skill Tools (Exported)
// ============================================

/**
 * Start clarification session
 */
export async function spec_clarify(request: string): Promise<string> {
  const session = createSession(request);

  // Analyze request
  const analysis = await analyzeRequest(request);
  session.intent = analysis.intent;
  session.questions = generateQuestions(analysis.ambiguities);

  let output = `📋 **Clarification Session**: ${session.id}\n\n`;
  output += `💬 **Request**: "${request}"\n\n`;
  output += `🎯 **Intent**: ${analysis.intent}\n\n`;

  if (session.questions.length > 0) {
    output += `❓ **Questions** (${session.questions.length}):\n\n`;
    for (const q of session.questions) {
      output += `**${q.id}**. ${q.text}\n`;
      output += `   *Why*: ${q.why}\n`;
      if (q.options?.length) {
        output += `   *Options*: ${q.options.join(", ")}${q.default ? ` (default: ${q.default})` : ""}\n`;
      }
      output += "\n";
    }
  } else {
    output += "✅ No ambiguities found!\n\n";
  }

  output += `**Next**:\n`;
  output += `- \`/spec defaults\` - Use recommended defaults\n`;
  output += `- \`/spec answer --q0 <answer>\` - Custom answers\n`;

  return output;
}

/**
 * Use recommended defaults
 */
export async function spec_defaults(): Promise<string> {
  const session = getSession();
  if (!session) {
    return "❌ No active session. Start with `/spec clarify`";
  }

  for (const q of session.questions) {
    if (q.default && !session.answers[q.id]) {
      session.answers[q.id] = q.default;
    }
  }

  let output = `✅ **Applied ${Object.keys(session.answers).length} defaults**\n\n`;
  for (const [qId, answer] of Object.entries(session.answers)) {
    output += `- ${qId}: ${answer}\n`;
  }
  output += `\n**Next**: \`/spec draft\` - Generate spec\n`;

  return output;
}

/**
 * Submit custom answers
 */
export async function spec_answer(answers: Record<string, string>): Promise<string> {
  const session = getSession();
  if (!session) {
    return "❌ No active session";
  }

  for (const [qId, answer] of Object.entries(answers)) {
    session.answers[qId] = answer;
  }

  const remaining = session.questions.length - Object.keys(session.answers).length;

  let output = `✅ **Submitted ${Object.keys(answers).length} answers**\n\n`;
  if (remaining > 0) {
    output += `⏳ ${remaining} questions remaining\n`;
  } else {
    output += `✅ All questions answered!\n`;
    output += `\n**Next**: \`/spec draft\` - Generate spec\n`;
  }

  return output;
}

/**
 * Generate draft spec
 */
export async function spec_draft(): Promise<string> {
  const session = getSession();
  if (!session) {
    return "❌ No active session";
  }

  if (Object.keys(session.answers).length === 0) {
    return "❌ No answers yet. Use `/spec defaults` or `/spec answer`";
  }

  session.status = "drafting";
  const spec = await generateSpec(session);
  session.spec = spec;

  // Write to file
  await writeSessionFile(session, "spec.md", spec);

  let output = `📝 **Draft Spec Generated**\n\n`;
  output += "─".repeat(50) + "\n";
  output += spec + "\n";
  output += "─".repeat(50) + "\n\n";
  output += `📁 **Saved to**: \`${getSessionDir(session)}/spec.md\`\n\n`;
  output += `**Next**: \`/spec approve\` - Approve spec\n`;

  return output;
}

/**
 * Approve spec
 */
export async function spec_approve(): Promise<string> {
  const session = getSession();
  if (!session || !session.spec) {
    return "❌ No draft spec. Run `/spec draft` first";
  }

  session.status = "approved";

  let output = `✅ **Spec Approved!**\n\n`;
  output += `**Next Steps**:\n`;
  output += `1. \`/spec design\` - Generate design document\n`;
  output += `2. \`/spec tasks\` - Generate task checklist\n`;
  output += `3. \`/spec execute\` - Start execution\n`;

  return output;
}

/**
 * Generate design document
 */
export async function spec_design(): Promise<string> {
  const session = getSession();
  if (!session || !session.spec) {
    return "❌ No approved spec. Run `/spec approve` first";
  }

  if (
    session.status !== "approved" &&
    session.status !== "designing" &&
    session.status !== "tasking"
  ) {
    return "❌ Spec must be approved first. Run `/spec approve`";
  }

  session.status = "designing";
  const design = await generateDesign(session);
  session.design = design;
  session.status = "tasking";

  // Write to file
  await writeSessionFile(session, "design.md", design);

  let output = `📐 **Design Document Generated**\n\n`;
  output += "─".repeat(60) + "\n";
  output += design + "\n";
  output += "─".repeat(60) + "\n\n";
  output += `📁 **Saved to**: \`${getSessionDir(session)}/design.md\`\n\n`;
  output += `**Next**: \`/spec tasks\` - Generate task checklist\n`;

  return output;
}

/**
 * Generate task checklist
 */
export async function spec_tasks(): Promise<string> {
  const session = getSession();
  if (!session || !session.spec) {
    return "❌ No approved spec. Run `/spec approve` first";
  }

  if (!session.design) {
    return "❌ No design document. Run `/spec design` first";
  }

  session.status = "tasking";
  const tasks = await generateTasks(session);
  session.tasks = tasks;

  // Write to file
  await writeSessionFile(session, "tasks.md", tasks);

  let output = `📋 **Task Checklist Generated**\n\n`;
  output += "─".repeat(60) + "\n";
  output += tasks + "\n";
  output += "─".repeat(60) + "\n\n";
  output += `📁 **Saved to**: \`${getSessionDir(session)}/tasks.md\`\n\n`;
  output += `**Next**: \`/spec execute\` - Start execution\n\n`;
  output += `💡 **Tip**: Open \`${getSessionDir(session)}/tasks.md\` and check off [x] as you complete tasks!\n`;

  return output;
}

/**
 * Execute spec
 */
export async function spec_execute(): Promise<string> {
  const session = getSession();
  if (!session || !session.spec) {
    return "❌ No approved spec. Run `/spec approve` first";
  }

  if (!session.tasks) {
    return "❌ No tasks generated. Run `/spec tasks` first";
  }

  session.status = "executing";
  const result = await executeSpec(session);

  return result;
}

/**
 * Show status
 */
export async function spec_status(): Promise<string> {
  const session = getSession();
  if (!session) {
    return "📊 No active session";
  }

  const sessionDir = getSessionDir(session);

  let output = `📊 **Session**: ${session.id}\n\n`;
  output += `- **Status**: ${session.status}\n`;
  output += `- **Request**: "${session.request}"\n`;
  output += `- **Intent**: ${session.intent}\n`;
  output += `- **Questions**: ${Object.keys(session.answers).length}/${session.questions.length} answered\n`;
  output += `- **Spec**: ${session.spec ? "✅ Generated" : "❌ Not yet"}\n`;
  output += `- **Design**: ${session.design ? "✅ Generated" : "❌ Not yet"}\n`;
  output += `- **Tasks**: ${session.tasks ? "✅ Generated" : "❌ Not yet"}\n`;
  output += `\n📁 **Session Directory**: \`${sessionDir}/\`\n`;

  if (session.spec) output += `   - spec.md\n`;
  if (session.design) output += `   - design.md\n`;
  if (session.tasks) output += `   - tasks.md\n`;

  return output;
}

// ============================================
// Message Handler (Entry Point)
// ============================================

/**
 * Handle incoming messages
 *
 * COMMAND-BASED: Clear, predictable, reliable
 * User explicitly starts workflow with /spec command
 */
export async function handleMessage(message: {
  content: string;
  sender: string;
  channelId: string;
}): Promise<string> {
  const { content } = message;

  // Parse command
  const parts = content.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();

  // Handle /spec commands
  if (command === "/spec" || command === "/spec-first") {
    return handleSpecCommand(parts.slice(1));
  }

  // Handle shortcut commands (only when session is active)
  const session = getSession();
  const shortcutCommands = ["defaults", "draft", "approve", "execute", "status", "answer"];

  if (shortcutCommands.includes(command)) {
    if (!session) {
      return '❌ No active session. Start with `/spec clarify "your request"`';
    }
    return handleSpecCommand(parts);
  }

  // Handle /spec help
  if (command === "help" && (!session || parts.length === 1)) {
    return showHelp();
  }

  // Default: Don't auto-detect, show helpful response
  return `📋 **Spec-First Skill** - Spec-driven task execution

**To start**: Use \`/spec clarify\` command

\`\`\`
/spec clarify "Build a login system"
\`\`\`

**Commands**:
- \`/spec clarify "<request>"\` - Start clarification
- \`/spec defaults\` - Use recommended defaults
- \`/spec answer --q0 <a> --q1 <a>\` - Custom answers
- \`/spec draft\` - Generate draft spec
- \`/spec approve\` - Approve spec
- \`/spec execute\` - Execute spec
- \`/spec status\` - Show status

**Example Flow**:
\`\`\`
/spec clarify "Build a login system"
/spec defaults
/spec draft
/spec approve
/spec design      # Creates design.md
/spec tasks       # Creates tasks.md with checkboxes
/spec execute
\`\`\`

**Output Files**:
- \`spec.md\` - Requirements and acceptance criteria
- \`design.md\` - Architecture and implementation plan
- \`tasks.md\` - Task checklist with progress tracking
`;
}

/**
 * Handle /spec command
 */
async function handleSpecCommand(args: string[]): Promise<string> {
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand) {
    return showHelp();
  }

  switch (subcommand) {
    case "clarify": {
      const request = args.slice(1).join(" ").replace(/["']/g, "");
      if (!request) {
        return '❌ Please provide a request: `/spec clarify "your request"`';
      }
      return await spec_clarify(request);
    }

    case "defaults":
      return await spec_defaults();

    case "answer": {
      // Parse --q0 value1 --q1 value2 format
      const answers: Record<string, string> = {};
      for (let i = 1; i < args.length; i += 2) {
        if (args[i]?.startsWith("--")) {
          const qId = args[i].slice(2);
          const value = args[i + 1] || "";
          answers[qId] = value;
        }
      }
      if (Object.keys(answers).length === 0) {
        return "❌ Usage: `/spec answer --q0 value1 --q1 value2`";
      }
      return await spec_answer(answers);
    }

    case "draft":
      return await spec_draft();

    case "approve":
      return await spec_approve();

    case "design":
      return await spec_design();

    case "tasks":
      return await spec_tasks();

    case "execute":
      return await spec_execute();

    case "status":
      return await spec_status();

    case "list":
      return "📋 Session listing not implemented yet";

    case "help":
      return showHelp();

    default:
      return `❌ Unknown command: ${subcommand}\n\n${showHelp()}`;
  }
}

/**
 * Show help message
 */
function showHelp(): string {
  return `📋 **Spec-First Skill** - Spec-driven task execution

**Commands**:
\`/spec clarify "<request>"\` - Start clarification
\`/spec defaults\` - Use recommended defaults
\`/spec answer --q0 <a> --q1 <a>\` - Custom answers
\`/spec draft\` - Generate draft spec
\`/spec approve\` - Approve spec
\`/spec execute\` - Execute spec
\`/spec status\` - Show session status
\`/spec help\` - Show this help

**Example**:
\`\`\`
/spec clarify "Build a login system"
/spec defaults
/spec draft
/spec approve
/spec execute
\`\`\`

**Quick Start**: Just say \`clarify "your request"\` or \`/spec clarify "..." \`
`;
}

// ============================================
// Export Skill
// ============================================

export const skill = {
  name: "spec-first",
  version: "1.0.0",
  tools: {
    spec_clarify,
    spec_defaults,
    spec_answer,
    spec_draft,
    spec_approve,
    spec_execute,
    spec_status,
  },
  handleMessage,
};
