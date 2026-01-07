#!/usr/bin/env node
/**
 * The Builders Podcast Generator v2
 * 
 * Two modes:
 * --quick : 15-20 min episode, single research pass
 * --deep  : 45-60 min episode, multi-layer research + enhancement
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Load the Acquired Bible
const BIBLE = readFileSync(join(SKILL_DIR, 'templates/acquired-bible.md'), 'utf-8');

// Section definitions - QUICK mode
const SECTIONS_QUICK = [
  { id: 0, name: 'INTRO', turns: 8, description: 'Welcome, casual banter, introduce the company, tease why this story is fascinating' },
  { id: 1, name: 'HOOK', turns: 12, description: 'Open with surprising fact or tension. Central question. Stakes.' },
  { id: 2, name: 'ORIGIN', turns: 20, description: 'Founders as humans. Genesis moment. Early bet. Market context.' },
  { id: 3, name: 'INFLECTION_1', turns: 18, description: 'First major decision. Alternatives. Stakes. What they risked.' },
  { id: 4, name: 'INFLECTION_2', turns: 18, description: 'Second pivot. New challenge. How they adapted.' },
  { id: 5, name: 'MESSY_MIDDLE', turns: 14, description: 'Near-death. Internal conflicts. Real struggle, not glorified.' },
  { id: 6, name: 'NOW', turns: 12, description: 'Current state. Metrics. Competition. Open questions.' },
  { id: 7, name: 'TAKEAWAYS', turns: 10, description: 'Key lessons. Frameworks. Final thought tying back to hook.' },
];

// Section definitions - DEEP mode (more turns, more sections)
const SECTIONS_DEEP = [
  { id: 0, name: 'INTRO', turns: 10, description: 'Welcome, what excited them about this research, why this company matters now' },
  { id: 1, name: 'HOOK', turns: 15, description: 'Vivid opening scene. The moment that defines the company. Stakes made visceral.' },
  { id: 2, name: 'ORIGIN', turns: 35, description: 'Deep founder story - actual quotes, specific moments, human struggles. Market context of the era. What the world looked like.' },
  { id: 3, name: 'EARLY_PRODUCT', turns: 25, description: 'First product/service. How it actually worked mechanically. Early customers. The insight that made it work.' },
  { id: 4, name: 'INFLECTION_1', turns: 25, description: 'First major decision. Board meeting details. What alternatives existed. Quotes from people who were there.' },
  { id: 5, name: 'SCALE', turns: 25, description: 'How they scaled. Operational details. What broke. How they fixed it. Specific numbers.' },
  { id: 6, name: 'INFLECTION_2', turns: 25, description: 'Second pivot or crisis. The moment it almost fell apart. How they survived.' },
  { id: 7, name: 'COMPETITION', turns: 20, description: 'Competitive landscape. Who they beat and how. Who almost beat them.' },
  { id: 8, name: 'CULTURE', turns: 20, description: 'Internal culture. Leadership philosophy. Quotes from employees. What makes them different.' },
  { id: 9, name: 'NOW', turns: 20, description: 'Current state with specific metrics. Recent moves. Open questions. What could go wrong.' },
  { id: 10, name: 'TAKEAWAYS', turns: 15, description: 'Key frameworks. What other companies can learn. Final thought tying back to hook.' },
];

const VOICES = {
  Person1: 'alloy',   // Maya
  Person2: 'echo',    // James
};

const log = (msg) => console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`);

// ============ LLM CALLS ============

async function llm(prompt, model = 'gpt-5.2', maxTokens = 8000) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: maxTokens,
      temperature: 0.8,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function llmO3(prompt) {
  // Use o3 for reasoning-heavy tasks
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'o3',
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 16000,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`o3 API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ============ RESEARCH ============

async function runGeminiResearch(topic) {
  log('Running Gemini Deep Research...');
  const start = Date.now();
  
  const result = execSync(
    `cd /home/elie/github/clawdis/skills/deepresearch && ./scripts/deepresearch.sh "${topic}"`,
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, timeout: 600000 }
  );
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`Gemini research complete in ${elapsed}s`);
  
  return result;
}

async function runBraveSearch(query, count = 5) {
  try {
    const result = execSync(
      `node /home/elie/github/clawdis/skills/brave-search/scripts/search.mjs "${query}" -n ${count} --content 2>/dev/null`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
    );
    return result;
  } catch (e) {
    return '';
  }
}

async function runExaSearch(query) {
  try {
    const result = execSync(
      `node /home/elie/github/clawdis/skills/researcher/scripts/research.mjs "${query}" 2>/dev/null`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 120000 }
    );
    return result;
  } catch (e) {
    return '';
  }
}

async function multiLayerResearch(topic, company, outputDir) {
  log('Starting 5-layer deep research...');
  const research = {};
  
  // Layer 1: Overview (Gemini)
  log('  Layer 1/5: Overview (Gemini)...');
  research.overview = await runGeminiResearch(topic);
  writeFileSync(join(outputDir, 'research-1-overview.md'), research.overview);
  
  // Layer 2: Founder stories
  log('  Layer 2/5: Founder interviews...');
  research.founders = await runBraveSearch(`"${company}" founder interview quotes early days story`, 8);
  writeFileSync(join(outputDir, 'research-2-founders.md'), research.founders);
  
  // Layer 3: Key decisions (contemporary coverage)
  log('  Layer 3/5: Contemporary coverage...');
  research.decisions = await runBraveSearch(`"${company}" site:wsj.com OR site:nytimes.com OR site:forbes.com history`, 8);
  writeFileSync(join(outputDir, 'research-3-decisions.md'), research.decisions);
  
  // Layer 4: Financial/operational details
  log('  Layer 4/5: Financial details...');
  research.financials = await runBraveSearch(`"${company}" revenue profit margin business model analysis`, 5);
  writeFileSync(join(outputDir, 'research-4-financials.md'), research.financials);
  
  // Layer 5: Contrarian/struggles
  log('  Layer 5/5: Struggles and criticism...');
  research.contrarian = await runBraveSearch(`"${company}" almost failed crisis problems criticism`, 5);
  writeFileSync(join(outputDir, 'research-5-contrarian.md'), research.contrarian);
  
  // Combine all research
  const combined = `# RESEARCH COMPILATION: ${company}

## PART 1: OVERVIEW
${research.overview}

## PART 2: FOUNDER STORIES & INTERVIEWS
${research.founders}

## PART 3: CONTEMPORARY COVERAGE & KEY DECISIONS
${research.decisions}

## PART 4: FINANCIAL & OPERATIONAL DETAILS
${research.financials}

## PART 5: STRUGGLES, CRISES & CRITICISM
${research.contrarian}
`;
  
  writeFileSync(join(outputDir, 'research-combined.md'), combined);
  log('All research layers complete');
  
  return combined;
}

async function synthesizeResearch(research, company, outputDir) {
  log('Synthesizing research with o3...');
  
  const prompt = `You are a research analyst preparing materials for a deep-dive podcast about ${company}.

From this research, extract:

1. **50 MOST SURPRISING FACTS** - specific numbers, dates, details that would make someone say "Wait, really?"

2. **10 BEST QUOTES** - actual quotes from founders, employees, or articles WITH attribution
   Format: "Quote here" — Person Name, Source, Year

3. **5 "WAIT REALLY?" MOMENTS** - the most counterintuitive or shocking facts

4. **KEY TIMELINE** - 15-20 most important dates with specific events

5. **NARRATIVE THREADS** - the 3-4 main story arcs that make this company interesting

6. **CONTRARIAN TAKES** - what critics say, what almost went wrong, the messy parts

7. **NUMBERS THAT MATTER** - specific metrics that tell the story (revenue, margins, users, etc.)

Be SPECIFIC. Include actual numbers, names, dates. No generic statements.

RESEARCH:
${research.slice(0, 100000)}`;

  const synthesis = await llmO3(prompt);
  writeFileSync(join(outputDir, 'research-synthesis.md'), synthesis);
  
  log('Research synthesis complete');
  return synthesis;
}

// ============ SCRIPT GENERATION ============

function buildSectionPrompt(section, research, synthesis, topic, hook, prevContext, isDeep, usedFacts = []) {
  const contextSize = isDeep ? 25000 : 10000;
  
  const introPrompt = section.name === 'INTRO' ? `
## INTRO REQUIREMENTS
- Start with "Welcome back to The Builders..."
- Maya introduces herself, then James
- Brief friendly banter about what excited them in the research
- Name the company: "Today we're diving into ${topic}"
- Tease 2-3 surprising things they'll cover
- End with natural transition to the hook
` : '';

  const hookLine = section.name === 'HOOK' ? `
## OPENING HOOK TO BUILD ON
"${hook}"
` : '';

  const synthesisSection = synthesis ? `
## KEY FACTS & QUOTES TO USE
${synthesis.slice(0, 15000)}
` : '';

  // DEDUPLICATION: List facts already used in previous sections
  const usedFactsSection = usedFacts.length > 0 ? `
## ⛔ FACTS ALREADY USED - DO NOT REPEAT THESE
The following facts, quotes, and statistics have already been mentioned in earlier sections.
DO NOT use them again. Find NEW facts from the research.

${usedFacts.map((f, i) => `${i+1}. ${f}`).join('\n')}

** IMPORTANT: Using any fact from the above list is a critical error. Use DIFFERENT facts.**
` : '';

  return `# Generate Section ${section.id}: ${section.name}

${BIBLE}

## YOUR TASK
Write EXACTLY ${section.turns} dialogue turns for the ${section.name} section.
This should feel like two friends discovering a story together, NOT a lecture.

## SECTION GOAL
${section.description}

${introPrompt}
${hookLine}

${usedFactsSection}

## FORMAT RULES
- Use <Person1> (Maya) and <Person2> (James) XML tags
- Each turn: 2-5 sentences - real conversation, not speeches
- Include AT LEAST 3 interruptions ("Wait—", "Hold on—", "Back up—")
- Include AT LEAST 3 genuine reactions ("That's insane", "Wait, really?", "I had no idea")
- USE SPECIFIC QUOTES from the research with attribution
- USE SPECIFIC NUMBERS and dates
- Maya asks technical "how does this work" questions
- James provides strategic context and patterns
- They BUILD on each other, not just take turns
- **DO NOT REPEAT** any facts from earlier sections

${synthesisSection}

## RESEARCH
${research.slice(0, contextSize)}

${prevContext ? `## PREVIOUS CONTEXT\n${prevContext}\n` : ''}

---
Generate EXACTLY ${section.turns} turns. Start with <!-- SECTION ${section.id}: ${section.name} -->
Include at least 3 NEW specific facts/quotes from the research (not used before). Make it feel like genuine discovery.`;
}

// Extract key facts from a section for deduplication
async function extractFactsFromSection(sectionText) {
  const prompt = `Extract the KEY FACTS mentioned in this podcast section. List each unique fact as a short phrase.

Focus on:
- Specific numbers (dollars, percentages, counts)
- Specific dates and years
- Direct quotes with attribution
- Named events or milestones
- Specific products, prices, or metrics

Return ONLY a JSON array of strings, each being a short fact (10-20 words max).
Example: ["$1.50 hot dog price unchanged since 1985", "93.3% renewal rate in US/Canada"]

Section:
${sectionText}`;

  try {
    const result = await llm(prompt, 'gpt-4o-mini', 2000);
    const match = result.match(/\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (e) {
    // Fallback: extract numbers and quotes manually
  }
  
  // Fallback extraction
  const facts = [];
  // Extract quotes
  const quotes = sectionText.match(/"[^"]+"\s*—[^<]+/g) || [];
  facts.push(...quotes.slice(0, 5).map(q => q.slice(0, 100)));
  
  // Extract numbers with context
  const numbers = sectionText.match(/\$[\d,.]+ (?:million|billion|percent|%)|[\d,]+% |[\d,]+ (?:SKU|warehouse|employee|member|year)/gi) || [];
  facts.push(...[...new Set(numbers)].slice(0, 10));
  
  return facts;
}

// ============ TTS ============

async function generateTTS(turns, outputDir) {
  const audioDir = join(outputDir, 'audio');
  if (existsSync(audioDir)) rmSync(audioDir, { recursive: true });
  mkdirSync(audioDir, { recursive: true });
  
  log(`Generating TTS for ${turns.length} turns...`);
  const start = Date.now();
  
  // Process in batches of 15
  for (let i = 0; i < turns.length; i += 15) {
    const batch = turns.slice(i, i + 15);
    const promises = batch.map(async (turn, j) => {
      const idx = i + j;
      const num = String(idx + 1).padStart(4, '0');
      const voice = VOICES[turn.speaker];
      const outPath = join(audioDir, `turn-${num}.mp3`);
      
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1-hd',
          input: turn.text.slice(0, 4096),
          voice: voice,
        }),
      });
      
      if (!res.ok) return null;
      const buffer = await res.arrayBuffer();
      writeFileSync(outPath, Buffer.from(buffer));
      return outPath;
    });
    
    await Promise.all(promises);
    log(`  ${Math.min(i + 15, turns.length)}/${turns.length} turns`);
  }
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`TTS complete in ${elapsed}s`);
  
  // Merge with ffmpeg
  const files = readdirSync(audioDir).filter(f => f.endsWith('.mp3')).sort();
  const listPath = join(audioDir, 'files.txt');
  writeFileSync(listPath, files.map(f => `file '${join(audioDir, f)}'`).join('\n'));
  
  const episodePath = join(outputDir, 'episode.mp3');
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${episodePath}" 2>/dev/null`);
  
  const duration = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${episodePath}"`,
    { encoding: 'utf-8' }
  ).trim();
  
  return { path: episodePath, duration: parseFloat(duration) };
}

// ============ MAIN ============

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage: node generate.mjs "<topic>" [options]

Modes:
  --quick              15-20 min episode, single research pass (default)
  --deep               45-60 min episode, multi-layer research + synthesis

Options:
  -o, --output <dir>   Output directory (default: ./output)
  -m, --model <model>  LLM model (default: gpt-5.2)
  --skip-research      Skip research phase (use existing)
  --skip-tts           Skip TTS generation
  --help               Show this help

Features:
  - Auto-resume: If process dies, re-run same command to resume from checkpoint
  - Deduplication: Tracks facts across sections to prevent repetition
  - Checkpoints saved to: <output>/checkpoints/

Examples:
  node generate.mjs "Costco" --quick -o /tmp/costco
  node generate.mjs "OpenAI" --deep -o /tmp/openai
  
  # Resume interrupted generation (just re-run same command):
  node generate.mjs "OpenAI" --deep -o /tmp/openai
`);
    process.exit(0);
  }
  
  const topic = args[0];
  const outputDir = args.includes('-o') ? args[args.indexOf('-o') + 1] : './output';
  const model = args.includes('-m') ? args[args.indexOf('-m') + 1] : 'gpt-5.2';
  const isDeep = args.includes('--deep');
  const skipResearch = args.includes('--skip-research');
  const skipTTS = args.includes('--skip-tts');
  
  // Extract company name from topic
  const company = topic.split(':')[0].split(' ')[0];
  
  const SECTIONS = isDeep ? SECTIONS_DEEP : SECTIONS_QUICK;
  const targetTurns = SECTIONS.reduce((sum, s) => sum + s.turns, 0);
  const targetDuration = isDeep ? '45-60' : '15-20';
  
  mkdirSync(outputDir, { recursive: true });
  
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  The Builders Podcast Generator                            ║
║  Mode: ${isDeep ? 'DEEP DIVE (45-60 min)' : 'QUICK DIVE (15-20 min)'}                          ║
║  Target: ${targetTurns} turns                                         ║
╚════════════════════════════════════════════════════════════╝
`);
  
  log(`Topic: ${topic}`);
  log(`Output: ${outputDir}`);
  log(`Model: ${model}`);
  
  // ---- RESEARCH ----
  let research, synthesis = '';
  const researchPath = join(outputDir, isDeep ? 'research-combined.md' : 'research.md');
  const synthesisPath = join(outputDir, 'research-synthesis.md');
  
  if (skipResearch && existsSync(researchPath)) {
    log('Using existing research...');
    research = readFileSync(researchPath, 'utf-8');
    if (isDeep && existsSync(synthesisPath)) {
      synthesis = readFileSync(synthesisPath, 'utf-8');
    }
  } else if (isDeep) {
    // Multi-layer research for deep dive
    research = await multiLayerResearch(topic, company, outputDir);
    synthesis = await synthesizeResearch(research, company, outputDir);
  } else {
    // Single pass for quick dive
    research = await runGeminiResearch(topic);
    writeFileSync(researchPath, research);
  }
  
  // ---- GENERATE HOOK ----
  log('Generating hook...');
  const hookPrompt = `Based on this research about ${topic}, generate 3 compelling opening hooks:

1. A SCENE hook - put us in a specific moment (boardroom, product launch, near-bankruptcy)
2. A DATA hook - a surprising statistic that reframes everything  
3. A QUESTION hook - a provocative central question

Each should be 2-3 sentences, vivid, specific. Mark the best one with [SELECTED].

${isDeep ? 'Use specific details from the research - names, dates, numbers.' : ''}

Research:
${research.slice(0, 15000)}`;

  const hookResponse = await llm(hookPrompt, model);
  writeFileSync(join(outputDir, 'hooks.md'), hookResponse);
  
  // Extract selected hook
  const hookMatch = hookResponse.match(/\[SELECTED\][\s\S]*?[""]([^""]+)[""]/);
  const hook = hookMatch ? hookMatch[1] : "This is a story that will change how you think about business.";
  log(`Hook: "${hook.slice(0, 80)}..."`);
  
  // ---- GENERATE SECTIONS (with checkpointing) ----
  log(`Generating ${SECTIONS.length} script sections...`);
  const allSections = [];
  let prevContext = '';
  let totalTurns = 0;
  let usedFacts = []; // Track facts across sections for deduplication
  
  // Checkpoint paths
  const checkpointDir = join(outputDir, 'checkpoints');
  const checkpointState = join(checkpointDir, 'state.json');
  mkdirSync(checkpointDir, { recursive: true });
  
  // Load existing checkpoint if resuming
  let startSection = 0;
  if (existsSync(checkpointState)) {
    try {
      const state = JSON.parse(readFileSync(checkpointState, 'utf-8'));
      startSection = state.completedSections || 0;
      usedFacts = state.usedFacts || [];
      prevContext = state.prevContext || '';
      log(`📂 Resuming from checkpoint: section ${startSection}/${SECTIONS.length}`);
      
      // Load existing sections
      for (let i = 0; i < startSection; i++) {
        const sectionPath = join(checkpointDir, `section-${i}.txt`);
        if (existsSync(sectionPath)) {
          const content = readFileSync(sectionPath, 'utf-8');
          allSections.push(content);
          totalTurns += (content.match(/<Person[12]>/g) || []).length;
        }
      }
      log(`   Loaded ${allSections.length} existing sections (${totalTurns} turns)`);
    } catch (e) {
      log('⚠️ Checkpoint corrupted, starting fresh');
      startSection = 0;
    }
  }
  
  for (const section of SECTIONS) {
    // Skip already completed sections
    if (section.id < startSection) {
      continue;
    }
    
    const start = Date.now();
    log(`  Section ${section.id}: ${section.name} (target: ${section.turns})...`);
    
    const prompt = buildSectionPrompt(
      section, research, synthesis, topic, hook, prevContext, isDeep, usedFacts
    );
    const result = await llm(prompt, model, isDeep ? 12000 : 8000);
    
    const turns = (result.match(/<Person[12]>/g) || []).length;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`    → ${turns} turns in ${elapsed}s`);
    
    allSections.push(result);
    prevContext = result.slice(0, isDeep ? 1500 : 800);
    totalTurns += turns;
    
    // Save section checkpoint immediately
    writeFileSync(join(checkpointDir, `section-${section.id}.txt`), result);
    
    // Extract facts from this section to prevent repetition in future sections
    if (isDeep && section.id < SECTIONS.length - 1) {
      log(`    Extracting facts for deduplication...`);
      const newFacts = await extractFactsFromSection(result);
      usedFacts = [...usedFacts, ...newFacts].slice(-100); // Keep last 100 facts
      log(`    ${newFacts.length} facts tracked (${usedFacts.length} total)`);
    }
    
    // Save checkpoint state after each section
    writeFileSync(checkpointState, JSON.stringify({
      completedSections: section.id + 1,
      usedFacts,
      prevContext,
      timestamp: new Date().toISOString()
    }, null, 2));
    log(`    💾 Checkpoint saved`);
  }
  
  // Combine script
  const fullScript = allSections.join('\n\n');
  writeFileSync(join(outputDir, 'script.txt'), fullScript);
  log(`Script complete: ${totalTurns} total turns`);
  
  // ---- TTS ----
  if (!skipTTS) {
    // Parse turns
    const turns = [];
    const regex = /<(Person[12])>([\s\S]*?)<\/Person[12]>/g;
    let match;
    while ((match = regex.exec(fullScript)) !== null) {
      turns.push({ speaker: match[1], text: match[2].trim() });
    }
    
    log(`Parsed ${turns.length} speaker turns`);
    log(`  Maya (Person1): ${turns.filter(t => t.speaker === 'Person1').length}`);
    log(`  James (Person2): ${turns.filter(t => t.speaker === 'Person2').length}`);
    
    const { path, duration } = await generateTTS(turns, outputDir);
    
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  Generation Complete                                       ║
╠════════════════════════════════════════════════════════════╣
║  Mode: ${isDeep ? 'DEEP DIVE' : 'QUICK DIVE'}                                         ║
║  Total turns: ${String(totalTurns).padEnd(44)}║
║  Duration: ${String((duration / 60).toFixed(1) + ' minutes').padEnd(47)}║
║  Output: ${path.slice(-50).padEnd(49)}║
╚════════════════════════════════════════════════════════════╝
`);
  } else {
    log('TTS skipped');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
