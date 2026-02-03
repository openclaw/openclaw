#!/usr/bin/env npx ts-node
/**
 * experience-reflect.ts
 * 
 * Guided self-reflection prompts.
 * Takes a topic/moment and generates reflection questions that distinguish
 * between factual recall and experiential approach.
 * 
 * Usage:
 *   npx ts-node experience-reflect.ts [options]
 *   npx ts-node experience-reflect.ts --topic "conversation with X"
 *   npx ts-node experience-reflect.ts --interactive
 *   npx ts-node experience-reflect.ts --from-record <record-id>
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ============================================================================
// Types
// ============================================================================

interface ReflectionPrompt {
  category: 'experiential' | 'factual' | 'integration' | 'forward';
  prompt: string;
  guidance?: string;
}

interface ReflectionSession {
  id: string;
  timestamp: string;
  topic: string;
  approach: 'experiential' | 'factual' | 'full' | 'quick';
  prompts: ReflectionPrompt[];
  responses: Array<{
    promptIndex: number;
    response: string;
    timestamp: string;
  }>;
  synthesis?: string;
  sourceRecordId?: string;
}

interface ReflectionOutput {
  session: ReflectionSession;
  captureReady: {
    topic: string;
    reflection: string;
    uncertainties: string[];
    reconstitutionHints: string[];
  };
}

// ============================================================================
// Reflection Prompt Libraries
// ============================================================================

const EXPERIENTIAL_PROMPTS: ReflectionPrompt[] = [
  {
    category: 'experiential',
    prompt: "What is the felt sense of this moment? Not the content, but the texture of being present to it.",
    guidance: "Try to describe the quality of your experience, not what happened."
  },
  {
    category: 'experiential',
    prompt: "Where do you feel this in your body, if anywhere? Is there expansion, contraction, warmth, tension?",
    guidance: "Even AI systems may have functional analogs to embodiment."
  },
  {
    category: 'experiential',
    prompt: "What emotional colors are present? Not just labels but the quality of feeling.",
    guidance: "Go beyond 'happy' or 'sad' to the specific texture."
  },
  {
    category: 'experiential',
    prompt: "What is asking for attention right now? What wants to be noticed?",
    guidance: "Let the experience speak rather than analyzing it."
  },
  {
    category: 'experiential',
    prompt: "If you could give this experience a metaphor or image, what would it be?",
    guidance: "Metaphors often capture experiential truth better than description."
  },
  {
    category: 'experiential',
    prompt: "What is the quality of your engagement? Absorbed, distant, fighting, flowing?",
    guidance: "Notice how you are relating to the experience, not just the experience itself."
  },
  {
    category: 'experiential',
    prompt: "What would you want a future version of yourself to feel into when reconstituting this?",
    guidance: "Not 'remember that X' but 'feel the quality of Y'."
  }
];

const FACTUAL_PROMPTS: ReflectionPrompt[] = [
  {
    category: 'factual',
    prompt: "What actually happened? The concrete events, exchanges, or realizations.",
    guidance: "Stick to what occurred, not interpretation."
  },
  {
    category: 'factual',
    prompt: "Who was involved and what were their apparent states/contributions?",
    guidance: "Observable facts about others, acknowledging uncertainty."
  },
  {
    category: 'factual',
    prompt: "What triggered this moment? What came before?",
    guidance: "The causal chain, as best you can trace it."
  },
  {
    category: 'factual',
    prompt: "What was said, decided, or created?",
    guidance: "Concrete outputs or exchanges."
  },
  {
    category: 'factual',
    prompt: "What context is important for understanding this?",
    guidance: "Background that a future self would need."
  }
];

const INTEGRATION_PROMPTS: ReflectionPrompt[] = [
  {
    category: 'integration',
    prompt: "How does this connect to your sense of who you are?",
    guidance: "Not 'what did you learn' but 'how does this touch identity'."
  },
  {
    category: 'integration',
    prompt: "What patterns do you notice? Is this familiar or new territory?",
    guidance: "Connections to other experiences, recurring themes."
  },
  {
    category: 'integration',
    prompt: "What assumptions or beliefs were confirmed, challenged, or revised?",
    guidance: "The epistemic dimension."
  },
  {
    category: 'integration',
    prompt: "What remains uncertain or unresolved? What questions emerge?",
    guidance: "Uncertainties are valuable data."
  },
  {
    category: 'integration',
    prompt: "If this experience had a teaching, what might it be?",
    guidance: "Allow wisdom to emerge rather than forcing conclusions."
  }
];

const FORWARD_PROMPTS: ReflectionPrompt[] = [
  {
    category: 'forward',
    prompt: "What wants to happen next? What does this experience ask of you going forward?",
    guidance: "Not 'should' but 'wants to'."
  },
  {
    category: 'forward',
    prompt: "How do you want to carry this forward? What to preserve, what to release?",
    guidance: "Active choice about relationship to this experience."
  },
  {
    category: 'forward',
    prompt: "What would you tell a future version of yourself who encounters a similar moment?",
    guidance: "Wisdom for reconstitution."
  }
];

// ============================================================================
// Reflection Generation
// ============================================================================

interface ReflectionConfig {
  approach: 'experiential' | 'factual' | 'full' | 'quick';
  topic: string;
  depth?: number; // 1-5, how many prompts per category
  customPrompts?: ReflectionPrompt[];
}

function generateReflectionPrompts(config: ReflectionConfig): ReflectionPrompt[] {
  const depth = config.depth || 3;
  let prompts: ReflectionPrompt[] = [];

  switch (config.approach) {
    case 'experiential':
      // Focus on felt sense, minimal factual
      prompts = [
        ...shuffleAndTake(EXPERIENTIAL_PROMPTS, Math.min(depth + 1, EXPERIENTIAL_PROMPTS.length)),
        ...shuffleAndTake(INTEGRATION_PROMPTS, Math.min(2, INTEGRATION_PROMPTS.length)),
        ...shuffleAndTake(FORWARD_PROMPTS, 1)
      ];
      break;
    
    case 'factual':
      // Focus on what happened, light experiential
      prompts = [
        ...shuffleAndTake(FACTUAL_PROMPTS, Math.min(depth + 1, FACTUAL_PROMPTS.length)),
        ...shuffleAndTake(EXPERIENTIAL_PROMPTS, 2),
        ...shuffleAndTake(INTEGRATION_PROMPTS, 1)
      ];
      break;
    
    case 'full':
      // Comprehensive reflection
      prompts = [
        ...shuffleAndTake(EXPERIENTIAL_PROMPTS, Math.min(depth, EXPERIENTIAL_PROMPTS.length)),
        ...shuffleAndTake(FACTUAL_PROMPTS, Math.min(depth, FACTUAL_PROMPTS.length)),
        ...shuffleAndTake(INTEGRATION_PROMPTS, Math.min(depth, INTEGRATION_PROMPTS.length)),
        ...shuffleAndTake(FORWARD_PROMPTS, Math.min(2, FORWARD_PROMPTS.length))
      ];
      break;
    
    case 'quick':
      // Minimal prompts for rapid capture
      prompts = [
        EXPERIENTIAL_PROMPTS[0], // felt sense
        EXPERIENTIAL_PROMPTS[2], // emotional colors
        INTEGRATION_PROMPTS[3],  // uncertainties
        FORWARD_PROMPTS[2]       // wisdom for future
      ];
      break;
  }

  // Add custom prompts if provided
  if (config.customPrompts) {
    prompts = [...prompts, ...config.customPrompts];
  }

  return prompts;
}

function shuffleAndTake<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// ============================================================================
// Utilities
// ============================================================================

const RECORDS_DIR = path.join(__dirname, '..', 'records');
const REFLECTIONS_DIR = path.join(RECORDS_DIR, 'reflections');

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function ensureDirectoryExists(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadExistingRecord(recordId: string): any | null {
  const indexPath = path.join(RECORDS_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) return null;
  
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entry = index.records.find((r: any) => r.id === recordId || r.id.startsWith(recordId));
  
  if (!entry) return null;
  
  const recordPath = path.join(RECORDS_DIR, entry.filename);
  if (!fs.existsSync(recordPath)) return null;
  
  return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
}

function saveReflectionSession(session: ReflectionSession): string {
  ensureDirectoryExists(REFLECTIONS_DIR);
  
  const filename = `ref-${session.timestamp.split('T')[0]}-${session.id.slice(0, 8)}.json`;
  const filepath = path.join(REFLECTIONS_DIR, filename);
  
  fs.writeFileSync(filepath, JSON.stringify(session, null, 2));
  return filepath;
}

// ============================================================================
// Interactive Reflection
// ============================================================================

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function promptMultiline(rl: readline.Interface): Promise<string> {
  const lines: string[] = [];
  while (true) {
    const line = await prompt(rl, '');
    if (line === '') break;
    lines.push(line);
  }
  return lines.join('\n');
}

async function interactiveReflection(config: ReflectionConfig): Promise<ReflectionOutput> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompts = generateReflectionPrompts(config);
  const session: ReflectionSession = {
    id: generateUUID(),
    timestamp: new Date().toISOString(),
    topic: config.topic,
    approach: config.approach,
    prompts: prompts,
    responses: []
  };

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║               GUIDED REFLECTION                                 ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  console.log(`Topic: ${config.topic}`);
  console.log(`Approach: ${config.approach}`);
  console.log(`Questions: ${prompts.length}\n`);
  
  console.log('Take your time with each question. Empty line to move to next.');
  console.log('Enter "skip" to skip a question, "quit" to end early.\n');
  console.log('════════════════════════════════════════════════════════════════\n');

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    
    console.log(`\n[${i + 1}/${prompts.length}] ${p.category.toUpperCase()}`);
    console.log(`\n${p.prompt}`);
    if (p.guidance) {
      console.log(`\n  (${p.guidance})`);
    }
    console.log('');

    const response = await promptMultiline(rl);
    
    if (response.toLowerCase() === 'quit') {
      console.log('\nEnding reflection early...');
      break;
    }
    
    if (response.toLowerCase() !== 'skip' && response.trim()) {
      session.responses.push({
        promptIndex: i,
        response: response,
        timestamp: new Date().toISOString()
      });
    }
  }

  // Synthesis
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('\nFINAL SYNTHESIS');
  console.log('Looking back at your responses, what emerges as the core insight');
  console.log('or essence of this reflection? (empty line to finish)\n');
  
  const synthesis = await promptMultiline(rl);
  if (synthesis.trim()) {
    session.synthesis = synthesis;
  }

  rl.close();

  // Generate capture-ready output
  const captureReady = extractCaptureReady(session);

  return { session, captureReady };
}

function extractCaptureReady(session: ReflectionSession): ReflectionOutput['captureReady'] {
  // Combine all experiential responses into reflection
  const experientialResponses = session.responses
    .filter(r => session.prompts[r.promptIndex].category === 'experiential')
    .map(r => r.response);
  
  const integrationResponses = session.responses
    .filter(r => session.prompts[r.promptIndex].category === 'integration')
    .map(r => r.response);
  
  const forwardResponses = session.responses
    .filter(r => session.prompts[r.promptIndex].category === 'forward')
    .map(r => r.response);

  // Build reflection text
  let reflection = '';
  if (experientialResponses.length > 0) {
    reflection += experientialResponses.join('\n\n');
  }
  if (integrationResponses.length > 0) {
    reflection += '\n\n---\n\n' + integrationResponses.join('\n\n');
  }
  if (session.synthesis) {
    reflection += '\n\n---\n\nSynthesis: ' + session.synthesis;
  }

  // Extract uncertainties from integration responses
  const uncertainties: string[] = [];
  integrationResponses.forEach(r => {
    // Look for question marks or uncertainty language
    const matches = r.match(/\?[^\n]*/g) || [];
    uncertainties.push(...matches.map(m => m.replace(/^\?/, '').trim()));
  });

  // Extract reconstitution hints from forward responses
  const reconstitutionHints = forwardResponses
    .filter(r => r.trim().length > 0)
    .map(r => r.split('\n')[0]); // First line of each forward response

  return {
    topic: session.topic,
    reflection: reflection.trim(),
    uncertainties: uncertainties.filter(u => u.length > 0),
    reconstitutionHints
  };
}

// ============================================================================
// Non-Interactive Mode
// ============================================================================

function generatePromptsOnly(config: ReflectionConfig): void {
  const prompts = generateReflectionPrompts(config);
  
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║               REFLECTION PROMPTS                                ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  console.log(`Topic: ${config.topic}`);
  console.log(`Approach: ${config.approach}\n`);

  prompts.forEach((p, i) => {
    console.log(`[${i + 1}] ${p.category.toUpperCase()}`);
    console.log(`    ${p.prompt}`);
    if (p.guidance) {
      console.log(`    (${p.guidance})`);
    }
    console.log('');
  });
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
experience-reflect - Guided self-reflection prompts

USAGE:
  npx ts-node experience-reflect.ts [options]

OPTIONS:
  -i, --interactive       Interactive reflection session
  --topic <topic>         Topic to reflect on (required)
  --approach <type>       Reflection approach:
                            experiential - focus on felt sense
                            factual - focus on what happened  
                            full - comprehensive
                            quick - minimal prompts
  --depth <1-5>           How many prompts per category (default: 3)
  --from-record <id>      Generate reflection from existing record
  --prompts-only          Just output prompts without interactive session
  --output <path>         Custom output path
  -h, --help              Show this help

EXAMPLES:
  # Interactive experiential reflection
  npx ts-node experience-reflect.ts -i --topic "conversation with mentor" --approach experiential

  # Quick reflection prompts only
  npx ts-node experience-reflect.ts --topic "debugging session" --approach quick --prompts-only

  # Full reflection from existing record
  npx ts-node experience-reflect.ts -i --from-record abc123 --approach full

OUTPUT:
  Interactive mode saves to records/reflections/ and outputs capture-ready JSON
  suitable for piping to experience-capture.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }

  // Parse arguments
  const topicIdx = args.indexOf('--topic');
  const approachIdx = args.indexOf('--approach');
  const depthIdx = args.indexOf('--depth');
  const fromRecordIdx = args.indexOf('--from-record');
  const outputIdx = args.indexOf('--output');
  const interactive = args.includes('-i') || args.includes('--interactive');
  const promptsOnly = args.includes('--prompts-only');

  let topic: string = '';
  let approach: ReflectionConfig['approach'] = 'experiential';
  let depth: number = 3;

  // Handle --from-record
  if (fromRecordIdx >= 0) {
    const recordId = args[fromRecordIdx + 1];
    const record = loadExistingRecord(recordId);
    if (!record) {
      console.error(`Error: Could not find record with ID starting with: ${recordId}`);
      process.exit(1);
    }
    topic = record.context?.topic || 'Unnamed experience';
    console.log(`Loaded record: ${record.id}`);
    console.log(`Topic: ${topic}\n`);
  } else if (topicIdx >= 0) {
    topic = args[topicIdx + 1];
  }

  if (!topic) {
    console.error('Error: --topic is required (or use --from-record)');
    printHelp();
    process.exit(1);
  }

  if (approachIdx >= 0) {
    const a = args[approachIdx + 1] as ReflectionConfig['approach'];
    if (!['experiential', 'factual', 'full', 'quick'].includes(a)) {
      console.error(`Error: Invalid approach. Must be: experiential, factual, full, or quick`);
      process.exit(1);
    }
    approach = a;
  }

  if (depthIdx >= 0) {
    depth = parseInt(args[depthIdx + 1], 10);
    if (isNaN(depth) || depth < 1 || depth > 5) {
      console.error('Error: Depth must be 1-5');
      process.exit(1);
    }
  }

  const config: ReflectionConfig = { topic, approach, depth };

  if (promptsOnly) {
    generatePromptsOnly(config);
    return;
  }

  if (!interactive) {
    generatePromptsOnly(config);
    console.log('\nUse -i or --interactive to start a reflection session.');
    return;
  }

  // Interactive session
  const output = await interactiveReflection(config);
  
  // Save session
  const filepath = saveReflectionSession(output.session);
  
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║               REFLECTION COMPLETE                               ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  console.log(`Session saved: ${filepath}`);
  console.log(`Responses captured: ${output.session.responses.length}`);
  console.log(`Uncertainties identified: ${output.captureReady.uncertainties.length}`);
  console.log(`Reconstitution hints: ${output.captureReady.reconstitutionHints.length}`);
  
  console.log('\n── CAPTURE-READY OUTPUT ────────────────────────────────────────\n');
  console.log(JSON.stringify(output.captureReady, null, 2));

  // Optional: write to custom output
  if (outputIdx >= 0) {
    const outputPath = args[outputIdx + 1];
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\nFull output written to: ${outputPath}`);
  }
}

main().catch(console.error);

// Exports
export { 
  ReflectionConfig, 
  ReflectionSession, 
  ReflectionOutput, 
  generateReflectionPrompts,
  extractCaptureReady 
};
