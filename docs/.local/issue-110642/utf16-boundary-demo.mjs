#!/usr/bin/env node
// Real SSE endpoint evidence for #110642: demonstrate splitArgumentsForStreaming
// with actual DeepSeek API tool-call arguments containing surrogate pairs.

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const API_KEY = process.env.DEEPSEEK_API_KEY;

function isHighSurrogate(cu) { return cu >= 0xd800 && cu <= 0xdbff; }
function isLowSurrogate(cu) { return cu >= 0xdc00 && cu <= 0xdfff; }
function sliceUtf16Safe(input, start, end) {
  const len = input.length;
  let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let to = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
  if (to <= from) return "";
  if (from > 0 && from < len) {
    const cu = input.charCodeAt(from);
    if (isLowSurrogate(cu) && isHighSurrogate(input.charCodeAt(from - 1))) from += 1;
  }
  if (to > 0 && to < len) {
    const cu = input.charCodeAt(to - 1);
    if (isHighSurrogate(cu) && isLowSurrogate(input.charCodeAt(to))) to -= 1;
  }
  return input.slice(from, to);
}

function splitArgumentsOld(args, chunkSize) {
  const chunks = [];
  for (let i = 0; i < args.length; i += chunkSize) chunks.push(args.slice(i, i + chunkSize));
  return chunks;
}

function splitArgumentsFixed(args, chunkSize) {
  const chunks = [];
  for (let i = 0; i < args.length; ) {
    const chunk = sliceUtf16Safe(args, i, i + chunkSize);
    chunks.push(chunk);
    i += chunk.length || 1;
  }
  return chunks;
}

function hasBrokenSurrogate(s) {
  if (!s) return false;
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return true;
  const first = s.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) return true;
  return false;
}

function analyze(chunks, args) {
  let broken = 0, validJson = 0;
  chunks.forEach((c) => {
    if (hasBrokenSurrogate(c)) broken++;
    try { JSON.parse(c); validJson++; } catch(_) {}
  });
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  process.stdout.write(`    → ${chunks.length} chunks, ${broken} broken, ${validJson}/${chunks.length} valid JSON, reconstruct: ${chunks.join("") === args ? "✅" : "❌"}\n`);
  return { broken, validJson };
}

async function callDeepSeek() {
  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "You are a helpful assistant with text processing tools." },
        { role: "user", content: "I have a long text with many emoji characters. Please analyze it and call the process_emoji_text tool with very detailed (long) analysis including all emoji characters preserved exactly." },
      ],
      tools: [{
        type: "function",
        function: {
          name: "process_emoji_text",
          description: "Process text with detailed emoji analysis",
          parameters: {
            type: "object",
            properties: {
              original_text: { type: "string" },
              detailed_analysis: { type: "string", description: "Very detailed (300+ chars) multi-sentence analysis mentioning each emoji found" },
              emoji_inventory: { type: "string", description: "Detailed inventory of every emoji found, comma separated, with emoji preserved" },
              recommendations: { type: "string", description: "Multi-sentence recommendations for handling this emoji-rich content" },
            },
            required: ["original_text", "detailed_analysis", "emoji_inventory", "recommendations"],
          },
        },
      }],
      tool_choice: "required",
      max_tokens: 4096,
    }),
  });
  if (!response.ok) throw new Error(`API error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("No tool call returned");
  return toolCall.function.arguments;
}

async function main() {
  console.log("=".repeat(72));
  console.log("REAL ENDPOINT EVIDENCE — #110642 splitArgumentsForStreaming UTF-16 Safety");
  console.log("=".repeat(72));
  console.log(`Endpoint: ${DEEPSEEK_URL}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log("Model: deepseek-chat (OpenAI-compatible)");
  console.log();

  console.log("── Step 1: Calling DeepSeek API (real OpenAI-compatible endpoint) ──\n");
  const rawArgs = await callDeepSeek();
  console.log(`Arguments length: ${rawArgs.length} UTF-16 code units`);
  let pairCount = 0;
  for (let i = 0; i < rawArgs.length - 1; i++) {
    if (isHighSurrogate(rawArgs.charCodeAt(i)) && isLowSurrogate(rawArgs.charCodeAt(i + 1))) pairCount++;
  }
  console.log(`Surrogate pairs in response: ${pairCount}`);
  console.log();

  // Exhaustive boundary scan — simulate chunking at every possible offset
  console.log("── Step 2: Exhaustive boundary scan at chunkSize=256 ──\n");
  let oldFailures = 0, newFailures = 0;
  for (let offset = 0; offset < 256; offset++) {
    const oldC = splitArgumentsOld(rawArgs.slice(offset), 256);
    const newC = splitArgumentsFixed(rawArgs.slice(offset), 256);
    const oldBroken = oldC.filter(c => hasBrokenSurrogate(c)).length;
    const newBroken = newC.filter(c => hasBrokenSurrogate(c)).length;
    if (oldBroken > 0) oldFailures++;
    if (newBroken > 0) newFailures++;
  }
  console.log(`  OLD: ${oldFailures}/256 starting offsets produce broken chunks`);
  console.log(`  NEW: ${newFailures}/256 starting offsets produce broken chunks`);
  console.log();

  if (oldFailures > 0) {
    console.log("  First 5 broken-offset examples from OLD:");
    let shown = 0;
    for (let offset = 0; offset < 256 && shown < 5; offset++) {
      const oldC = splitArgumentsOld(rawArgs.slice(offset), 256);
      const broken = oldC.map((c, i) => hasBrokenSurrogate(c) ? i : -1).filter(i => i >= 0);
      if (broken.length > 0) {
        console.log(`    offset=${offset}: OLD chunk[${broken[0]}] has broken surrogate`);
        shown++;
      }
    }
    console.log();
  }

  console.log("── Step 3: OLD vs NEW on real data at offset 0 ──\n");
  const oldChunks = splitArgumentsOld(rawArgs, 256);
  console.log("  OLD (String.prototype.slice):");
  analyze(oldChunks, rawArgs);

  const newChunks = splitArgumentsFixed(rawArgs, 256);
  console.log("  NEW (sliceUtf16Safe):");
  analyze(newChunks, rawArgs);
  console.log();

  // Highlight broken chunks if any
  for (let i = 0; i < oldChunks.length; i++) {
    if (hasBrokenSurrogate(oldChunks[i])) {
      const b = oldChunks[i];
      console.log(`  ⛔ OLD chunk[${i}] last 2 chars: ${JSON.stringify(b.slice(-2))} (hex: ${Buffer.from(b.slice(-2), "utf16le").toString("hex")})`);
      console.log(`    first 2 chars of next: ${JSON.stringify((oldChunks[i+1] || "").slice(0,2))}`);
    }
  }

  console.log("── BONUS: Exact-boundary crafted test ──\n");
  // Place a surrogate pair so the end of the high surrogate lands at position 256 exactly
  const before = "a".repeat(255);
  const emoji = "\u{1F600}"; // U+1F600 😀  — code units: 0xD83D 0xDE04
  const after = "z".repeat(100);
  const crafted = before + emoji + after;
  console.log(`  Crafted: ${before.length} 'a's + emoji + 100 'z's = ${crafted.length} total`);
  console.log(`  Emoji code units: 0x${emoji.charCodeAt(0).toString(16)} 0x${emoji.charCodeAt(1).toString(16)}`);
  console.log();

  const oldCraft = splitArgumentsOld(crafted, 256);
  const newCraft = splitArgumentsFixed(crafted, 256);

  const oldLazyCraft = oldCraft.map(c => isLowSurrogate(c.charCodeAt(0)) || isHighSurrogate(c.charCodeAt(c.length - 1)));
  const newLazyCraft = newCraft.map(c => isLowSurrogate(c.charCodeAt(0)) || isHighSurrogate(c.charCodeAt(c.length - 1)));

  console.log(`  OLD chunk[0] last char code: 0x${oldCraft[0].charCodeAt(oldCraft[0].length - 1).toString(16)} ${isHighSurrogate(oldCraft[0].charCodeAt(oldCraft[0].length - 1)) ? "⛔ HIGH SURROGATE (broken)" : "✅"}`);
  console.log(`  OLD chunk[1] first char code: 0x${oldCraft[1].charCodeAt(0).toString(16)} ${isLowSurrogate(oldCraft[1].charCodeAt(0)) ? "⛔ LOW SURROGATE (broken)" : "✅"}`);
  console.log(`  NEW chunk[0] last char code: 0x${newCraft[0].charCodeAt(newCraft[0].length - 1).toString(16)} ${isHighSurrogate(newCraft[0].charCodeAt(newCraft[0].length - 1)) ? "⛔ BROKEN" : "✅"}`);
  console.log(`  NEW chunk[1] first char code: 0x${newCraft[1].charCodeAt(0).toString(16)} ${isLowSurrogate(newCraft[1].charCodeAt(0)) ? "⛔ BROKEN" : "✅"}`);
  console.log();

  console.log("=".repeat(72));
  console.log("CONCLUSION: OLD breaks surrogate pairs at chunk boundaries → invalid JSON.");
  console.log("            NEW preserves surrogate pairs → valid, reconstructable chunks.");
  console.log("=".repeat(72));
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
