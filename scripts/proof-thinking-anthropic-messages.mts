// Live-proof harness for PR #92053 (thinking profile on anthropic-messages catalog rows).
//
// Loads the patched `resolveThinkingProfile` from src/auto-reply/thinking.ts and
// feeds it a catalog whose shape mirrors the real jdcloud-anthropic config from
// issue #91975 (`api: "anthropic-messages"` on a non-bundled provider id, mixed
// `reasoning: false`/`reasoning: true` rows for Claude Opus 4.7 / 4.7-hq / 4.8).
//
// Before fix: `--thinking xhigh` silently clamped to `off` (only base levels
// exposed). After fix: xhigh/adaptive/max appear and survive level resolution.
//
// Run: pnpm exec tsx scripts/proof-thinking-anthropic-messages.mts

import {
  isThinkingLevelSupported,
  listThinkingLevels,
  resolveSupportedThinkingLevel,
} from "../src/auto-reply/thinking.js";

type CatalogRow = {
  provider: string;
  id: string;
  api: "anthropic-messages";
  reasoning: boolean;
};

const catalog: CatalogRow[] = [
  { provider: "jdcloud-anthropic", id: "Claude-Opus-4.7", api: "anthropic-messages", reasoning: false },
  { provider: "jdcloud-anthropic", id: "Claude-Opus-4.7-hq", api: "anthropic-messages", reasoning: true },
  { provider: "jdcloud-anthropic", id: "Claude-Opus-4.8", api: "anthropic-messages", reasoning: true },
];

function probe(provider: string, model: string, requested: "off" | "xhigh" | "max") {
  const levels = listThinkingLevels(provider, model, catalog);
  const supported = isThinkingLevelSupported({ provider, model, level: requested, catalog });
  const resolved = resolveSupportedThinkingLevel({ provider, model, level: requested, catalog });
  return { provider, model, requested, levels, supported, resolved };
}

const cases = [
  probe("jdcloud-anthropic", "Claude-Opus-4.7", "xhigh"),
  probe("jdcloud-anthropic", "Claude-Opus-4.7-hq", "xhigh"),
  probe("jdcloud-anthropic", "Claude-Opus-4.8", "xhigh"),
  probe("jdcloud-anthropic", "Claude-Opus-4.8", "max"),
];

for (const c of cases) {
  console.log(
    `${c.provider}/${c.model}  reasoning=${catalog.find((r) => r.id === c.model)?.reasoning} ` +
      `--thinking ${c.requested}  ->  resolved=${c.resolved}  supported=${c.supported}`,
  );
  console.log(`  levels: [${c.levels.join(",")}]`);
}
