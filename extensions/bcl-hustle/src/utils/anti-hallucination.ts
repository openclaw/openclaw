/**
 * Anti-Hallucination System
 *
 * Implements confidence scoring, multi-source validation, and human review gates
 */

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import { saveDecision } from "../db/database.js";
import { BCL_CORE_VALUES, type DecisionRecord } from "../types/index.js";

interface ValidationInput {
  content: string;
  sources: string[];
  confidence: number;
}

interface ValidationResult {
  valid: boolean;
  confidence: number;
  requiresHumanReview: boolean;
  sourcesValidated: number;
}

export class AntiHallucination {
  private api: OpenClawPluginApi;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
  }

  async validate(input: ValidationInput): Promise<ValidationResult> {
    const meetsThreshold = input.confidence >= BCL_CORE_VALUES.min_confidence_threshold;
    const sourcesValidated = await this.validateSources(input.sources);

    const requiresHumanReview =
      input.confidence < BCL_CORE_VALUES.min_confidence_threshold || sourcesValidated < 3;

    const result: ValidationResult = {
      valid: meetsThreshold && sourcesValidated >= 3,
      confidence: input.confidence,
      requiresHumanReview,
      sourcesValidated,
    };

    if (!result.valid) {
      this.api.logger.warn(
        `Anti-Hallucination: Validation failed - confidence: ${input.confidence}, sources: ${sourcesValidated}`,
      );
    }

    return result;
  }

  private async validateSources(sources: string[]): Promise<number> {
    const uniqueSources = new Set(
      sources.map((s) => {
        try {
          return new URL(s).hostname;
        } catch {
          return s;
        }
      }),
    );
    return uniqueSources.size;
  }

  async recordDecision(decision: Omit<DecisionRecord, "id" | "timestamp">): Promise<void> {
    const record: DecisionRecord = {
      ...decision,
      id: `decision_${Date.now()}`,
      timestamp: new Date(),
    };

    saveDecision(record);
    this.api.logger.info(
      `Decision recorded: ${decision.decision} (confidence: ${decision.confidence})`,
    );
  }

  checkHumanReviewRequired(impact: number): boolean {
    return impact > BCL_CORE_VALUES.human_review_required_impact;
  }
}
