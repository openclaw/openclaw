import type { AgentMessage } from "../types.js";
import { extractAllText } from "../types.js";

/**
 * Layer 2: Context Injection Detection
 * Heuristically detects plugin-injected content in messages
 * by looking for known marker patterns.
 */

/** Known plugin marker patterns: regex → pluginId */
const DEFAULT_MARKERS: [RegExp, string][] = [
  [/\[memory-plugin\]/i, "memory-plugin"],
  [/\[memory-core\]/i, "memory-core"],
  [/\[memory-lancedb\]/i, "memory-lancedb"],
  [/\[lcm\]/i, "lossless-claw"],
  [/\[lossless-claw\]/i, "lossless-claw"],
  [/\[semantic-memory\]/i, "semantic-memory"],
  [/\[agent-brain\]/i, "agent-brain"],
  [/\[mem0\]/i, "mem0"],
  [/\[supermemory\]/i, "supermemory"],
  [/\[memos\]/i, "memos-cloud"],
  [/\[cognee\]/i, "cognee"],
];

export interface ContextDetection {
  pluginId: string;
  action: string;
  marker: string;
}

export class ContextDetector {
  private markers: [RegExp, string][];

  constructor(extraMarkers?: [RegExp, string][]) {
    this.markers = [...DEFAULT_MARKERS, ...(extraMarkers ?? [])];
  }

  /** Detect plugins that injected context into the messages */
  detect(messages: AgentMessage[]): ContextDetection[] {
    const results: ContextDetection[] = [];
    const seen = new Set<string>();

    for (const msg of messages) {
      const content = extractAllText(msg);
      if (!content) continue;

      for (const [pattern, pluginId] of this.markers) {
        if (seen.has(pluginId)) continue;

        const match = content.match(pattern);
        if (match) {
          seen.add(pluginId);
          results.push({
            pluginId,
            action: "context_injection",
            marker: match[0],
          });
        }
      }
    }

    return results;
  }

  /** Add custom markers at runtime */
  addMarker(pattern: RegExp, pluginId: string): void {
    this.markers.push([pattern, pluginId]);
  }
}
