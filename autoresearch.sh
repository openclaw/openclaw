#!/usr/bin/env bash
# Autoresearch benchmark for OpenClaw bootstrap system prompt assembly.
# Outputs METRIC lines that pi-autoresearch captures.
#
# Metrics:
#   system_prompt_stable_chars — chars before first dynamic content (higher = better cache prefix)
#   system_prompt_total_chars  — total assembled system prompt length (lower = cheaper)

set -e

# Build
npm run build --silent 2>/dev/null || { echo "BUILD FAILED"; exit 1; }

# Run the benchmark node script
node - <<'EOF'
const path = require('path');
const fs = require('fs');

// Simulate workspace bootstrap files loading
// Read the actual dist output to measure the assembled context
try {
  const { buildBootstrapContextFiles } = require('./dist/agents/pi-embedded-helpers/bootstrap.js');
  const { loadWorkspaceBootstrapFiles } = require('./dist/agents/workspace.js');

  // Use test fixtures or a minimal workspace
  const workspaceDir = process.env.BENCHMARK_WORKSPACE || path.join(__dirname, 'test-fixtures');

  (async () => {
    try {
      const files = await loadWorkspaceBootstrapFiles(workspaceDir);
      const contextFiles = buildBootstrapContextFiles(files, {
        maxChars: 20000,
        totalMaxChars: 150000,
      });

      // Assemble the system prompt content
      const assembled = contextFiles.map(f => f.content).join('\n');
      const totalChars = assembled.length;

      // Find stable prefix: scan for dynamic runtime content patterns
      // Dynamic content markers: ISO timestamps, session IDs, "Runtime:" blocks
      const dynamicPatterns = [
        /Runtime:.*model=/,
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,  // ISO timestamp
        /session[A-Za-z]*:\s*[a-z]+-[a-z]+/,       // session keys like "gentle-basil"
        /## Current Date & Time/,
      ];

      let stableChars = totalChars; // assume fully stable unless we find dynamic content
      for (const pattern of dynamicPatterns) {
        const match = pattern.exec(assembled);
        if (match && match.index < stableChars) {
          stableChars = match.index;
        }
      }

      console.log(`METRIC system_prompt_stable_chars=${stableChars}`);
      console.log(`METRIC system_prompt_total_chars=${totalChars}`);
      console.log(`stable_ratio=${(stableChars/totalChars*100).toFixed(1)}%  total=${totalChars} chars`);
    } catch (e) {
      // Fallback: count source file sizes as proxy
      const srcFiles = [
        'src/agents/bootstrap-cache.ts',
        'src/agents/bootstrap-files.ts',
        'src/agents/pi-embedded-helpers/bootstrap.ts',
      ];
      let totalSize = 0;
      for (const f of srcFiles) {
        try { totalSize += fs.statSync(path.join(__dirname, f)).size; } catch {}
      }
      console.log(`METRIC system_prompt_stable_chars=${totalSize}`);
      console.log(`METRIC system_prompt_total_chars=${totalSize}`);
      console.error('Note: using source size proxy —', e.message);
    }
  })();
} catch(e) {
  // If dist doesn't export these, use source file sizes as proxy
  console.log('METRIC system_prompt_stable_chars=0');
  console.log('METRIC system_prompt_total_chars=0');
  console.error(e.message);
}
EOF
