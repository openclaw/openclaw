#!/usr/bin/env node
/**
 * Section-by-section podcast script generator
 * Generates each section separately to ensure proper length
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Section definitions with turn targets
const SECTIONS = [
  { id: 1, name: 'HOOK', turns: 15, minutes: '3-4', description: 'Opening hook, establish central question, create curiosity' },
  { id: 2, name: 'ORIGIN', turns: 25, minutes: '6-7', description: 'Founders, genesis, early bet, market context, human element' },
  { id: 3, name: 'INFLECTION_1', turns: 20, minutes: '5-6', description: 'First major decision point, alternatives, stakes, outcome' },
  { id: 4, name: 'INFLECTION_2', turns: 20, minutes: '5-6', description: 'Second pivot, new challenge, adaptation, insight' },
  { id: 5, name: 'MESSY_MIDDLE', turns: 15, minutes: '3-4', description: 'Near-death moments, internal conflicts, survival' },
  { id: 6, name: 'NOW', turns: 15, minutes: '3-4', description: 'Current position, competition, open questions' },
  { id: 7, name: 'TAKEAWAYS', turns: 12, minutes: '2-3', description: 'Key lessons, frameworks, final thought' },
];

const TOTAL_TURNS = SECTIONS.reduce((sum, s) => sum + s.turns, 0);

const log = (msg) => console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`);

async function llm(prompt, model = 'gpt-5.2') {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 8000,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function buildSectionPrompt(section, research, hook, previousSections) {
  const hostsInfo = `
## The Hosts

**Maya Chen (Person1):**
- Former software engineer, B2B SaaS founder
- Lens: "How does this actually work?" - technical, mechanical
- Skeptical of hype, wants specifics and numbers
- Phrases: "Wait, slow down.", "Show me the numbers.", "That's actually clever because..."

**James Porter (Person2):**
- Former VC, business history student  
- Lens: "What's the business model?" - strategy, markets, competitive dynamics
- Synthesizer, pattern matcher, historical parallels
- Phrases: "For context...", "This is the classic [X] playbook.", "The lesson here is..."
`;

  const formatRules = `
## Format Rules
- Use <Person1> and <Person2> XML tags for each speaker
- Each turn: 2-5 sentences (natural conversation, not monologues)
- Include discovery moments: "Wait, really?", "I had no idea!"
- Use SPECIFIC numbers, dates, dollar amounts from research
- Both hosts should react naturally and build on each other
`;

  const previousContext = previousSections.length > 0 
    ? `\n## Previous Sections (for context, don't repeat):\n${previousSections.join('\n\n')}\n`
    : '';

  const sectionSpecific = {
    HOOK: `Open with this hook and build on it:\n"${hook}"\n\nEstablish why this story matters. Create curiosity about what's coming.`,
    ORIGIN: `Cover the founding story. Who are the founders? What sparked this? What was their early bet? Make them human and relatable.`,
    INFLECTION_1: `Cover the FIRST major decision/pivot point. What choice did they face? What alternatives existed? What did they risk? How did it play out?`,
    INFLECTION_2: `Cover the SECOND major inflection point. What new challenge emerged? How did they adapt? What insight did they gain?`,
    MESSY_MIDDLE: `Cover the struggles. What almost killed them? What internal conflicts existed? Don't glorify - show real struggle.`,
    NOW: `Cover current state. Where are they now? Key metrics? Competitive position? What questions remain open?`,
    TAKEAWAYS: `Wrap up with lessons learned. What's the key framework? What would you do differently? End with a memorable final thought that ties back to the hook.`,
  };

  return `# Generate Section ${section.id}: ${section.name}

${hostsInfo}

## Your Task
Generate EXACTLY ${section.turns} dialogue turns for the ${section.name} section.
Target duration: ${section.minutes} minutes when read aloud.

## Section Goal
${section.description}

## Specific Instructions
${sectionSpecific[section.name]}

${formatRules}

${previousContext}

## Research Material
${research}

---

Generate EXACTLY ${section.turns} dialogue turns. Start with <!-- SECTION ${section.id}: ${section.name} --> then <Person1> or <Person2>.
Count your turns carefully - you MUST hit ${section.turns} turns.`;
}

async function generateSection(section, research, hook, previousSections) {
  log(`Generating Section ${section.id}: ${section.name} (target: ${section.turns} turns)...`);
  
  const prompt = buildSectionPrompt(section, research, hook, previousSections);
  const startTime = Date.now();
  
  const result = await llm(prompt);
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const turns = (result.match(/<Person[12]>/g) || []).length;
  
  log(`Section ${section.id} complete: ${turns} turns in ${elapsed}s`);
  
  return { section, result, turns };
}

async function main() {
  const args = process.argv.slice(2);
  const outputDir = args.includes('-o') ? args[args.indexOf('-o') + 1] : './output';
  
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  Section-by-Section Podcast Generator                      ║
║  Target: ${TOTAL_TURNS} dialogue turns                                  ║
╚════════════════════════════════════════════════════════════╝
`);

  // Load research and hook
  const research = readFileSync(join(outputDir, '02-research.md'), 'utf-8');
  const hooksFile = readFileSync(join(outputDir, '03-hooks.md'), 'utf-8');
  const hookMatch = hooksFile.match(/## Story Hook\n\n> "([^"]+)"/);
  const hook = hookMatch ? hookMatch[1] : '';
  
  log(`Loaded research (${(research.length/1024).toFixed(1)}KB) and hook`);
  log(`Hook: "${hook.slice(0, 60)}..."`);
  
  // Generate sections sequentially
  const sections = [];
  const previousSections = [];
  let totalTurns = 0;
  
  for (const section of SECTIONS) {
    const { result, turns } = await generateSection(section, research, hook, previousSections);
    sections.push(result);
    previousSections.push(result.slice(0, 500) + '...'); // Keep context manageable
    totalTurns += turns;
  }
  
  // Combine all sections
  const fullScript = sections.join('\n\n');
  writeFileSync(join(outputDir, '06-script-final.txt'), fullScript);
  
  log(`\n✅ Script complete: ${totalTurns} total turns`);
  log(`Saved to ${join(outputDir, '06-script-final.txt')}`);
  
  // Generate audio
  log('\nGenerating audio...');
  
  // Chunk the script
  const chunksDir = join(outputDir, 'chunks');
  mkdirSync(chunksDir, { recursive: true });
  
  const chunks = [];
  let currentChunk = '';
  for (const line of fullScript.split('\n')) {
    if (currentChunk.length + line.length > 3500 && currentChunk.length > 1000) {
      if (line.startsWith('<Person') || line.startsWith('<!--')) {
        chunks.push(currentChunk.trim());
        currentChunk = line + '\n';
      } else {
        currentChunk += line + '\n';
      }
    } else {
      currentChunk += line + '\n';
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  
  log(`Split into ${chunks.length} audio chunks`);
  
  // Save chunks
  chunks.forEach((chunk, i) => {
    const num = String(i + 1).padStart(3, '0');
    writeFileSync(join(chunksDir, `chunk-${num}.txt`), chunk);
  });
  
  // Generate TTS in parallel
  const ttsStart = Date.now();
  const audioPromises = chunks.map(async (chunk, i) => {
    const num = String(i + 1).padStart(3, '0');
    const text = chunk
      .replace(/<Person1>/g, '')
      .replace(/<Person2>/g, '')
      .replace(/<!--[^>]+-->/g, '')
      .trim()
      .slice(0, 4096);
    
    const outPath = join(chunksDir, `chunk-${num}.mp3`);
    
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: i % 2 === 0 ? 'nova' : 'onyx',
      }),
    });
    
    if (!res.ok) throw new Error(`TTS failed for chunk ${num}`);
    
    const buffer = await res.arrayBuffer();
    writeFileSync(outPath, Buffer.from(buffer));
    log(`Chunk ${num} audio done`);
    return outPath;
  });
  
  const audioPaths = await Promise.all(audioPromises);
  log(`TTS complete in ${((Date.now() - ttsStart) / 1000).toFixed(1)}s`);
  
  // Merge with ffmpeg
  const listFile = join(chunksDir, 'files.txt');
  writeFileSync(listFile, audioPaths.map(p => `file '${p}'`).join('\n'));
  
  const episodePath = join(outputDir, 'episode.mp3');
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${episodePath}" 2>/dev/null`);
  
  // Get duration
  const duration = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${episodePath}"`, { encoding: 'utf-8' }).trim();
  const minutes = (parseFloat(duration) / 60).toFixed(1);
  
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  Generation Complete                                       ║
╠════════════════════════════════════════════════════════════╣
║  Total turns: ${String(totalTurns).padEnd(44)}║
║  Duration: ${String(minutes + ' minutes').padEnd(47)}║
║  Chunks: ${String(chunks.length).padEnd(49)}║
╚════════════════════════════════════════════════════════════╝

Output: ${episodePath}
`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
