#!/usr/bin/env node

// Minimal debug CLI for x402engine skill.
// Commands: discover, budget

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listServices } from './discovery.js';

const require = createRequire(import.meta.url);
const { loadPolicy, loadState, dayKey } = require('./policy-engine.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (!n || n.startsWith('--')) {
        out[k] = true;
      } else {
        out[k] = n;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function print(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === 'discover') {
    try {
      const services = await listServices();
      print({ ok: true, count: services.length, services });
    } catch (err) {
      print({ ok: false, error: err.message });
      process.exit(2);
    }
    return;
  }

  if (cmd === 'budget') {
    const policyPath = args.policy || process.env.X402_POLICY_PATH || path.join(__dirname, 'POLICY.example.json');
    const policyResult = loadPolicy(policyPath);
    if (!policyResult.ok) {
      print({ ok: false, decision: policyResult.decision });
      process.exit(2);
    }

    const statePath = args.state || process.env.X402_STATE_PATH;
    const state = loadState(statePath);
    const now = new Date();
    const policy = policyResult.policy;

    const budget = {};
    for (const chain of policy.allowedChains) {
      const chainAssets = policy.assets[chain] || {};
      for (const [asset, cfg] of Object.entries(chainAssets)) {
        const key = `${chain}:${asset}`;
        const entry = { chain, asset, maxPerTx: cfg.maxPerTx };

        if (cfg.dailyCap?.enabled) {
          const dk = `${chain}:${asset}:${dayKey(now, cfg.dailyCap.timezone || 'UTC')}`;
          const spent = Number(state.dailySpend?.[dk] || 0);
          const cap = Number(cfg.dailyCap.amount);
          entry.dailyCap = { cap, spent, remaining: Math.max(0, cap - spent) };
        } else {
          entry.dailyCap = { enabled: false };
        }

        budget[key] = entry;
      }
    }

    print({
      ok: true,
      policyPath,
      mode: policy.mode,
      rateLimits: policy.rateLimits,
      budget,
    });
    return;
  }

  print({
    ok: false,
    usage: [
      'node ./cli.js discover           — list all available services',
      'node ./cli.js budget             — show remaining daily spend',
    ],
  });
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
