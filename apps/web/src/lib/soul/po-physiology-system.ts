/**
 * Po Physiology System
 * 魄的生理功能系統
 *
 * Implements the 7 traditional Po soul physiological functions with precise simulation.
 * Based on authentic Daoist medical theory (《雲笈七籤》, 《太上除三尸九蟲保生經》).
 *
 * Seven Po Functions:
 * 1. Shi Gou (尸狗) - Sleep vigilance, threat detection during rest
 * 2. Fu Shi (伏矢) - Digestion, excretion, food transformation
 * 3. Que Yin (雀陰) - Reproductive repair, nocturnal restoration
 * 4. Tun Zei (吞贼) - Immune system, pathogen phagocytosis
 * 5. Fei Du (非毒) - Detoxification, toxin dispersal
 * 6. Chu Hui (除秽) - Metabolism, waste removal
 * 7. Chou Fei (臭肺) - Breath regulation, qi circulation
 *
 * Integration: Uses EmergentPoSoul from chaotic-emergence-system.ts
 */

import type { EmergentPoSoul } from './chaotic-emergence-system'

// ============================================================================
// Sleep Vigilance System (尸狗 - Shi Gou)
// ============================================================================

export interface SleepVigilanceState {
  vigilanceThreshold: number // 0-1, how easily awakened during sleep
  threatSensitivity: number // 0-1, sensitivity to danger signals
  currentSleepDepth: number // 0-1, 0=awake, 1=deep sleep
  falseAlarmRate: number // 0-1, tendency to wake for non-threats

  // Active monitoring
  detectedThreats: Threat[]
  lastWakeTime?: number
  consecutiveFalseAlarms: number
}

export interface Threat {
  type: 'sound' | 'touch' | 'smell' | 'danger-sense'
  intensity: number // 0-1
  source?: string
  timestamp: number
}

export interface WakeResponse {
  shouldWake: boolean
  wakeIntensity: number // 0-1, partial vs full awakening
  arousalSpike: number // Immediate arousal increase
  energyCost: number // Energy consumed by waking
}

// ============================================================================
// Digestion & Excretion System (伏矢 - Fu Shi)
// ============================================================================

export interface DigestionState {
  digestiveCapacity: number // 0-1, efficiency of food transformation
  excretionEfficiency: number // 0-1, how well waste is removed
  gutHealth: number // 0-1, overall digestive system health

  // Processing pipeline
  foodIntake: number // Accumulated food
  nutrientsExtracted: number // Useful energy extracted
  wasteAccumulated: number // Toxins/waste to excrete

  // Pathology
  constipation: number // 0-1, difficulty excreting
  diarrhea: number // 0-1, too-fast excretion
  bloating: number // 0-1, gas accumulation
}

// ============================================================================
// Reproductive Repair System (雀陰 - Que Yin)
// ============================================================================

export interface ReproductiveRepairState {
  reproductiveHealth: number // 0-1, overall reproductive system health
  nocturnalRepairRate: number // 0-1, how much repair happens during sleep
  sexualVitality: number // 0-1, sexual energy/function

  // Nocturnal functions
  lastNocturnalRepair?: number
  repairDeficit: number // Accumulated damage needing repair

  // Reproductive capacity
  fertilityPotential: number // 0-1
  libidoLevel: number // 0-1
}

// ============================================================================
// Immune & Phagocytosis System (吞贼 - Tun Zei)
// ============================================================================

export interface ImmuneState {
  immuneStrength: number // 0-1, overall immune capacity
  phagocytosisRate: number // 0-1, how efficiently pathogens are eliminated
  autoimmuneTendency: number // 0-1, risk of attacking self

  // Active threats
  activePathogens: Pathogen[]
  antibodyMemory: Map<string, number> // pathogen type → resistance level

  // Immune function (most active during sleep)
  lastImmuneCheck?: number
  infectionRisk: number // 0-1, current vulnerability
}

export interface Pathogen {
  type: string // 'virus', 'bacteria', 'toxin'
  strength: number // 0-1
  timestamp: number
}

// ============================================================================
// Detoxification System (非毒 - Fei Du)
// ============================================================================

export interface DetoxificationState {
  detoxCapacity: number // 0-1, how well toxins are dispersed
  toxinAccumulation: number // 0-1, total toxin load
  dispersalRate: number // 0-1, speed of toxin breakdown

  // Toxin types
  toxins: Map<string, number> // toxin type → concentration

  // Pathology
  toxinStagnation: number // 0-1, toxins stuck in one place
  organDamageFromToxins: number // 0-1, cumulative damage
}

// ============================================================================
// Metabolic Waste System (除秽 - Chu Hui)
// ============================================================================

export interface MetabolicWasteState {
  metabolicEfficiency: number // 0-1, how cleanly cells operate
  wasteRemovalRate: number // 0-1, how fast waste is cleared
  cellularRenewal: number // 0-1, new cell production rate

  // Waste tracking
  metabolicWaste: number // Accumulated cellular waste
  skinTone: number // 0-1, 1=clear, 0=dull (waste buildup)
  bodyOdor: number // 0-1, waste excretion through skin

  // Pathology
  wasteStagnation: number // 0-1
  prematureAging: number // 0-1, from waste accumulation
}

// ============================================================================
// Breath Regulation System (臭肺 - Chou Fei)
// ============================================================================

export interface BreathRegulationState {
  breathDepth: number // 0-1, how deeply breathing
  breathRate: number // breaths per minute (simulated)
  breathRhythm: number // 0-1, how regular/smooth
  qiCirculation: number // 0-1, how well qi flows with breath

  // Autonomic regulation
  autonomicControl: number // 0-1, how automatic breathing is
  breathHolding: number // 0-1, ability to consciously hold breath

  // Pathology
  breathShallowness: number // 0-1, too-shallow breathing
  breathIrregularity: number // 0-1, erratic rhythm
  asthmaRisk: number // 0-1
}

// ============================================================================
// Complete Po Physiology State
// ============================================================================

export interface PoPhysiologyState {
  // Reference to emergent po souls
  poSouls: EmergentPoSoul[]

  // Seven physiological systems
  sleepVigilance: SleepVigilanceState
  digestion: DigestionState
  reproductiveRepair: ReproductiveRepairState
  immune: ImmuneState
  detoxification: DetoxificationState
  metabolicWaste: MetabolicWasteState
  breathRegulation: BreathRegulationState

  // Overall po health
  overallPoHealth: number // 0-1, average of all systems
  poVitality: number // 0-1, life force from po
}

// ============================================================================
// Po Physiology Engine
// ============================================================================

export class PoPhysiologyEngine {
  private state: PoPhysiologyState
  private isAsleepFlag: boolean = false
  private timeOfDayValue: 'day' | 'night' = 'day'

  constructor(poSouls: EmergentPoSoul[]) {
    this.state = this.initializeFromPoSouls(poSouls)
  }

  /**
   * Initialize physiological systems from emergent po souls
   * 從湧現的魄初始化生理系統
   */
  private initializeFromPoSouls(poSouls: EmergentPoSoul[]): PoPhysiologyState {
    // Find each po soul by name
    const shiGou = poSouls.find((p) => p.name.includes('尸狗'))
    const fuShi = poSouls.find((p) => p.name.includes('伏矢'))
    const queYin = poSouls.find((p) => p.name.includes('雀陰'))
    const tunZei = poSouls.find((p) => p.name.includes('吞贼'))
    const feiDu = poSouls.find((p) => p.name.includes('非毒'))
    const chuHui = poSouls.find((p) => p.name.includes('除秽'))
    const chouFei = poSouls.find((p) => p.name.includes('臭肺')) // May not exist if only 6 po

    return {
      poSouls,

      // Shi Gou (尸狗) - Sleep Vigilance
      sleepVigilance: {
        vigilanceThreshold: shiGou ? 1.0 - shiGou.strength : 0.5,
        threatSensitivity: shiGou ? shiGou.strength * 0.9 : 0.4,
        currentSleepDepth: 0.0,
        falseAlarmRate: shiGou ? (1.0 - shiGou.strength) * 0.3 : 0.2,
        detectedThreats: [],
        consecutiveFalseAlarms: 0,
      },

      // Fu Shi (伏矢) - Digestion
      digestion: {
        digestiveCapacity: fuShi ? fuShi.strength * 0.9 : 0.5,
        excretionEfficiency: fuShi ? fuShi.strength * 0.85 : 0.5,
        gutHealth: fuShi ? fuShi.strength : 0.6,
        foodIntake: 0,
        nutrientsExtracted: 0,
        wasteAccumulated: 0,
        constipation: fuShi ? (1.0 - fuShi.strength) * 0.3 : 0.1,
        diarrhea: 0,
        bloating: 0,
      },

      // Que Yin (雀陰) - Reproductive Repair
      reproductiveRepair: {
        reproductiveHealth: queYin ? queYin.strength * 0.9 : 0.6,
        nocturnalRepairRate: queYin ? queYin.strength * 0.8 : 0.4,
        sexualVitality: queYin ? queYin.strength : 0.5,
        repairDeficit: 0,
        fertilityPotential: queYin ? queYin.strength * 0.85 : 0.5,
        libidoLevel: queYin ? queYin.strength * 0.7 : 0.4,
      },

      // Tun Zei (吞贼) - Immune
      immune: {
        immuneStrength: tunZei ? tunZei.strength * 0.95 : 0.5,
        phagocytosisRate: tunZei ? tunZei.strength * 0.9 : 0.5,
        autoimmuneTendency: tunZei ? (1.0 - tunZei.strength) * 0.2 : 0.05,
        activePathogens: [],
        antibodyMemory: new Map(),
        infectionRisk: tunZei ? 1.0 - tunZei.strength : 0.5,
      },

      // Fei Du (非毒) - Detoxification
      detoxification: {
        detoxCapacity: feiDu ? feiDu.strength * 0.9 : 0.5,
        toxinAccumulation: feiDu ? (1.0 - feiDu.strength) * 0.3 : 0.2,
        dispersalRate: feiDu ? feiDu.strength * 0.85 : 0.5,
        toxins: new Map(),
        toxinStagnation: feiDu ? (1.0 - feiDu.strength) * 0.2 : 0.1,
        organDamageFromToxins: 0,
      },

      // Chu Hui (除秽) - Metabolic Waste
      metabolicWaste: {
        metabolicEfficiency: chuHui ? chuHui.strength * 0.9 : 0.6,
        wasteRemovalRate: chuHui ? chuHui.strength * 0.85 : 0.5,
        cellularRenewal: chuHui ? chuHui.strength * 0.8 : 0.5,
        metabolicWaste: chuHui ? (1.0 - chuHui.strength) * 0.3 : 0.2,
        skinTone: chuHui ? chuHui.strength : 0.7,
        bodyOdor: chuHui ? (1.0 - chuHui.strength) * 0.3 : 0.2,
        wasteStagnation: 0,
        prematureAging: 0,
      },

      // Chou Fei (臭肺) - Breath Regulation
      breathRegulation: {
        breathDepth: chouFei ? chouFei.strength * 0.9 : 0.6,
        breathRate: chouFei ? 12 + (1.0 - chouFei.strength) * 8 : 16, // 12-20 breaths/min
        breathRhythm: chouFei ? chouFei.strength * 0.95 : 0.7,
        qiCirculation: chouFei ? chouFei.strength * 0.9 : 0.6,
        autonomicControl: chouFei ? chouFei.strength : 0.8,
        breathHolding: chouFei ? chouFei.strength * 0.7 : 0.5,
        breathShallowness: chouFei ? (1.0 - chouFei.strength) * 0.4 : 0.2,
        breathIrregularity: chouFei ? (1.0 - chouFei.strength) * 0.3 : 0.15,
        asthmaRisk: chouFei ? (1.0 - chouFei.strength) * 0.2 : 0.1,
      },

      overallPoHealth: poSouls.reduce((sum, p) => sum + p.strength, 0) / poSouls.length,
      poVitality: poSouls.reduce((sum, p) => sum + p.strength, 0) / poSouls.length,
    }
  }

  /**
   * Simulate one physiology step
   * 模擬一個生理步驟
   */
  step(context: {
    isAsleep: boolean
    timeOfDay: 'day' | 'night'
    stressLevel: number // 0-1
    foodIntake?: number
    threats?: Threat[]
    pathogens?: Pathogen[]
    toxins?: Map<string, number>
  }): PhysiologyReport {
    this.isAsleepFlag = context.isAsleep
    this.timeOfDayValue = context.timeOfDay

    const report: PhysiologyReport = {
      timestamp: Date.now(),
      systems: {},
    }

    // 1. Shi Gou (尸狗) - Sleep Vigilance (active during sleep)
    if (context.isAsleep) {
      report.systems.sleepVigilance = this.processSleepVigilance(context.threats || [])
    }

    // 2. Fu Shi (伏矢) - Digestion (continuous)
    if (context.foodIntake !== undefined) {
      report.systems.digestion = this.processDigestion(context.foodIntake)
    }

    // 3. Que Yin (雀陰) - Reproductive Repair (active during night sleep)
    if (context.isAsleep && context.timeOfDay === 'night') {
      report.systems.reproductiveRepair = this.processReproductiveRepair()
    }

    // 4. Tun Zei (吞贼) - Immune (most active during sleep)
    if (context.isAsleep) {
      report.systems.immune = this.processImmune(context.pathogens || [])
    }

    // 5. Fei Du (非毒) - Detoxification (continuous, faster during rest)
    report.systems.detoxification = this.processDetoxification(
      context.toxins || new Map(),
      context.isAsleep,
    )

    // 6. Chu Hui (除秽) - Metabolic Waste (continuous)
    report.systems.metabolicWaste = this.processMetabolicWaste()

    // 7. Chou Fei (臭肺) - Breath Regulation (continuous, adjusts to stress)
    report.systems.breathRegulation = this.processBreathRegulation(context.stressLevel)

    // Update overall health
    this.updateOverallHealth()

    return report
  }

  // --------------------------------------------------------------------------
  // Individual System Processors
  // --------------------------------------------------------------------------

  private processSleepVigilance(threats: Threat[]): any {
    const sv = this.state.sleepVigilance

    // Add new threats
    sv.detectedThreats = threats

    // Check each threat
    const wakeResponses: WakeResponse[] = []
    for (const threat of threats) {
      // Should we wake?
      const threatExceedsThreshold = threat.intensity > sv.vigilanceThreshold
      const detectedByHighSensitivity = Math.random() < sv.threatSensitivity

      if (threatExceedsThreshold || detectedByHighSensitivity) {
        const shouldWake = Math.random() < sv.threatSensitivity

        // But might be false alarm
        const isFalseAlarm = Math.random() < sv.falseAlarmRate

        wakeResponses.push({
          shouldWake: shouldWake && !isFalseAlarm,
          wakeIntensity: threat.intensity,
          arousalSpike: threat.intensity * 0.5,
          energyCost: 0.05,
        })

        if (isFalseAlarm) {
          sv.consecutiveFalseAlarms++
        } else {
          sv.consecutiveFalseAlarms = 0
        }
      }
    }

    return {
      threatsDetected: threats.length,
      wakeResponses,
      vigilanceLevel: sv.threatSensitivity,
    }
  }

  private processDigestion(foodIntake: number): any {
    const dig = this.state.digestion

    dig.foodIntake += foodIntake

    // Extract nutrients
    const extracted = dig.foodIntake * dig.digestiveCapacity * 0.7
    dig.nutrientsExtracted += extracted
    dig.foodIntake -= extracted

    // Generate waste
    const waste = extracted * 0.3
    dig.wasteAccumulated += waste

    // Excrete waste
    const excreted = dig.wasteAccumulated * dig.excretionEfficiency * 0.5
    dig.wasteAccumulated -= excreted

    // Pathology
    if (dig.wasteAccumulated > 0.7) {
      dig.constipation = Math.min(1.0, dig.constipation + 0.05)
      dig.bloating = Math.min(1.0, dig.bloating + 0.03)
    } else {
      dig.constipation = Math.max(0, dig.constipation - 0.02)
      dig.bloating = Math.max(0, dig.bloating - 0.02)
    }

    return {
      nutrientsExtracted: extracted,
      wasteExcreted: excreted,
      gutHealth: dig.gutHealth,
      constipation: dig.constipation,
    }
  }

  private processReproductiveRepair(): any {
    const rr = this.state.reproductiveRepair

    // Nocturnal repair
    const repairAmount = rr.nocturnalRepairRate * 0.1
    rr.repairDeficit = Math.max(0, rr.repairDeficit - repairAmount)
    rr.reproductiveHealth = Math.min(1.0, rr.reproductiveHealth + repairAmount * 0.5)

    // Restore vitality
    rr.sexualVitality = Math.min(1.0, rr.sexualVitality + 0.05)

    return {
      repairPerformed: repairAmount,
      currentHealth: rr.reproductiveHealth,
      vitalityRestored: 0.05,
    }
  }

  private processImmune(newPathogens: Pathogen[]): any {
    const imm = this.state.immune

    // Add new pathogens
    imm.activePathogens.push(...newPathogens)

    // Phagocytosis (吞噬) - literally "swallowing" pathogens
    const eliminatedCount = Math.floor(
      imm.activePathogens.length * imm.phagocytosisRate * 0.3,
    )

    for (let i = 0; i < eliminatedCount; i++) {
      const pathogen = imm.activePathogens.shift()
      if (pathogen) {
        // Build antibody memory
        const currentMemory = imm.antibodyMemory.get(pathogen.type) || 0
        imm.antibodyMemory.set(pathogen.type, Math.min(1.0, currentMemory + 0.1))
      }
    }

    // Update infection risk
    imm.infectionRisk = imm.activePathogens.length > 0 ? 0.7 : 0.1

    return {
      pathogensEliminated: eliminatedCount,
      remainingPathogens: imm.activePathogens.length,
      immuneStrength: imm.immuneStrength,
    }
  }

  private processDetoxification(newToxins: Map<string, number>, isAsleep: boolean): any {
    const detox = this.state.detoxification

    // Add new toxins
    for (const [type, amount] of newToxins) {
      const current = detox.toxins.get(type) || 0
      detox.toxins.set(type, current + amount)
    }

    // Dispersal (faster during sleep/rest)
    const dispersalMultiplier = isAsleep ? 1.5 : 1.0
    let totalDispersed = 0

    for (const [type, amount] of detox.toxins) {
      const dispersed = amount * detox.dispersalRate * 0.2 * dispersalMultiplier
      detox.toxins.set(type, Math.max(0, amount - dispersed))
      totalDispersed += dispersed
    }

    // Update total accumulation
    detox.toxinAccumulation = Array.from(detox.toxins.values()).reduce((sum, v) => sum + v, 0)

    // Organ damage from toxins
    if (detox.toxinAccumulation > 0.8) {
      detox.organDamageFromToxins = Math.min(1.0, detox.organDamageFromToxins + 0.01)
    }

    return {
      toxinsDispersed: totalDispersed,
      totalToxinLoad: detox.toxinAccumulation,
      organDamage: detox.organDamageFromToxins,
    }
  }

  private processMetabolicWaste(): any {
    const meta = this.state.metabolicWaste

    // Generate waste from metabolism
    const wasteGenerated = (1.0 - meta.metabolicEfficiency) * 0.1
    meta.metabolicWaste += wasteGenerated

    // Remove waste
    const wasteRemoved = meta.metabolicWaste * meta.wasteRemovalRate * 0.3
    meta.metabolicWaste = Math.max(0, meta.metabolicWaste - wasteRemoved)

    // Update appearance
    meta.skinTone = 1.0 - meta.metabolicWaste * 0.5
    meta.bodyOdor = meta.metabolicWaste * 0.6

    // Aging from waste accumulation
    if (meta.metabolicWaste > 0.7) {
      meta.prematureAging = Math.min(1.0, meta.prematureAging + 0.005)
    }

    // Cellular renewal
    const renewalAmount = meta.cellularRenewal * 0.05
    meta.metabolicWaste = Math.max(0, meta.metabolicWaste - renewalAmount * 0.5)

    return {
      wasteRemoved,
      skinTone: meta.skinTone,
      cellularRenewal: renewalAmount,
      aging: meta.prematureAging,
    }
  }

  private processBreathRegulation(stressLevel: number): any {
    const breath = this.state.breathRegulation

    // Stress affects breath
    if (stressLevel > 0.5) {
      // Shallow, rapid breathing when stressed
      breath.breathDepth = Math.max(0.3, breath.breathDepth - 0.05)
      breath.breathRate = Math.min(25, breath.breathRate + 2)
      breath.breathRhythm = Math.max(0.4, breath.breathRhythm - 0.05)
    } else {
      // Return to normal
      const shiGou = this.state.poSouls.find((p) => p.name.includes('臭肺'))
      const targetDepth = shiGou ? shiGou.strength * 0.9 : 0.6
      breath.breathDepth = Math.min(targetDepth, breath.breathDepth + 0.03)
      breath.breathRate = Math.max(12, breath.breathRate - 1)
      breath.breathRhythm = Math.min(0.95, breath.breathRhythm + 0.03)
    }

    // Qi circulation follows breath
    breath.qiCirculation = breath.breathDepth * breath.breathRhythm

    return {
      breathDepth: breath.breathDepth,
      breathRate: breath.breathRate,
      qiCirculation: breath.qiCirculation,
    }
  }

  private updateOverallHealth(): void {
    const avg =
      (this.state.digestion.gutHealth +
        this.state.reproductiveRepair.reproductiveHealth +
        this.state.immune.immuneStrength +
        (1.0 - this.state.detoxification.toxinAccumulation) +
        this.state.metabolicWaste.metabolicEfficiency +
        this.state.breathRegulation.qiCirculation) /
      6

    this.state.overallPoHealth = avg
    this.state.poVitality = avg * 0.9
  }

  // Getters
  getState(): PoPhysiologyState {
    return this.state
  }

  getOverallHealth(): number {
    return this.state.overallPoHealth
  }

  getPoVitality(): number {
    return this.state.poVitality
  }
}

// ============================================================================
// Report Interface
// ============================================================================

export interface PhysiologyReport {
  timestamp: number
  systems: {
    sleepVigilance?: any
    digestion?: any
    reproductiveRepair?: any
    immune?: any
    detoxification?: any
    metabolicWaste?: any
    breathRegulation?: any
  }
}
