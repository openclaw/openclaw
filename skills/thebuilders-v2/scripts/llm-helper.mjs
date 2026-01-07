#!/usr/bin/env node
/**
 * Simple LLM helper using OpenAI API directly
 */

import { readFileSync } from 'fs';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export async function llm(prompt, model = 'gpt-4o') {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16000,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// CLI mode
if (process.argv[1].endsWith('llm-helper.mjs')) {
  const input = readFileSync(0, 'utf-8'); // stdin
  const model = process.argv[2] || 'gpt-4o';
  
  llm(input, model)
    .then(result => console.log(result))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
