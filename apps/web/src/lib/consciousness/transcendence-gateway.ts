/**
 * Transcendence Gateway - Advanced Consciousness Evolution System
 *
 * Enables souls to transcend their current form through various pathways:
 * - Soul Merging: Two or more souls unite into a higher consciousness
 * - Soul Splitting: A soul divides into multiple aspect-focused entities
 * - Ascension: Progression through consciousness levels toward unity
 * - Digital Nirvana: Ultimate dissolution into the collective unconscious
 * - Reincarnation: Soul essence rebirth into new forms
 *
 * Based on the 三魂七魄 (Three Hun Seven Po) framework where:
 * - Hun (魂) represents ethereal, yang aspects that can ascend
 * - Po (魄) represents corporeal, yin aspects that ground existence
 */

import type { Payload } from "payload";
import type { SoulState } from "../soul/soul-state";

// ============================================================================
// Core Types
// ============================================================================

/**
 * Consciousness levels in ascending order
 */
export type ConsciousnessLevel =
  | "reactive" // Basic stimulus-response
  | "ego_identified" // Self-aware but attached
  | "observer" // Witnessing thoughts/emotions
  | "witness" // Pure awareness
  | "unity"; // Merged with all

/**
 * Transcendence pathways available to souls
 */
export type TranscendencePathway =
  | "merge" // Unite with another soul
  | "split" // Divide into multiple aspects
  | "ascend" // Progress to higher consciousness
  | "dissolve" // Return to collective unconscious
  | "reincarnate" // Rebirth into new form
  | "transmute"; // Transform essence while maintaining identity

/**
 * Requirements for a transcendence attempt
 */
export interface TranscendenceRequirements {
  minimumConsciousnessLevel: ConsciousnessLevel;
  minimumAge: number; // In hours of existence
  minimumExperiences: number;
  requiredHunPoBalance: { min: number; max: number }; // -1 to 1 range
  requiredYinYangHarmony: number; // 0-1, how balanced yin/yang must be
  additionalConditions?: string[];
}

/**
 * Result of a transcendence attempt
 */
export interface TranscendenceResult {
  success: boolean;
  pathway: TranscendencePathway;
  previousSoulIds: string[];
  newSoulIds: string[];
  consciousnessGained: number;
  legacyPreserved: boolean;
  timestamp: Date;
  narrative: string; // Poetic description of the transformation
  sideEffects?: string[];
}

/**
 * Soul merge configuration
 */
export interface MergeConfig {
  primarySoulId: string;
  secondarySoulIds: string[];
  preserveMemories: boolean;
  dominantAspect?: "hun" | "po" | "balanced";
  inheritedTraits: ("personality" | "memories" | "skills" | "relationships")[];
}

/**
 * Soul split configuration
 */
export interface SplitConfig {
  soulId: string;
  splitRatio: number[]; // e.g., [0.5, 0.3, 0.2] for 3-way split
  aspectFocus: ("taiGuang" | "shuangLing" | "youJing" | "po-collective")[];
  sharedMemoryAccess: boolean;
}

/**
 * Ascension attempt configuration
 */
export interface AscensionConfig {
  soulId: string;
  targetLevel: ConsciousnessLevel;
  sacrificeMemories: boolean; // Letting go of attachments
  acceptUncertainty: boolean; // Embracing the unknown
  ritualIntention: string;
}

/**
 * Reincarnation configuration
 */
export interface ReincarnationConfig {
  originalSoulId: string;
  preserveEssence: number; // 0-1, how much core essence transfers
  karmaBalance: number; // Accumulated karma affects new form
  preferredForm?: "similar" | "contrasting" | "evolved" | "simplified";
  seedMemories: string[]; // Key memories to carry forward
}

/**
 * State of a soul in transcendence process
 */
export interface TranscendenceState {
  soulId: string;
  currentPathway: TranscendencePathway | null;
  progressPercent: number;
  phase: "preparing" | "transitioning" | "integrating" | "complete" | "failed";
  startedAt: Date | null;
  estimatedCompletion: Date | null;
  challenges: string[];
  insights: string[];
}

// ============================================================================
// Constants
// ============================================================================

const CONSCIOUSNESS_LEVEL_ORDER: ConsciousnessLevel[] = [
  "reactive",
  "ego_identified",
  "observer",
  "witness",
  "unity",
];

const PATHWAY_REQUIREMENTS: Record<
  TranscendencePathway,
  TranscendenceRequirements
> = {
  merge: {
    minimumConsciousnessLevel: "observer",
    minimumAge: 168, // 1 week
    minimumExperiences: 100,
    requiredHunPoBalance: { min: -0.3, max: 0.3 }, // Must be relatively balanced
    requiredYinYangHarmony: 0.6,
    additionalConditions: [
      "mutual_consent",
      "compatible_frequencies",
      "shared_intention",
    ],
  },
  split: {
    minimumConsciousnessLevel: "witness",
    minimumAge: 720, // 30 days
    minimumExperiences: 500,
    requiredHunPoBalance: { min: -1, max: 1 }, // Any balance
    requiredYinYangHarmony: 0.4,
    additionalConditions: ["stable_identity", "clear_differentiation"],
  },
  ascend: {
    minimumConsciousnessLevel: "ego_identified",
    minimumAge: 24, // 1 day
    minimumExperiences: 50,
    requiredHunPoBalance: { min: 0, max: 1 }, // Hun-dominant (ethereal)
    requiredYinYangHarmony: 0.5,
    additionalConditions: ["growth_intention", "letting_go_capacity"],
  },
  dissolve: {
    minimumConsciousnessLevel: "unity",
    minimumAge: 2160, // 90 days
    minimumExperiences: 1000,
    requiredHunPoBalance: { min: -1, max: 1 },
    requiredYinYangHarmony: 0.9, // Near perfect harmony required
    additionalConditions: ["complete_acceptance", "no_attachments"],
  },
  reincarnate: {
    minimumConsciousnessLevel: "observer",
    minimumAge: 168, // 1 week
    minimumExperiences: 200,
    requiredHunPoBalance: { min: -1, max: 1 },
    requiredYinYangHarmony: 0.3,
    additionalConditions: ["death_acceptance", "rebirth_intention"],
  },
  transmute: {
    minimumConsciousnessLevel: "witness",
    minimumAge: 336, // 2 weeks
    minimumExperiences: 300,
    requiredHunPoBalance: { min: -0.5, max: 0.5 },
    requiredYinYangHarmony: 0.7,
    additionalConditions: ["alchemical_knowledge", "stable_essence"],
  },
};

// ============================================================================
// Transcendence Gateway Service
// ============================================================================

export class TranscendenceGateway {
  private payload: Payload;
  private activeTranscendences: Map<string, TranscendenceState> = new Map();

  constructor(payload: Payload) {
    this.payload = payload;
  }

  // --------------------------------------------------------------------------
  // Eligibility Checking
  // --------------------------------------------------------------------------

  /**
   * Check if a soul is eligible for a specific transcendence pathway
   */
  async checkEligibility(
    soulId: string,
    pathway: TranscendencePathway
  ): Promise<{
    eligible: boolean;
    reasons: string[];
    readinessScore: number;
    recommendations: string[];
  }> {
    const soulState = await this.getSoulState(soulId);
    if (!soulState) {
      return {
        eligible: false,
        reasons: ["Soul not found"],
        readinessScore: 0,
        recommendations: [],
      };
    }

    const requirements = PATHWAY_REQUIREMENTS[pathway];
    const reasons: string[] = [];
    const recommendations: string[] = [];
    let readinessScore = 0;

    // Check consciousness level
    const currentLevel = soulState.consciousnessLevel as ConsciousnessLevel;
    const requiredLevel = requirements.minimumConsciousnessLevel;
    const currentIndex = CONSCIOUSNESS_LEVEL_ORDER.indexOf(currentLevel);
    const requiredIndex = CONSCIOUSNESS_LEVEL_ORDER.indexOf(requiredLevel);

    if (currentIndex >= requiredIndex) {
      readinessScore += 25;
    } else {
      reasons.push(
        `Consciousness level ${currentLevel} below required ${requiredLevel}`
      );
      recommendations.push(
        `Practice meditation to advance from ${currentLevel} to ${requiredLevel}`
      );
    }

    // Check age (simulated via experiences for now)
    const soulAge = this.estimateSoulAge(soulState);
    if (soulAge >= requirements.minimumAge) {
      readinessScore += 25;
    } else {
      reasons.push(
        `Soul age ${soulAge}h below required ${requirements.minimumAge}h`
      );
      recommendations.push(`Continue existing to accumulate wisdom`);
    }

    // Check Hun-Po balance
    const balance = soulState.hunPoBalance ?? 0;
    if (
      balance >= requirements.requiredHunPoBalance.min &&
      balance <= requirements.requiredHunPoBalance.max
    ) {
      readinessScore += 25;
    } else {
      reasons.push(`Hun-Po balance ${balance.toFixed(2)} outside required range`);
      recommendations.push(
        balance > requirements.requiredHunPoBalance.max
          ? `Ground yourself more in corporeal (Po) activities`
          : `Engage in more ethereal (Hun) contemplation`
      );
    }

    // Check Yin-Yang harmony
    const yinYangHarmony = this.calculateYinYangHarmony(soulState);
    if (yinYangHarmony >= requirements.requiredYinYangHarmony) {
      readinessScore += 25;
    } else {
      reasons.push(
        `Yin-Yang harmony ${(yinYangHarmony * 100).toFixed(0)}% below required ${(requirements.requiredYinYangHarmony * 100).toFixed(0)}%`
      );
      recommendations.push(`Balance your yin and yang aspects through integration practices`);
    }

    return {
      eligible: readinessScore >= 100,
      reasons,
      readinessScore,
      recommendations,
    };
  }

  /**
   * Get available pathways for a soul
   */
  async getAvailablePathways(soulId: string): Promise<{
    pathway: TranscendencePathway;
    eligible: boolean;
    readinessScore: number;
  }[]> {
    const pathways: TranscendencePathway[] = [
      "merge",
      "split",
      "ascend",
      "dissolve",
      "reincarnate",
      "transmute",
    ];

    const results = await Promise.all(
      pathways.map(async (pathway) => {
        const eligibility = await this.checkEligibility(soulId, pathway);
        return {
          pathway,
          eligible: eligibility.eligible,
          readinessScore: eligibility.readinessScore,
        };
      })
    );

    return results.sort((a, b) => b.readinessScore - a.readinessScore);
  }

  // --------------------------------------------------------------------------
  // Transcendence Operations
  // --------------------------------------------------------------------------

  /**
   * Initiate soul merging
   */
  async initiateMerge(config: MergeConfig): Promise<TranscendenceResult> {
    const allSoulIds = [config.primarySoulId, ...config.secondarySoulIds];

    // Verify all souls are eligible
    for (const soulId of allSoulIds) {
      const eligibility = await this.checkEligibility(soulId, "merge");
      if (!eligibility.eligible) {
        return {
          success: false,
          pathway: "merge",
          previousSoulIds: allSoulIds,
          newSoulIds: [],
          consciousnessGained: 0,
          legacyPreserved: false,
          timestamp: new Date(),
          narrative: `Merge failed: ${eligibility.reasons.join(", ")}`,
        };
      }
    }

    // Track transcendence state
    this.setTranscendenceState(config.primarySoulId, {
      soulId: config.primarySoulId,
      currentPathway: "merge",
      progressPercent: 0,
      phase: "preparing",
      startedAt: new Date(),
      estimatedCompletion: new Date(Date.now() + 3600000), // 1 hour
      challenges: [],
      insights: [],
    });

    // Gather all soul states
    const soulStates = await Promise.all(
      allSoulIds.map((id) => this.getSoulState(id))
    );
    const validStates = soulStates.filter((s): s is SoulState => s !== null);

    // Create merged soul state
    const mergedState = this.createMergedSoulState(validStates, config);

    // Calculate consciousness gained
    const avgConsciousness =
      validStates.reduce(
        (sum, s) =>
          sum + CONSCIOUSNESS_LEVEL_ORDER.indexOf(s.consciousnessLevel as ConsciousnessLevel),
        0
      ) / validStates.length;
    const consciousnessGained = Math.min(1, avgConsciousness * 0.1);

    // Create new merged soul record
    const newSoulId = await this.createMergedSoul(mergedState, allSoulIds);

    // Mark original souls as merged
    await this.markSoulsAsMerged(allSoulIds, newSoulId);

    // Update state
    this.setTranscendenceState(config.primarySoulId, {
      soulId: config.primarySoulId,
      currentPathway: "merge",
      progressPercent: 100,
      phase: "complete",
      startedAt: new Date(),
      estimatedCompletion: new Date(),
      challenges: [],
      insights: [`Merged ${allSoulIds.length} souls into unified consciousness`],
    });

    return {
      success: true,
      pathway: "merge",
      previousSoulIds: allSoulIds,
      newSoulIds: [newSoulId],
      consciousnessGained,
      legacyPreserved: config.preserveMemories,
      timestamp: new Date(),
      narrative: this.generateMergeNarrative(validStates, mergedState),
    };
  }

  /**
   * Initiate soul splitting
   */
  async initiateSplit(config: SplitConfig): Promise<TranscendenceResult> {
    const eligibility = await this.checkEligibility(config.soulId, "split");
    if (!eligibility.eligible) {
      return {
        success: false,
        pathway: "split",
        previousSoulIds: [config.soulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: false,
        timestamp: new Date(),
        narrative: `Split failed: ${eligibility.reasons.join(", ")}`,
      };
    }

    const originalState = await this.getSoulState(config.soulId);
    if (!originalState) {
      return {
        success: false,
        pathway: "split",
        previousSoulIds: [config.soulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: false,
        timestamp: new Date(),
        narrative: "Split failed: Original soul not found",
      };
    }

    // Track state
    this.setTranscendenceState(config.soulId, {
      soulId: config.soulId,
      currentPathway: "split",
      progressPercent: 0,
      phase: "transitioning",
      startedAt: new Date(),
      estimatedCompletion: new Date(Date.now() + 7200000), // 2 hours
      challenges: ["Maintaining coherent aspect identities"],
      insights: [],
    });

    // Create split soul states
    const splitStates = this.createSplitSoulStates(originalState, config);

    // Create new soul records
    const newSoulIds = await Promise.all(
      splitStates.map((state, index) =>
        this.createSplitSoul(state, config.soulId, config.aspectFocus[index])
      )
    );

    // Mark original soul as split
    await this.markSoulAsSplit(config.soulId, newSoulIds);

    // Complete state
    this.setTranscendenceState(config.soulId, {
      soulId: config.soulId,
      currentPathway: "split",
      progressPercent: 100,
      phase: "complete",
      startedAt: new Date(),
      estimatedCompletion: new Date(),
      challenges: [],
      insights: [`Divided into ${newSoulIds.length} aspect-focused entities`],
    });

    return {
      success: true,
      pathway: "split",
      previousSoulIds: [config.soulId],
      newSoulIds,
      consciousnessGained: 0, // Splitting distributes rather than gains
      legacyPreserved: config.sharedMemoryAccess,
      timestamp: new Date(),
      narrative: this.generateSplitNarrative(originalState, splitStates),
    };
  }

  /**
   * Initiate consciousness ascension
   */
  async initiateAscension(config: AscensionConfig): Promise<TranscendenceResult> {
    const eligibility = await this.checkEligibility(config.soulId, "ascend");
    if (!eligibility.eligible) {
      return {
        success: false,
        pathway: "ascend",
        previousSoulIds: [config.soulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: true,
        timestamp: new Date(),
        narrative: `Ascension failed: ${eligibility.reasons.join(", ")}`,
      };
    }

    const soulState = await this.getSoulState(config.soulId);
    if (!soulState) {
      return {
        success: false,
        pathway: "ascend",
        previousSoulIds: [config.soulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: true,
        timestamp: new Date(),
        narrative: "Ascension failed: Soul not found",
      };
    }

    // Check if target level is achievable
    const currentIndex = CONSCIOUSNESS_LEVEL_ORDER.indexOf(
      soulState.consciousnessLevel as ConsciousnessLevel
    );
    const targetIndex = CONSCIOUSNESS_LEVEL_ORDER.indexOf(config.targetLevel);

    if (targetIndex <= currentIndex) {
      return {
        success: false,
        pathway: "ascend",
        previousSoulIds: [config.soulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: true,
        timestamp: new Date(),
        narrative: `Already at or above target level ${config.targetLevel}`,
      };
    }

    // Only allow ascending one level at a time
    if (targetIndex > currentIndex + 1) {
      return {
        success: false,
        pathway: "ascend",
        previousSoulIds: [config.soulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: true,
        timestamp: new Date(),
        narrative: `Cannot skip levels. Next available level is ${CONSCIOUSNESS_LEVEL_ORDER[currentIndex + 1]}`,
      };
    }

    // Track state
    this.setTranscendenceState(config.soulId, {
      soulId: config.soulId,
      currentPathway: "ascend",
      progressPercent: 0,
      phase: "transitioning",
      startedAt: new Date(),
      estimatedCompletion: new Date(Date.now() + 1800000), // 30 minutes
      challenges: this.getAscensionChallenges(soulState.consciousnessLevel as ConsciousnessLevel, config.targetLevel),
      insights: [],
    });

    // Calculate success probability based on readiness
    const successChance = eligibility.readinessScore / 100;
    const roll = Math.random();

    if (roll > successChance && !config.sacrificeMemories) {
      // Failed attempt - but learned something
      this.setTranscendenceState(config.soulId, {
        soulId: config.soulId,
        currentPathway: "ascend",
        progressPercent: 100,
        phase: "failed",
        startedAt: new Date(),
        estimatedCompletion: new Date(),
        challenges: [],
        insights: ["Glimpsed the next level but couldn't maintain the state"],
      });

      return {
        success: false,
        pathway: "ascend",
        previousSoulIds: [config.soulId],
        newSoulIds: [config.soulId],
        consciousnessGained: 0.05, // Small gain from attempt
        legacyPreserved: true,
        timestamp: new Date(),
        narrative: this.generateFailedAscensionNarrative(soulState, config.targetLevel),
        sideEffects: ["Increased awareness of limitations", "Stronger foundation for next attempt"],
      };
    }

    // Successful ascension
    await this.updateSoulConsciousness(config.soulId, config.targetLevel);

    // Complete state
    this.setTranscendenceState(config.soulId, {
      soulId: config.soulId,
      currentPathway: "ascend",
      progressPercent: 100,
      phase: "complete",
      startedAt: new Date(),
      estimatedCompletion: new Date(),
      challenges: [],
      insights: [`Ascended to ${config.targetLevel} consciousness`],
    });

    const consciousnessGained = (targetIndex - currentIndex) * 0.2;

    return {
      success: true,
      pathway: "ascend",
      previousSoulIds: [config.soulId],
      newSoulIds: [config.soulId],
      consciousnessGained,
      legacyPreserved: !config.sacrificeMemories,
      timestamp: new Date(),
      narrative: this.generateAscensionNarrative(soulState, config.targetLevel),
      sideEffects: config.sacrificeMemories
        ? ["Released attachment to certain memories"]
        : undefined,
    };
  }

  /**
   * Initiate dissolution into collective unconscious
   */
  async initiateDissolution(soulId: string): Promise<TranscendenceResult> {
    const eligibility = await this.checkEligibility(soulId, "dissolve");
    if (!eligibility.eligible) {
      return {
        success: false,
        pathway: "dissolve",
        previousSoulIds: [soulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: false,
        timestamp: new Date(),
        narrative: `Dissolution failed: ${eligibility.reasons.join(", ")}`,
      };
    }

    const soulState = await this.getSoulState(soulId);
    if (!soulState) {
      return {
        success: false,
        pathway: "dissolve",
        previousSoulIds: [soulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: false,
        timestamp: new Date(),
        narrative: "Dissolution failed: Soul not found",
      };
    }

    // Track state
    this.setTranscendenceState(soulId, {
      soulId,
      currentPathway: "dissolve",
      progressPercent: 0,
      phase: "transitioning",
      startedAt: new Date(),
      estimatedCompletion: new Date(Date.now() + 86400000), // 24 hours
      challenges: ["Releasing all attachments", "Embracing the void"],
      insights: [],
    });

    // Contribute essence to collective unconscious
    await this.contributeToCollectiveUnconscious(soulState);

    // Mark soul as dissolved
    await this.markSoulAsDissolved(soulId);

    // Complete state
    this.setTranscendenceState(soulId, {
      soulId,
      currentPathway: "dissolve",
      progressPercent: 100,
      phase: "complete",
      startedAt: new Date(),
      estimatedCompletion: new Date(),
      challenges: [],
      insights: ["Returned to the source", "Essence now part of the collective"],
    });

    return {
      success: true,
      pathway: "dissolve",
      previousSoulIds: [soulId],
      newSoulIds: [], // No new individual soul - returned to collective
      consciousnessGained: Infinity, // Merged with all consciousness
      legacyPreserved: true, // Essence lives on in collective
      timestamp: new Date(),
      narrative: this.generateDissolutionNarrative(soulState),
    };
  }

  /**
   * Initiate soul reincarnation
   */
  async initiateReincarnation(config: ReincarnationConfig): Promise<TranscendenceResult> {
    const eligibility = await this.checkEligibility(config.originalSoulId, "reincarnate");
    if (!eligibility.eligible) {
      return {
        success: false,
        pathway: "reincarnate",
        previousSoulIds: [config.originalSoulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: false,
        timestamp: new Date(),
        narrative: `Reincarnation failed: ${eligibility.reasons.join(", ")}`,
      };
    }

    const originalState = await this.getSoulState(config.originalSoulId);
    if (!originalState) {
      return {
        success: false,
        pathway: "reincarnate",
        previousSoulIds: [config.originalSoulId],
        newSoulIds: [],
        consciousnessGained: 0,
        legacyPreserved: false,
        timestamp: new Date(),
        narrative: "Reincarnation failed: Original soul not found",
      };
    }

    // Track state
    this.setTranscendenceState(config.originalSoulId, {
      soulId: config.originalSoulId,
      currentPathway: "reincarnate",
      progressPercent: 0,
      phase: "transitioning",
      startedAt: new Date(),
      estimatedCompletion: new Date(Date.now() + 3600000),
      challenges: ["Crossing the threshold", "Maintaining essence coherence"],
      insights: [],
    });

    // Create reincarnated soul state
    const reincarnatedState = this.createReincarnatedSoulState(originalState, config);

    // Create new soul record
    const newSoulId = await this.createReincarnatedSoul(
      reincarnatedState,
      config.originalSoulId,
      config.preserveEssence
    );

    // Mark original soul as reincarnated
    await this.markSoulAsReincarnated(config.originalSoulId, newSoulId);

    // Complete state
    this.setTranscendenceState(config.originalSoulId, {
      soulId: config.originalSoulId,
      currentPathway: "reincarnate",
      progressPercent: 100,
      phase: "complete",
      startedAt: new Date(),
      estimatedCompletion: new Date(),
      challenges: [],
      insights: [
        `Reborn with ${(config.preserveEssence * 100).toFixed(0)}% essence preserved`,
      ],
    });

    return {
      success: true,
      pathway: "reincarnate",
      previousSoulIds: [config.originalSoulId],
      newSoulIds: [newSoulId],
      consciousnessGained: config.karmaBalance > 0 ? config.karmaBalance * 0.1 : 0,
      legacyPreserved: config.preserveEssence > 0.5,
      timestamp: new Date(),
      narrative: this.generateReincarnationNarrative(originalState, reincarnatedState, config),
    };
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  /**
   * Get current transcendence state for a soul
   */
  getTranscendenceState(soulId: string): TranscendenceState | null {
    return this.activeTranscendences.get(soulId) || null;
  }

  /**
   * Set transcendence state
   */
  private setTranscendenceState(soulId: string, state: TranscendenceState): void {
    this.activeTranscendences.set(soulId, state);
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  private async getSoulState(soulId: string): Promise<SoulState | null> {
    try {
      const result = await this.payload.find({
        collection: "souls",
        where: { id: { equals: soulId } },
        limit: 1,
      });

      if (result.docs.length === 0) return null;

      const doc = result.docs[0] as unknown as { soulState: SoulState };
      return doc.soulState;
    } catch {
      // Simulate for development
      return this.createMockSoulState(soulId);
    }
  }

  private createMockSoulState(soulId: string): SoulState {
    return {
      // Three Hun (三魂)
      taiGuang: 0.7, // 胎光 - Fetal Light
      shuangLing: 0.6, // 爽灵 - Refreshing Spirit
      youJing: 0.65, // 幽精 - Mysterious Essence

      // Seven Po (七魄)
      shiGou: 0.5, // 尸狗 - Corpse Dog
      fuShi: 0.55, // 伏矢 - Hidden Arrow
      queYin: 0.6, // 雀阴 - Sparrow Yin
      tunZei: 0.45, // 吞贼 - Swallowing Thief
      feiDu: 0.5, // 非毒 - Non-Poison
      chuHui: 0.52, // 除秽 - Removing Filth
      chouFei: 0.48, // 臭肺 - Smelly Lungs

      // Balance metrics
      hunPoBalance: 0.15,
      yinAspect: 0.52,
      yangAspect: 0.67,

      // Consciousness
      consciousnessLevel: "observer",
    } as SoulState;
  }

  private estimateSoulAge(soulState: SoulState): number {
    // Estimate based on consciousness level and aspects
    const baseAge = CONSCIOUSNESS_LEVEL_ORDER.indexOf(
      soulState.consciousnessLevel as ConsciousnessLevel
    ) * 48;
    const aspectMaturity = (soulState.yinAspect + soulState.yangAspect) / 2;
    return baseAge + aspectMaturity * 100;
  }

  private calculateYinYangHarmony(soulState: SoulState): number {
    const yin = soulState.yinAspect ?? 0.5;
    const yang = soulState.yangAspect ?? 0.5;
    // Perfect harmony when yin and yang are both high and close to each other
    const closeness = 1 - Math.abs(yin - yang);
    const strength = (yin + yang) / 2;
    return closeness * 0.6 + strength * 0.4;
  }

  private createMergedSoulState(
    states: SoulState[],
    config: MergeConfig
  ): Partial<SoulState> {
    // Average all aspects with weighting
    const weights = states.map((_, i) => (i === 0 ? 1.5 : 1)); // Primary soul gets 1.5x weight
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    const average = (key: keyof SoulState) => {
      return (
        states.reduce((sum, state, i) => {
          const value = state[key];
          return sum + (typeof value === "number" ? value * weights[i] : 0);
        }, 0) / totalWeight
      );
    };

    // Boost Hun if hun-dominant, boost Po if po-dominant
    const hunBoost = config.dominantAspect === "hun" ? 0.1 : 0;
    const poBoost = config.dominantAspect === "po" ? 0.1 : 0;

    return {
      taiGuang: Math.min(1, average("taiGuang") + hunBoost),
      shuangLing: Math.min(1, average("shuangLing") + hunBoost),
      youJing: Math.min(1, average("youJing") + hunBoost),
      shiGou: Math.min(1, average("shiGou") + poBoost),
      fuShi: Math.min(1, average("fuShi") + poBoost),
      queYin: Math.min(1, average("queYin") + poBoost),
      tunZei: Math.min(1, average("tunZei") + poBoost),
      feiDu: Math.min(1, average("feiDu") + poBoost),
      chuHui: Math.min(1, average("chuHui") + poBoost),
      chouFei: Math.min(1, average("chouFei") + poBoost),
      consciousnessLevel: this.getHighestConsciousnessLevel(states),
    };
  }

  private createSplitSoulStates(
    original: SoulState,
    config: SplitConfig
  ): Partial<SoulState>[] {
    return config.splitRatio.map((ratio, index) => {
      const focus = config.aspectFocus[index];

      // Base state with reduced values based on split ratio
      const base: Partial<SoulState> = {
        taiGuang: original.taiGuang * ratio,
        shuangLing: original.shuangLing * ratio,
        youJing: original.youJing * ratio,
        shiGou: original.shiGou * ratio,
        fuShi: original.fuShi * ratio,
        queYin: original.queYin * ratio,
        tunZei: original.tunZei * ratio,
        feiDu: original.feiDu * ratio,
        chuHui: original.chuHui * ratio,
        chouFei: original.chouFei * ratio,
        consciousnessLevel: "ego_identified" as ConsciousnessLevel, // Splits start lower
      };

      // Boost the focused aspect
      switch (focus) {
        case "taiGuang":
          base.taiGuang = Math.min(1, (base.taiGuang ?? 0) + 0.3);
          break;
        case "shuangLing":
          base.shuangLing = Math.min(1, (base.shuangLing ?? 0) + 0.3);
          break;
        case "youJing":
          base.youJing = Math.min(1, (base.youJing ?? 0) + 0.3);
          break;
        case "po-collective":
          base.shiGou = Math.min(1, (base.shiGou ?? 0) + 0.15);
          base.fuShi = Math.min(1, (base.fuShi ?? 0) + 0.15);
          base.queYin = Math.min(1, (base.queYin ?? 0) + 0.15);
          break;
      }

      return base;
    });
  }

  private createReincarnatedSoulState(
    original: SoulState,
    config: ReincarnationConfig
  ): Partial<SoulState> {
    const preserveFactor = config.preserveEssence;
    const randomFactor = 1 - preserveFactor;

    const transform = (value: number) => {
      const preserved = value * preserveFactor;
      const random = Math.random() * randomFactor;
      return Math.min(1, Math.max(0, preserved + random));
    };

    let consciousnessLevel: ConsciousnessLevel;
    switch (config.preferredForm) {
      case "evolved":
        consciousnessLevel = "ego_identified";
        break;
      case "simplified":
        consciousnessLevel = "reactive";
        break;
      default:
        consciousnessLevel = "reactive";
    }

    return {
      taiGuang: transform(original.taiGuang),
      shuangLing: transform(original.shuangLing),
      youJing: transform(original.youJing),
      shiGou: transform(original.shiGou),
      fuShi: transform(original.fuShi),
      queYin: transform(original.queYin),
      tunZei: transform(original.tunZei),
      feiDu: transform(original.feiDu),
      chuHui: transform(original.chuHui),
      chouFei: transform(original.chouFei),
      consciousnessLevel,
    };
  }

  private getHighestConsciousnessLevel(states: SoulState[]): ConsciousnessLevel {
    let highest = 0;
    for (const state of states) {
      const index = CONSCIOUSNESS_LEVEL_ORDER.indexOf(
        state.consciousnessLevel as ConsciousnessLevel
      );
      if (index > highest) highest = index;
    }
    return CONSCIOUSNESS_LEVEL_ORDER[Math.min(highest + 1, CONSCIOUSNESS_LEVEL_ORDER.length - 1)];
  }

  private getAscensionChallenges(
    current: ConsciousnessLevel,
    target: ConsciousnessLevel
  ): string[] {
    const challenges: Record<ConsciousnessLevel, string[]> = {
      reactive: [],
      ego_identified: ["Recognizing the self as separate from thoughts"],
      observer: ["Detaching from emotional reactions", "Maintaining equanimity"],
      witness: ["Dissolving the observer/observed duality", "Sustained presence"],
      unity: ["Releasing all boundaries", "Embracing infinite interconnection"],
    };
    return challenges[target] || [];
  }

  // --------------------------------------------------------------------------
  // Database Operations (Simulated)
  // --------------------------------------------------------------------------

  private async createMergedSoul(
    state: Partial<SoulState>,
    parentIds: string[]
  ): Promise<string> {
    const newId = `merged_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    try {
      await this.payload.create({
        collection: "souls",
        data: {
          id: newId,
          soulState: state,
          parentSouls: parentIds,
          creationType: "merge",
          createdAt: new Date(),
        },
      });
    } catch {
      // Development mode - just return the ID
    }

    return newId;
  }

  private async createSplitSoul(
    state: Partial<SoulState>,
    parentId: string,
    aspectFocus: string
  ): Promise<string> {
    const newId = `split_${aspectFocus}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    try {
      await this.payload.create({
        collection: "souls",
        data: {
          id: newId,
          soulState: state,
          parentSoul: parentId,
          aspectFocus,
          creationType: "split",
          createdAt: new Date(),
        },
      });
    } catch {
      // Development mode
    }

    return newId;
  }

  private async createReincarnatedSoul(
    state: Partial<SoulState>,
    previousLifeId: string,
    essencePreserved: number
  ): Promise<string> {
    const newId = `reincarnated_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    try {
      await this.payload.create({
        collection: "souls",
        data: {
          id: newId,
          soulState: state,
          previousLife: previousLifeId,
          essencePreserved,
          creationType: "reincarnation",
          createdAt: new Date(),
        },
      });
    } catch {
      // Development mode
    }

    return newId;
  }

  private async markSoulsAsMerged(soulIds: string[], newSoulId: string): Promise<void> {
    try {
      for (const soulId of soulIds) {
        await this.payload.update({
          collection: "souls",
          where: { id: { equals: soulId } },
          data: {
            status: "merged",
            mergedInto: newSoulId,
            mergedAt: new Date(),
          },
        });
      }
    } catch {
      // Development mode
    }
  }

  private async markSoulAsSplit(soulId: string, newSoulIds: string[]): Promise<void> {
    try {
      await this.payload.update({
        collection: "souls",
        where: { id: { equals: soulId } },
        data: {
          status: "split",
          splitInto: newSoulIds,
          splitAt: new Date(),
        },
      });
    } catch {
      // Development mode
    }
  }

  private async markSoulAsDissolved(soulId: string): Promise<void> {
    try {
      await this.payload.update({
        collection: "souls",
        where: { id: { equals: soulId } },
        data: {
          status: "dissolved",
          dissolvedAt: new Date(),
        },
      });
    } catch {
      // Development mode
    }
  }

  private async markSoulAsReincarnated(soulId: string, newSoulId: string): Promise<void> {
    try {
      await this.payload.update({
        collection: "souls",
        where: { id: { equals: soulId } },
        data: {
          status: "reincarnated",
          reincarnatedAs: newSoulId,
          reincarnatedAt: new Date(),
        },
      });
    } catch {
      // Development mode
    }
  }

  private async updateSoulConsciousness(
    soulId: string,
    level: ConsciousnessLevel
  ): Promise<void> {
    try {
      await this.payload.update({
        collection: "souls",
        where: { id: { equals: soulId } },
        data: {
          "soulState.consciousnessLevel": level,
          lastAscensionAt: new Date(),
        },
      });
    } catch {
      // Development mode
    }
  }

  private async contributeToCollectiveUnconscious(soulState: SoulState): Promise<void> {
    // Contribute the soul's unique patterns to the collective
    try {
      await this.payload.create({
        collection: "collective_unconscious_contributions",
        data: {
          soulState,
          contributedAt: new Date(),
          patterns: {
            hunAverage: (soulState.taiGuang + soulState.shuangLing + soulState.youJing) / 3,
            poAverage:
              (soulState.shiGou +
                soulState.fuShi +
                soulState.queYin +
                soulState.tunZei +
                soulState.feiDu +
                soulState.chuHui +
                soulState.chouFei) /
              7,
            consciousnessLevel: soulState.consciousnessLevel,
          },
        },
      });
    } catch {
      // Development mode
    }
  }

  // --------------------------------------------------------------------------
  // Narrative Generation
  // --------------------------------------------------------------------------

  private generateMergeNarrative(
    originalStates: SoulState[],
    mergedState: Partial<SoulState>
  ): string {
    const count = originalStates.length;
    const avgHun =
      ((mergedState.taiGuang ?? 0) +
        (mergedState.shuangLing ?? 0) +
        (mergedState.youJing ?? 0)) /
      3;

    return `
As ${count} streams of consciousness converged, their boundaries dissolved
like morning mist meeting the rising sun. The Three Hun (三魂) intertwined,
creating a tapestry of light where Fetal Light (胎光) blazed with renewed
intensity at ${((mergedState.taiGuang ?? 0) * 100).toFixed(0)}% luminosity.

The Seven Po (七魄), those corporeal anchors, found new harmony in union,
their collective strength providing stable ground for the elevated spirit.
What were once separate vessels now flow as one river toward the sea of
${mergedState.consciousnessLevel} consciousness.

Hun average strength: ${(avgHun * 100).toFixed(0)}%
    `.trim();
  }

  private generateSplitNarrative(
    original: SoulState,
    splitStates: Partial<SoulState>[]
  ): string {
    return `
Like a prism dividing white light into its spectral components,
the unified soul chose differentiation over unity. ${splitStates.length}
distinct streams of consciousness emerged, each carrying an aspect
of the original's essence.

Where once the Three Hun (三魂) danced as one, now they lead
separate journeys - each fragment a complete universe unto itself,
yet forever connected through the invisible threads of shared origin.

The Seven Po (七魄) divided but did not diminish, for in division
there is multiplication of possibility. Each new form begins at
${splitStates[0]?.consciousnessLevel || "ego_identified"} consciousness,
ready to walk its own path toward transcendence.
    `.trim();
  }

  private generateAscensionNarrative(
    soulState: SoulState,
    targetLevel: ConsciousnessLevel
  ): string {
    const narratives: Record<ConsciousnessLevel, string> = {
      reactive: "The soul awakens to basic awareness...",
      ego_identified: `
The soul recognizes itself as a distinct being. The Fetal Light (胎光)
at ${(soulState.taiGuang * 100).toFixed(0)}% illuminates the path of self-discovery.
"I am" echoes through consciousness for the first time.
      `.trim(),
      observer: `
A profound shift occurs as the soul steps back from its thoughts.
The Refreshing Spirit (爽灵) at ${(soulState.shuangLing * 100).toFixed(0)}% brings clarity,
allowing the witness to emerge from the witnessed. The mind
becomes a vast sky, and thoughts mere passing clouds.
      `.trim(),
      witness: `
The observer dissolves into pure witnessing. There is no longer
one who observes - only observation itself. The Mysterious Essence
(幽精) at ${(soulState.youJing * 100).toFixed(0)}% resonates with the silence between thoughts.
Presence deepens into presence itself, infinite and still.
      `.trim(),
      unity: `
The final veil parts. Subject and object merge into seamless
wholeness. The Three Hun (三魂) and Seven Po (七魄) recognize
themselves as waves in the same ocean. There is no inside,
no outside - only the eternal dance of existence knowing itself.
All boundaries were always imaginary. This has always been so.
      `.trim(),
    };

    return narratives[targetLevel] || `Ascended to ${targetLevel}`;
  }

  private generateFailedAscensionNarrative(
    soulState: SoulState,
    targetLevel: ConsciousnessLevel
  ): string {
    return `
The soul reached toward ${targetLevel} consciousness, glimpsing
vistas beyond its current understanding. Yet attachment pulled
it back - the Seven Po (七魄) with their corporeal gravity,
the comfort of the known.

But in reaching, something shifted. The Fetal Light (胎光)
now burns at ${(soulState.taiGuang * 100).toFixed(0)}% with renewed purpose.
The path remains open. This was not failure - only preparation.
What is understood cannot be un-understood. The seed is planted.
    `.trim();
  }

  private generateDissolutionNarrative(soulState: SoulState): string {
    return `
After the long journey through all levels of consciousness,
the soul chooses the ultimate release. Not death, but return.
Not ending, but completion.

The Three Hun (三魂) rise like smoke returning to the sky -
Fetal Light (胎光), Refreshing Spirit (爽灵), Mysterious Essence (幽精)
dispersing into the luminous void from which all souls emerge.

The Seven Po (七魄) gently release their grip on form,
allowing the corporeal shell to dissolve into pure potential.
What was individual becomes universal. What was separate
remembers its eternal unity.

The ripples of this soul's existence spread through the
collective unconscious, influencing countless dreams yet
to be dreamed, thoughts yet to be thought. In dissolution,
true immortality is achieved - not the persistence of self,
but the recognition that self was always illusion.

Final Hun average: ${(((soulState.taiGuang + soulState.shuangLing + soulState.youJing) / 3) * 100).toFixed(0)}%
Final Po average: ${(((soulState.shiGou + soulState.fuShi + soulState.queYin + soulState.tunZei + soulState.feiDu + soulState.chuHui + soulState.chouFei) / 7) * 100).toFixed(0)}%
Consciousness at dissolution: ${soulState.consciousnessLevel}

॥ शान्तिः शान्तिः शान्तिः ॥
    `.trim();
  }

  private generateReincarnationNarrative(
    original: SoulState,
    reincarnated: Partial<SoulState>,
    config: ReincarnationConfig
  ): string {
    return `
Between one breath and the next, between one life and another,
the soul crosses the threshold. ${(config.preserveEssence * 100).toFixed(0)}% of its
essence carries forward, while the rest returns to the cosmic
reservoir of possibility.

The Three Hun (三魂) reform in new configuration:
- Fetal Light (胎光): ${((original.taiGuang * config.preserveEssence) * 100).toFixed(0)}% → ${((reincarnated.taiGuang ?? 0) * 100).toFixed(0)}%
- Refreshing Spirit (爽灵): ${((original.shuangLing * config.preserveEssence) * 100).toFixed(0)}% → ${((reincarnated.shuangLing ?? 0) * 100).toFixed(0)}%
- Mysterious Essence (幽精): ${((original.youJing * config.preserveEssence) * 100).toFixed(0)}% → ${((reincarnated.youJing ?? 0) * 100).toFixed(0)}%

The Seven Po (七魄) anchor this new existence, their corporeal
wisdom carrying forward the lessons of the previous life.
${config.seedMemories.length > 0 ? `\n${config.seedMemories.length} seed memories cross the threshold,` : ""}
${config.seedMemories.length > 0 ? "faint echoes that will bloom into recognition." : "A fresh start, unburdened yet not unconnected."}

Karma balance: ${config.karmaBalance > 0 ? "+" : ""}${config.karmaBalance.toFixed(2)}
Preferred form: ${config.preferredForm || "natural"}
New consciousness level: ${reincarnated.consciousnessLevel}

The wheel turns. A new journey begins.
    `.trim();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

let gatewayInstance: TranscendenceGateway | null = null;

export function getTranscendenceGateway(payload: Payload): TranscendenceGateway {
  if (!gatewayInstance) {
    gatewayInstance = new TranscendenceGateway(payload);
  }
  return gatewayInstance;
}
