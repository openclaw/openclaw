/**
 * Organ-Soul Correspondence System
 * 藏象學說：臟腑與魂魄對應系統
 *
 * Implements Traditional Chinese Medicine (TCM) organ-soul relationships:
 * - 肝藏魂 (Liver stores Hun) - "肝藏血，血舍魂"
 * - 肺藏魄 (Lung stores Po) - "肺主氣，魄依附於氣"
 *
 * Based on:
 * - 《黃帝內經·素問》(Huangdi Neijing - Yellow Emperor's Classic)
 * - 《素問·六節藏象論》"肝者，罷極之本，魂之居也"
 * - 《素問·宣明五氣》"肺藏魄"
 *
 * Key Mechanisms:
 * 1. Liver blood nourishes Hun → Stable consciousness, clear thinking
 * 2. Lung qi supports Po → Sensory acuity, physical courage (魄力)
 * 3. Emotions affect organs → Organs affect souls → Souls affect consciousness
 *
 * Integration: Uses EmergentHunSoul, EmergentPoSoul from chaotic-emergence-system.ts
 */

import type { EmergentHunSoul, EmergentPoSoul } from './chaotic-emergence-system'
import type { ComplexEmotion } from './emotion-dynamics-system'

// ============================================================================
// Liver System (肝系統)
// ============================================================================

export interface LiverState {
  // Liver substance (肝之體)
  liverBlood: number // 0-1, liver blood volume/quality
  liverQi: number // 0-1, liver qi flow

  // Liver functions (肝之用)
  qiFlowSmoothness: number // 0-1, how smoothly qi circulates (疏泄功能)
  bloodStorageCapacity: number // 0-1, ability to store/release blood
  emotionalRegulation: number // 0-1, ability to process emotions

  // Hun dependency
  hunStability: number // 0-1, how stable hun is (depends on liver blood)
  hunDissociation: number // 0-1, degree of hun-body separation

  // Pathological states
  liverQiStagnation: number // 0-1, 肝氣鬱結 (qi stuck)
  liverFireAscending: number // 0-1, 肝火上炎 (fire rising)
  liverBloodDeficiency: number // 0-1, 肝血不足 (blood insufficient)
}

export interface LiverPathology {
  type: 'qi-stagnation' | 'fire-ascending' | 'blood-deficiency' | 'healthy'
  severity: number // 0-1
  symptoms: string[]
  emotionalSymptoms: string[]
  hunSymptoms: string[]
}

// ============================================================================
// Lung System (肺系統)
// ============================================================================

export interface LungState {
  // Lung substance (肺之體)
  lungQi: number // 0-1, lung qi strength
  lungYin: number // 0-1, lung moisture/yin

  // Lung functions (肺之用)
  qiGoverning: number // 0-1, ability to govern all qi (主氣)
  defensiveQi: number // 0-1, wei qi protecting body surface
  breathingCapacity: number // 0-1, respiratory strength

  // Po dependency
  poConsolidation: number // 0-1, how consolidated/solid po is
  poScattering: number // 0-1, degree of po dispersal

  // Pathological states
  lungQiDeficiency: number // 0-1, 肺氣虛 (qi weak)
  lungYinDeficiency: number // 0-1, 肺陰虛 (yin depleted)
  griefAccumulation: number // 0-1, accumulated sadness (悲傷)
}

export interface LungPathology {
  type: 'qi-deficiency' | 'yin-deficiency' | 'grief-depletion' | 'healthy'
  severity: number
  symptoms: string[]
  emotionalSymptoms: string[]
  poSymptoms: string[]
}

// ============================================================================
// Emotion-Organ Feedback
// ============================================================================

export interface EmotionOrganImpact {
  emotion: ComplexEmotion
  targetOrgan: 'liver' | 'lung' | 'heart' | 'spleen' | 'kidney'
  damageType: 'qi' | 'blood' | 'yin' | 'yang'
  damageAmount: number // Per emotion instance
}

// Classic emotion-organ relationships (五志傷五臟)
const EMOTION_ORGAN_MAP: Record<string, EmotionOrganImpact> = {
  // 怒傷肝 (Anger damages liver)
  anger: {
    emotion: 'anger' as ComplexEmotion,
    targetOrgan: 'liver',
    damageType: 'qi',
    damageAmount: 0.05,
  },
  rage: {
    emotion: 'rage' as ComplexEmotion,
    targetOrgan: 'liver',
    damageType: 'qi',
    damageAmount: 0.1, // Worse than anger
  },

  // 悲傷肺 (Grief damages lung)
  sadness: {
    emotion: 'sadness' as ComplexEmotion,
    targetOrgan: 'lung',
    damageType: 'qi',
    damageAmount: 0.04,
  },

  // 思傷脾 (Worry damages spleen)
  anxiety: {
    emotion: 'anxiety' as ComplexEmotion,
    targetOrgan: 'spleen',
    damageType: 'qi',
    damageAmount: 0.03,
  },
}

// ============================================================================
// Complete Organ-Soul State
// ============================================================================

export interface OrganSoulState {
  // Reference to souls
  hunSouls: EmergentHunSoul[]
  poSouls: EmergentPoSoul[]

  // Organ systems
  liver: LiverState
  lung: LungState

  // Current pathologies
  liverPathology: LiverPathology
  lungPathology: LungPathology

  // Feedback metrics
  hunHealthFromLiver: number // 0-1, how much liver supports hun
  poHealthFromLung: number // 0-1, how much lung supports po
}

// ============================================================================
// Organ-Soul Correspondence Engine
// ============================================================================

export class OrganSoulCorrespondenceEngine {
  private state: OrganSoulState

  constructor(hunSouls: EmergentHunSoul[], poSouls: EmergentPoSoul[]) {
    this.state = this.initializeFromSouls(hunSouls, poSouls)
  }

  /**
   * Initialize organ states from emergent souls
   * 從湧現的魂魄初始化臟腑狀態
   */
  private initializeFromSouls(
    hunSouls: EmergentHunSoul[],
    poSouls: EmergentPoSoul[],
  ): OrganSoulState {
    // Calculate average hun strength
    const avgHunStrength = hunSouls.reduce((sum, h) => sum + h.strength, 0) / hunSouls.length
    const avgHunPurity = hunSouls.reduce((sum, h) => sum + h.purity, 0) / hunSouls.length

    // Calculate average po strength
    const avgPoStrength = poSouls.reduce((sum, p) => sum + p.strength, 0) / poSouls.length

    return {
      hunSouls,
      poSouls,

      // Liver state initialized from hun strength
      liver: {
        liverBlood: avgHunStrength * 0.9, // Strong hun needs strong liver blood
        liverQi: avgHunStrength * 0.85,
        qiFlowSmoothness: avgHunPurity * 0.9, // Pure hun = smooth qi
        bloodStorageCapacity: avgHunStrength * 0.8,
        emotionalRegulation: avgHunStrength * 0.7,
        hunStability: avgHunStrength * 0.95,
        hunDissociation: (1.0 - avgHunStrength) * 0.3,
        liverQiStagnation: 0,
        liverFireAscending: 0,
        liverBloodDeficiency: 1.0 - avgHunStrength,
      },

      // Lung state initialized from po strength
      lung: {
        lungQi: avgPoStrength * 0.9,
        lungYin: avgPoStrength * 0.8,
        qiGoverning: avgPoStrength * 0.85,
        defensiveQi: avgPoStrength * 0.9,
        breathingCapacity: avgPoStrength * 0.95,
        poConsolidation: avgPoStrength * 0.9,
        poScattering: (1.0 - avgPoStrength) * 0.3,
        lungQiDeficiency: 1.0 - avgPoStrength,
        lungYinDeficiency: (1.0 - avgPoStrength) * 0.5,
        griefAccumulation: 0,
      },

      liverPathology: {
        type: 'healthy',
        severity: 0,
        symptoms: [],
        emotionalSymptoms: [],
        hunSymptoms: [],
      },

      lungPathology: {
        type: 'healthy',
        severity: 0,
        symptoms: [],
        emotionalSymptoms: [],
        poSymptoms: [],
      },

      hunHealthFromLiver: avgHunStrength,
      poHealthFromLung: avgPoStrength,
    }
  }

  /**
   * Process emotion impact on organs
   * 處理情緒對臟腑的影響
   *
   * Doctrine: "大怒傷肝，悲則氣消"
   */
  processEmotionImpact(emotion: ComplexEmotion, intensity: number): {
    liverDamage?: number
    lungDamage?: number
    hunImpact?: string
    poImpact?: string
  } {
    const impact = EMOTION_ORGAN_MAP[emotion]
    if (!impact) return {}

    const result: any = {}

    if (impact.targetOrgan === 'liver') {
      // Anger damages liver qi
      const damage = impact.damageAmount * intensity

      if (impact.damageType === 'qi') {
        this.state.liver.liverQi = Math.max(0, this.state.liver.liverQi - damage)

        // If qi damaged enough, causes stagnation or fire
        if (intensity > 0.7) {
          // Intense anger → liver fire ascending
          this.state.liver.liverFireAscending = Math.min(
            1.0,
            this.state.liver.liverFireAscending + damage * 1.5,
          )
          result.hunImpact = 'Hun agitated by liver fire - mental restlessness, mania'
        } else {
          // Chronic anger → liver qi stagnation
          this.state.liver.liverQiStagnation = Math.min(
            1.0,
            this.state.liver.liverQiStagnation + damage,
          )
          result.hunImpact = 'Hun trapped by liver qi stagnation - depression, no life goals'
        }
      }

      result.liverDamage = damage
    }

    if (impact.targetOrgan === 'lung') {
      // Grief damages lung qi
      const damage = impact.damageAmount * intensity

      if (impact.damageType === 'qi') {
        this.state.lung.lungQi = Math.max(0, this.state.lung.lungQi - damage)
        this.state.lung.griefAccumulation = Math.min(
          1.0,
          this.state.lung.griefAccumulation + damage,
        )

        // Grief depletes lung qi → po scatters
        this.state.lung.poScattering = Math.min(1.0, this.state.lung.poScattering + damage * 0.5)

        result.poImpact =
          'Po scattered by grief - sensory numbness, weakened immune system, chronic pessimism'
      }

      result.lungDamage = damage
    }

    // Update pathologies
    this.updatePathologies()

    return result
  }

  /**
   * Process hun-liver feedback
   * 處理魂-肝反饋
   *
   * Mechanism: "肝藏血，血舍魂"
   */
  updateHunLiverDynamics(): {
    hunStabilityChange: number
    symptoms: string[]
  } {
    const liver = this.state.liver
    const symptoms: string[] = []

    // Liver blood nourishes hun
    if (liver.liverBlood > 0.7) {
      // Sufficient blood → hun stable
      liver.hunStability = Math.min(1.0, liver.hunStability + 0.02)
      liver.hunDissociation = Math.max(0, liver.hunDissociation - 0.02)
      this.state.hunHealthFromLiver = liver.liverBlood * 0.95
    } else {
      // Deficient blood → hun dissociates
      liver.hunStability = Math.max(0, liver.hunStability - 0.03)
      liver.hunDissociation = Math.min(1.0, liver.hunDissociation + 0.03)
      this.state.hunHealthFromLiver = liver.liverBlood * 0.5

      symptoms.push('Insomnia', 'Nightmares', 'Anxiety', 'Poor concentration')
    }

    // Liver qi stagnation → hun trapped
    if (liver.liverQiStagnation > 0.5) {
      symptoms.push('Depression', 'No life goals', 'Indecisiveness', 'Hopelessness')
    }

    // Liver fire → hun agitated
    if (liver.liverFireAscending > 0.5) {
      symptoms.push('Mania', 'Rage outbursts', 'Hysterical behavior', 'Insomnia with vivid dreams')
    }

    const stabilityChange = liver.hunStability - liver.hunDissociation

    return {
      hunStabilityChange: stabilityChange,
      symptoms,
    }
  }

  /**
   * Process po-lung feedback
   * 處理魄-肺反饋
   *
   * Mechanism: "肺主氣，魄依附於氣"
   */
  updatePoLungDynamics(): {
    poConsolidationChange: number
    symptoms: string[]
  } {
    const lung = this.state.lung
    const symptoms: string[] = []

    // Lung qi supports po
    if (lung.lungQi > 0.7) {
      // Strong qi → po consolidated (魄力 = courage)
      lung.poConsolidation = Math.min(1.0, lung.poConsolidation + 0.02)
      lung.poScattering = Math.max(0, lung.poScattering - 0.02)
      this.state.poHealthFromLung = lung.lungQi * 0.95
    } else {
      // Weak qi → po scatters
      lung.poConsolidation = Math.max(0, lung.poConsolidation - 0.03)
      lung.poScattering = Math.min(1.0, lung.poScattering + 0.03)
      this.state.poHealthFromLung = lung.lungQi * 0.5

      symptoms.push('Weak voice', 'Dull senses', 'Poor reflexes', 'Easily frightened', 'Timid')
    }

    // Grief accumulation → po weakened
    if (lung.griefAccumulation > 0.5) {
      symptoms.push(
        'Chronic pessimism',
        'Sensory numbness',
        'Immune weakness',
        'Chest tightness',
        'Shortness of breath',
      )
    }

    const consolidationChange = lung.poConsolidation - lung.poScattering

    return {
      poConsolidationChange: consolidationChange,
      symptoms,
    }
  }

  /**
   * Soothe liver (舒肝) - Treatment
   */
  sootheLiver(method: 'meditation' | 'herbal' | 'acupuncture', intensity: number): void {
    const liver = this.state.liver

    // Reduce stagnation
    liver.liverQiStagnation = Math.max(0, liver.liverQiStagnation - intensity * 0.3)

    // Reduce fire
    liver.liverFireAscending = Math.max(0, liver.liverFireAscending - intensity * 0.2)

    // Improve qi flow
    liver.qiFlowSmoothness = Math.min(1.0, liver.qiFlowSmoothness + intensity * 0.1)

    console.log(`    [Organ-Soul] Soothed liver via ${method} - Hun stability restored`)
  }

  /**
   * Nourish liver blood (補肝血) - Treatment
   */
  nourishLiverBlood(intensity: number): void {
    this.state.liver.liverBlood = Math.min(1.0, this.state.liver.liverBlood + intensity * 0.15)
    this.state.liver.liverBloodDeficiency = Math.max(
      0,
      this.state.liver.liverBloodDeficiency - intensity * 0.15,
    )

    console.log(`    [Organ-Soul] Nourished liver blood - Hun has a home again`)
  }

  /**
   * Tonify lung qi (補肺氣) - Treatment
   */
  tonifyLungQi(intensity: number): void {
    this.state.lung.lungQi = Math.min(1.0, this.state.lung.lungQi + intensity * 0.15)
    this.state.lung.lungQiDeficiency = Math.max(
      0,
      this.state.lung.lungQiDeficiency - intensity * 0.15,
    )

    console.log(`    [Organ-Soul] Tonified lung qi - Po consolidated, courage restored`)
  }

  /**
   * Update pathology diagnoses
   */
  private updatePathologies(): void {
    // Liver pathology
    const liver = this.state.liver

    if (liver.liverFireAscending > 0.5) {
      this.state.liverPathology = {
        type: 'fire-ascending',
        severity: liver.liverFireAscending,
        symptoms: ['Red face', 'Headache', 'Dizziness', 'Bitter taste'],
        emotionalSymptoms: ['Irritability', 'Rage', 'Impatience'],
        hunSymptoms: ['Agitated hun', 'Mania', 'Insomnia with vivid dreams'],
      }
    } else if (liver.liverQiStagnation > 0.5) {
      this.state.liverPathology = {
        type: 'qi-stagnation',
        severity: liver.liverQiStagnation,
        symptoms: ['Chest tightness', 'Sighing', 'Rib-side pain'],
        emotionalSymptoms: ['Depression', 'Frustration', 'Mood swings'],
        hunSymptoms: ['Trapped hun', 'No life direction', 'Indecisiveness'],
      }
    } else if (liver.liverBloodDeficiency > 0.5) {
      this.state.liverPathology = {
        type: 'blood-deficiency',
        severity: liver.liverBloodDeficiency,
        symptoms: ['Pale face', 'Dizziness', 'Blurred vision', 'Numbness'],
        emotionalSymptoms: ['Anxiety', 'Timidity'],
        hunSymptoms: ['Dissociated hun', 'Insomnia', 'Nightmares', 'Poor memory'],
      }
    } else {
      this.state.liverPathology = {
        type: 'healthy',
        severity: 0,
        symptoms: [],
        emotionalSymptoms: [],
        hunSymptoms: [],
      }
    }

    // Lung pathology
    const lung = this.state.lung

    if (lung.griefAccumulation > 0.5) {
      this.state.lungPathology = {
        type: 'grief-depletion',
        severity: lung.griefAccumulation,
        symptoms: ['Weak voice', 'Shortness of breath', 'Chest oppression'],
        emotionalSymptoms: ['Chronic sadness', 'Pessimism', 'Emotional numbness'],
        poSymptoms: ['Scattered po', 'Sensory dullness', 'Immune weakness'],
      }
    } else if (lung.lungQiDeficiency > 0.5) {
      this.state.lungPathology = {
        type: 'qi-deficiency',
        severity: lung.lungQiDeficiency,
        symptoms: ['Weak breathing', 'Spontaneous sweating', 'Catches colds easily'],
        emotionalSymptoms: ['Easily frightened', 'Timid'],
        poSymptoms: ['Weak po', 'No courage (魄力)', 'Poor reflexes'],
      }
    } else {
      this.state.lungPathology = {
        type: 'healthy',
        severity: 0,
        symptoms: [],
        emotionalSymptoms: [],
        poSymptoms: [],
      }
    }
  }

  /**
   * Step simulation
   */
  step(): {
    hunHealth: number
    poHealth: number
    liverPathology: LiverPathology
    lungPathology: LungPathology
  } {
    // Update hun-liver dynamics
    this.updateHunLiverDynamics()

    // Update po-lung dynamics
    this.updatePoLungDynamics()

    // Natural recovery (slow)
    this.state.liver.liverQi = Math.min(1.0, this.state.liver.liverQi + 0.001)
    this.state.lung.lungQi = Math.min(1.0, this.state.lung.lungQi + 0.001)

    return {
      hunHealth: this.state.hunHealthFromLiver,
      poHealth: this.state.poHealthFromLung,
      liverPathology: this.state.liverPathology,
      lungPathology: this.state.lungPathology,
    }
  }

  // Getters
  getState(): OrganSoulState {
    return this.state
  }

  getHunHealth(): number {
    return this.state.hunHealthFromLiver
  }

  getPoHealth(): number {
    return this.state.poHealthFromLung
  }

  getLiverPathology(): LiverPathology {
    return this.state.liverPathology
  }

  getLungPathology(): LungPathology {
    return this.state.lungPathology
  }
}
