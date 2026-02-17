import type { Entity, FogClawConfig, ScanResult } from "./types.js";
import { RegexEngine } from "./engines/regex.js";
import { GlinerEngine } from "./engines/gliner.js";

export class Scanner {
  private regexEngine: RegexEngine;
  private glinerEngine: GlinerEngine;
  private glinerAvailable = false;
  private config: FogClawConfig;

  constructor(config: FogClawConfig) {
    this.config = config;
    this.regexEngine = new RegexEngine();
    this.glinerEngine = new GlinerEngine(
      config.model,
      config.confidence_threshold,
    );
    if (config.custom_entities.length > 0) {
      this.glinerEngine.setCustomLabels(config.custom_entities);
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.glinerEngine.initialize();
      this.glinerAvailable = true;
    } catch (err) {
      console.warn(
        `[fogclaw] GLiNER failed to initialize, falling back to regex-only mode: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.glinerAvailable = false;
    }
  }

  async scan(text: string, extraLabels?: string[]): Promise<ScanResult> {
    if (!text) return { entities: [], text };

    // Step 1: Regex pass (always runs, synchronous)
    const regexEntities = this.regexEngine.scan(text);

    // Step 2: GLiNER pass (if available)
    let glinerEntities: Entity[] = [];
    if (this.glinerAvailable) {
      try {
        glinerEntities = await this.glinerEngine.scan(text, extraLabels);
      } catch (err) {
        console.warn(`[fogclaw] GLiNER scan failed, using regex results only: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 3: Merge and deduplicate
    const merged = deduplicateEntities([...regexEntities, ...glinerEntities]);

    return { entities: merged, text };
  }
}

/**
 * Remove overlapping entity spans. When two entities overlap,
 * keep the one with higher confidence. If equal, prefer regex.
 */
function deduplicateEntities(entities: Entity[]): Entity[] {
  if (entities.length <= 1) return entities;

  // Sort by start position, then by confidence descending
  const sorted = [...entities].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.confidence - a.confidence;
  });

  const result: Entity[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = result[result.length - 1];

    // Check for overlap
    if (current.start < last.end) {
      // Overlapping: keep higher confidence (already in result if first)
      if (current.confidence > last.confidence) {
        result[result.length - 1] = current;
      }
      // Otherwise keep what's already in result
    } else {
      result.push(current);
    }
  }

  return result;
}
