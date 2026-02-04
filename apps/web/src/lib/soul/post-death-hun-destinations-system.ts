/**
 * Post-Death Hun Destinations System
 * 死後魂歸系統
 *
 * Implements traditional Daoist/Buddhist understanding of post-death soul destinations.
 *
 * Hun Destinations (魂歸何處):
 * 1. 成仙 (Immortality) - Golden elixir cultivators transcend death
 * 2. 天界 (Heaven) - Virtuous souls ascend to heavenly realms
 * 3. 輪迴 (Reincarnation) - Six realms based on karma
 * 4. 鬼界 (Ghost Realm) - Souls with unfinished business or attachments
 * 5. 地獄 (Hell) - Temporary purification for severe sins
 *
 * Six Realms of Reincarnation (六道輪迴):
 * 1. 天道 (Deva/God Realm) - High virtue, but not enlightenment
 * 2. 阿修羅道 (Asura Realm) - Powerful but prideful/jealous
 * 3. 人道 (Human Realm) - Mixed karma, optimal for cultivation
 * 4. 畜生道 (Animal Realm) - Ignorance, instinct-driven
 * 5. 餓鬼道 (Hungry Ghost Realm) - Greed, insatiable desire
 * 6. 地獄道 (Hell Realm) - Hatred, violence, severe sins
 *
 * Bardo State (中陰):
 * - Intermediate state between death and rebirth (49 days)
 * - Hun experiences visions based on karma
 * - Opportunity for liberation through recognition
 *
 * Integration: Uses EmergentHunSoul, DeathEvent, cultivation level, virtue/sin
 */

import type { EmergentHunSoul } from './chaotic-emergence-system'
import type { DeathEvent } from './death-dissolution-system'
import type { CultivationStage } from './hun-po-cultivation-system'

// ============================================================================
// Destinations
// ============================================================================

export enum HunDestinationType {
  Immortality = 'immortality', // 成仙 - Transcended death
  Heaven = 'heaven', // 天界 - Heavenly realms
  Reincarnation = 'reincarnation', // 輪迴 - Six realms
  GhostRealm = 'ghost-realm', // 鬼界 - Wandering spirit
  Hell = 'hell', // 地獄 - Purification
  Liberation = 'liberation', // 解脫 - Beyond cycle (enlightenment)
}

export enum ReincarnationRealm {
  Deva = 'deva', // 天道 - Gods/celestial beings
  Asura = 'asura', // 阿修羅道 - Demigods (jealous gods)
  Human = 'human', // 人道 - Human realm
  Animal = 'animal', // 畜生道 - Animal realm
  HungryGhost = 'hungry-ghost', // 餓鬼道 - Preta realm
  Hell = 'hell', // 地獄道 - Naraka (hell beings)
}

// ============================================================================
// Karma
// ============================================================================

export interface KarmaState {
  totalVirtue: number // 0-1, accumulated virtue
  totalSin: number // 0-1, accumulated sin
  netKarma: number // -1 to +1, virtue - sin

  // Specific karma types
  generosity: number // Giving, compassion
  morality: number // Ethical conduct
  patience: number // Forbearance
  diligence: number // Effort in cultivation
  meditation: number // Spiritual practice
  wisdom: number // Understanding of truth

  // Negative karma
  killing: number
  stealing: number
  sexualMisconduct: number
  lying: number
  intoxication: number
}

// ============================================================================
// Bardo State (中陰)
// ============================================================================

export enum BardoStage {
  ChikhaiBardo = 'chikhai-bardo', // Moment of death, clear light
  ChonyidBardo = 'chonyid-bardo', // Experiencing karmic visions (7-14 days)
  SidpaBardo = 'sidpa-bardo', // Seeking rebirth (14-49 days)
}

export interface BardoState {
  stage: BardoStage
  dayInBardo: number // 0-49

  // Visions/experiences
  visions: BardoVision[]
  recognitionOpportunities: number // Chances for liberation
  recognitionAchieved: boolean // Did the soul recognize true nature?

  // Rebirth seeking
  rebirthSeeking: boolean
  rebirthOpportunitiesEncountered: RebirthOpportunity[]
  chosenRebirth: RebirthOpportunity | null
}

export interface BardoVision {
  day: number
  type: 'peaceful-deity' | 'wrathful-deity' | 'karmic-vision' | 'clear-light'
  description: string
  liberationOpportunity: boolean
}

export interface RebirthOpportunity {
  realm: ReincarnationRealm
  description: string
  karmaMatch: number // 0-1, how well it matches karma
  accepted: boolean
}

// ============================================================================
// Destination State
// ============================================================================

export interface PostDeathDestinationState {
  hunSouls: EmergentHunSoul[]
  deathEvent: DeathEvent

  // Destination determination
  destinationType: HunDestinationType
  reincarnationRealm: ReincarnationRealm | null
  heavenLevel: number | null // If heaven, which level (1-33)

  // Karma
  karma: KarmaState

  // Bardo
  inBardo: boolean
  bardo: BardoState | null

  // Special cases
  cultivatorChoice: boolean // Can cultivator choose rebirth?
  bodhisattvaVow: boolean // Chose to return to help others?
  memoryRetention: number // 0-1, memory kept across rebirth

  // Timeline
  daysSinceDeath: number
  destinationReached: boolean

  // Events
  milestones: DestinationMilestone[]
}

export interface DestinationMilestone {
  day: number
  event: string
  description: string
}

// ============================================================================
// Post-Death Hun Destinations Engine
// ============================================================================

export class PostDeathHunDestinationsEngine {
  private state: PostDeathDestinationState

  constructor(
    hunSouls: EmergentHunSoul[],
    deathEvent: DeathEvent,
    cultivationStage: CultivationStage = 'worldly' as CultivationStage,
  ) {
    this.state = this.initializeFromDeath(hunSouls, deathEvent, cultivationStage)
  }

  /**
   * Initialize destination state from death
   */
  private initializeFromDeath(
    hunSouls: EmergentHunSoul[],
    deathEvent: DeathEvent,
    cultivationStage: CultivationStage,
  ): PostDeathDestinationState {
    // Calculate karma
    const karma = this.calculateKarma(deathEvent)

    // Determine destination type
    const destinationType = this.determineDestinationType(
      deathEvent,
      cultivationStage,
      karma.netKarma,
    )

    // Determine reincarnation realm (if applicable)
    let reincarnationRealm: ReincarnationRealm | null = null
    if (destinationType === HunDestinationType.Reincarnation) {
      reincarnationRealm = this.determineReincarnationRealm(karma.netKarma)
    }

    // Heaven level (if applicable)
    let heavenLevel: number | null = null
    if (destinationType === HunDestinationType.Heaven) {
      heavenLevel = this.determineHeavenLevel(karma.netKarma)
    }

    // Cultivator privileges
    const cultivatorChoice =
      cultivationStage !== ('worldly' as CultivationStage) &&
      (cultivationStage === ('golden-elixir' as CultivationStage) ||
        cultivationStage === ('hun-refined' as CultivationStage))
    const bodhisattvaVow = false // Would be set by cultivator's choice

    // Memory retention
    const memoryRetention = this.calculateMemoryRetention(cultivationStage, karma.netKarma)

    // Initialize bardo
    const inBardo = true
    const bardo: BardoState = {
      stage: BardoStage.ChikhaiBardo,
      dayInBardo: 0,
      visions: [],
      recognitionOpportunities: 0,
      recognitionAchieved: false,
      rebirthSeeking: false,
      rebirthOpportunitiesEncountered: [],
      chosenRebirth: null,
    }

    return {
      hunSouls,
      deathEvent,

      destinationType,
      reincarnationRealm,
      heavenLevel,

      karma,

      inBardo,
      bardo,

      cultivatorChoice,
      bodhisattvaVow,
      memoryRetention,

      daysSinceDeath: 0,
      destinationReached: false,

      milestones: [
        {
          day: 0,
          event: 'Death',
          description: `Entered bardo state. Destination: ${destinationType}${reincarnationRealm ? ` (${reincarnationRealm})` : ''}`,
        },
      ],
    }
  }

  /**
   * Step simulation (one day in bardo)
   */
  step(): {
    day: number
    bardoStage: BardoStage | null
    destinationReached: boolean
    newMilestones: DestinationMilestone[]
  } {
    this.state.daysSinceDeath += 1
    const day = this.state.daysSinceDeath
    const newMilestones: DestinationMilestone[] = []

    if (!this.state.inBardo || !this.state.bardo) {
      return {
        day,
        bardoStage: null,
        destinationReached: this.state.destinationReached,
        newMilestones,
      }
    }

    this.state.bardo.dayInBardo += 1
    const bardoDay = this.state.bardo.dayInBardo

    // ========================================================================
    // Bardo Stage 1: Chikhai Bardo (Day 1-3)
    // Moment of death, clear light experience
    // ========================================================================
    if (bardoDay <= 3) {
      this.state.bardo.stage = BardoStage.ChikhaiBardo

      if (bardoDay === 1) {
        // Clear light vision (moment of death)
        this.state.bardo.visions.push({
          day: bardoDay,
          type: 'clear-light',
          description: '明光現前 (Clear light appears) - Primordial awareness',
          liberationOpportunity: true,
        })

        this.state.bardo.recognitionOpportunities += 1

        newMilestones.push({
          day,
          event: 'Clear Light',
          description: 'Clear light of death appears - Recognition = immediate liberation',
        })

        // High cultivators recognize and achieve liberation
        if (this.state.deathEvent.goldenElixirAchieved || Math.random() < 0.1) {
          this.achieveLiberation()
          newMilestones.push({
            day,
            event: 'Liberation',
            description: '解脫 - Recognized true nature, liberated from cycle',
          })
        }
      }
    }

    // ========================================================================
    // Bardo Stage 2: Chonyid Bardo (Day 4-14)
    // Karmic visions, peaceful and wrathful deities
    // ========================================================================
    if (bardoDay > 3 && bardoDay <= 14) {
      this.state.bardo.stage = BardoStage.ChonyidBardo

      // Peaceful deities (days 4-10)
      if (bardoDay <= 10 && bardoDay % 2 === 0) {
        this.state.bardo.visions.push({
          day: bardoDay,
          type: 'peaceful-deity',
          description: `Peaceful deity appears (Day ${bardoDay - 3}) - Representing enlightened qualities`,
          liberationOpportunity: true,
        })
        this.state.bardo.recognitionOpportunities += 1
      }

      // Wrathful deities (days 11-14)
      if (bardoDay > 10 && bardoDay % 2 === 0) {
        this.state.bardo.visions.push({
          day: bardoDay,
          type: 'wrathful-deity',
          description: `Wrathful deity appears (Day ${bardoDay - 3}) - Representing transmuted anger/wisdom`,
          liberationOpportunity: true,
        })
        this.state.bardo.recognitionOpportunities += 1
      }

      // Karmic visions based on past actions
      if (bardoDay === 7) {
        this.generateKarmicVision(bardoDay)
        newMilestones.push({
          day,
          event: 'Karmic Visions',
          description: 'Experiencing visions of past actions and their consequences',
        })
      }
    }

    // ========================================================================
    // Bardo Stage 3: Sidpa Bardo (Day 15-49)
    // Seeking rebirth
    // ========================================================================
    if (bardoDay > 14) {
      this.state.bardo.stage = BardoStage.SidpaBardo

      if (!this.state.bardo.rebirthSeeking) {
        this.state.bardo.rebirthSeeking = true
        newMilestones.push({
          day,
          event: 'Seeking Rebirth',
          description: 'Hun begins seeking appropriate rebirth based on karma',
        })
      }

      // Generate rebirth opportunities every 5 days
      if (bardoDay % 5 === 0) {
        this.generateRebirthOpportunity()
      }

      // Cultivators with choice can select rebirth
      if (this.state.cultivatorChoice && bardoDay === 20) {
        this.selectCultivatorRebirth()
        newMilestones.push({
          day,
          event: 'Cultivator Choice',
          description: 'Cultivator consciously chooses rebirth destination',
        })
      }

      // Ordinary souls drawn to appropriate realm by day 49
      if (bardoDay >= 49 && !this.state.bardo.chosenRebirth) {
        this.selectKarmicRebirth()
      }
    }

    // ========================================================================
    // Day 49: Final Destination
    // ========================================================================
    if (bardoDay >= 49) {
      this.reachDestination()
      newMilestones.push({
        day,
        event: 'Destination Reached',
        description: this.getDestinationDescription(),
      })
    }

    this.state.milestones.push(...newMilestones)

    return {
      day,
      bardoStage: this.state.bardo.stage,
      destinationReached: this.state.destinationReached,
      newMilestones,
    }
  }

  /**
   * Calculate karma from death event
   */
  private calculateKarma(deathEvent: DeathEvent): KarmaState {
    const virtue = deathEvent.virtue
    const sin = deathEvent.sin
    const netKarma = virtue - sin

    return {
      totalVirtue: virtue,
      totalSin: sin,
      netKarma,

      // Estimate specific karma (would be tracked throughout life)
      generosity: virtue * 0.3,
      morality: virtue * 0.4,
      patience: virtue * 0.2,
      diligence: virtue * 0.3,
      meditation: deathEvent.cultivationStage !== ('worldly' as CultivationStage) ? 0.5 : 0.1,
      wisdom: virtue * 0.2,

      killing: sin * 0.4,
      stealing: sin * 0.2,
      sexualMisconduct: sin * 0.1,
      lying: sin * 0.2,
      intoxication: sin * 0.1,
    }
  }

  /**
   * Determine destination type
   */
  private determineDestinationType(
    deathEvent: DeathEvent,
    cultivationStage: CultivationStage,
    netKarma: number,
  ): HunDestinationType {
    // Immortality: Golden elixir + three corpses eliminated
    if (deathEvent.goldenElixirAchieved && deathEvent.threeCorpsesEliminated) {
      return HunDestinationType.Immortality
    }

    // Liberation: Enlightenment (beyond heaven)
    if (cultivationStage === ('golden-elixir' as CultivationStage) && netKarma > 0.8) {
      return HunDestinationType.Liberation
    }

    // Heaven: High virtue, low sin
    if (netKarma > 0.6 && deathEvent.sin < 0.2) {
      return HunDestinationType.Heaven
    }

    // Ghost realm: Unfinished business, strong attachments
    if (deathEvent.worldlyAttachment > 0.7 || deathEvent.bodyAttachment > 0.7) {
      return HunDestinationType.GhostRealm
    }

    // Hell: Extreme sin
    if (netKarma < -0.6) {
      return HunDestinationType.Hell
    }

    // Reincarnation: Default for most souls
    return HunDestinationType.Reincarnation
  }

  /**
   * Determine reincarnation realm based on karma
   */
  private determineReincarnationRealm(netKarma: number): ReincarnationRealm {
    if (netKarma > 0.5) {
      return ReincarnationRealm.Deva // God realm
    } else if (netKarma > 0.3) {
      return ReincarnationRealm.Asura // Demigod (powerful but flawed)
    } else if (netKarma > -0.2) {
      return ReincarnationRealm.Human // Human realm (optimal for cultivation)
    } else if (netKarma > -0.4) {
      return ReincarnationRealm.Animal // Animal realm
    } else if (netKarma > -0.6) {
      return ReincarnationRealm.HungryGhost // Hungry ghost
    } else {
      return ReincarnationRealm.Hell // Hell realm
    }
  }

  /**
   * Determine heaven level (33 levels in Buddhist cosmology)
   */
  private determineHeavenLevel(netKarma: number): number {
    // Map karma (0.6-1.0) to heaven levels (1-33)
    const normalized = (netKarma - 0.6) / 0.4 // 0-1
    return Math.floor(normalized * 32) + 1 // 1-33
  }

  /**
   * Calculate memory retention across rebirth
   */
  private calculateMemoryRetention(
    cultivationStage: CultivationStage,
    netKarma: number,
  ): number {
    // Most souls lose all memory
    let retention = 0.0

    // High cultivators retain memory
    if (cultivationStage === ('golden-elixir' as CultivationStage)) {
      retention = 1.0
    } else if (cultivationStage === ('hun-refined' as CultivationStage)) {
      retention = 0.8
    } else if (cultivationStage === ('forming-sacred-embryo' as CultivationStage)) {
      retention = 0.6
    }

    // High virtue slightly increases retention
    retention += Math.max(0, netKarma * 0.2)

    return Math.min(1.0, retention)
  }

  /**
   * Generate karmic vision
   */
  private generateKarmicVision(day: number): void {
    if (!this.state.bardo) return

    const karma = this.state.karma

    if (karma.netKarma > 0.3) {
      this.state.bardo.visions.push({
        day,
        type: 'karmic-vision',
        description: 'Visions of virtuous deeds - Experiencing joy and light',
        liberationOpportunity: false,
      })
    } else if (karma.netKarma < -0.3) {
      this.state.bardo.visions.push({
        day,
        type: 'karmic-vision',
        description: 'Visions of harmful actions - Experiencing suffering and darkness',
        liberationOpportunity: false,
      })
    } else {
      this.state.bardo.visions.push({
        day,
        type: 'karmic-vision',
        description: 'Mixed karmic visions - Both joy and suffering',
        liberationOpportunity: false,
      })
    }
  }

  /**
   * Generate rebirth opportunity
   */
  private generateRebirthOpportunity(): void {
    if (!this.state.bardo) return

    const realm = this.state.reincarnationRealm || ReincarnationRealm.Human
    const karmaMatch = 0.7 + Math.random() * 0.3

    const opportunity: RebirthOpportunity = {
      realm,
      description: this.getRealmDescription(realm),
      karmaMatch,
      accepted: false,
    }

    this.state.bardo.rebirthOpportunitiesEncountered.push(opportunity)
  }

  /**
   * Select cultivator's chosen rebirth
   */
  private selectCultivatorRebirth(): void {
    if (!this.state.bardo) return

    // Cultivators typically choose human realm for continued practice
    // Or choose to help others (bodhisattva vow)
    const chosenRealm = this.state.bodhisattvaVow
      ? ReincarnationRealm.Human
      : ReincarnationRealm.Human

    const chosenRebirth: RebirthOpportunity = {
      realm: chosenRealm,
      description: this.state.bodhisattvaVow
        ? 'Human realm - Bodhisattva vow to help all beings'
        : 'Human realm - Optimal for continued cultivation',
      karmaMatch: 1.0,
      accepted: true,
    }

    this.state.bardo.chosenRebirth = chosenRebirth
    this.state.reincarnationRealm = chosenRealm
  }

  /**
   * Select karmic rebirth (drawn by karma)
   */
  private selectKarmicRebirth(): void {
    if (!this.state.bardo || !this.state.reincarnationRealm) return

    const chosenRebirth: RebirthOpportunity = {
      realm: this.state.reincarnationRealm,
      description: `${this.getRealmDescription(this.state.reincarnationRealm)} - Drawn by karma`,
      karmaMatch: 1.0,
      accepted: true,
    }

    this.state.bardo.chosenRebirth = chosenRebirth
  }

  /**
   * Achieve liberation (beyond cycle)
   */
  private achieveLiberation(): void {
    this.state.destinationType = HunDestinationType.Liberation
    this.state.inBardo = false
    this.state.destinationReached = true
  }

  /**
   * Reach final destination
   */
  private reachDestination(): void {
    this.state.inBardo = false
    this.state.destinationReached = true
  }

  /**
   * Get realm description
   */
  private getRealmDescription(realm: ReincarnationRealm): string {
    const descriptions: Record<ReincarnationRealm, string> = {
      [ReincarnationRealm.Deva]: '天道 (Deva realm) - Celestial beings, long life, pleasure',
      [ReincarnationRealm.Asura]: '阿修羅道 (Asura realm) - Powerful demigods, prideful, warlike',
      [ReincarnationRealm.Human]:
        '人道 (Human realm) - Mixed suffering/joy, optimal for cultivation',
      [ReincarnationRealm.Animal]: '畜生道 (Animal realm) - Instinct-driven, ignorance',
      [ReincarnationRealm.HungryGhost]:
        '餓鬼道 (Hungry ghost realm) - Insatiable craving, never satisfied',
      [ReincarnationRealm.Hell]: '地獄道 (Hell realm) - Intense suffering, purification of sins',
    }

    return descriptions[realm]
  }

  /**
   * Get destination description
   */
  getDestinationDescription(): string {
    switch (this.state.destinationType) {
      case HunDestinationType.Immortality:
        return '成仙 - Achieved immortality, transcended death'
      case HunDestinationType.Liberation:
        return '解脫 - Liberated from cycle of rebirth'
      case HunDestinationType.Heaven:
        return `天界 Level ${this.state.heavenLevel} - Ascended to heavenly realm`
      case HunDestinationType.Reincarnation:
        return `輪迴 - Reborn in ${this.state.reincarnationRealm} realm`
      case HunDestinationType.GhostRealm:
        return '鬼界 - Wandering as ghost due to attachments'
      case HunDestinationType.Hell:
        return '地獄 - Temporary purification in hell realm'
      default:
        return 'Unknown destination'
    }
  }

  // Getters
  getState(): PostDeathDestinationState {
    return this.state
  }

  getDestinationType(): HunDestinationType {
    return this.state.destinationType
  }

  getReincarnationRealm(): ReincarnationRealm | null {
    return this.state.reincarnationRealm
  }

  getKarma(): KarmaState {
    return this.state.karma
  }

  isInBardo(): boolean {
    return this.state.inBardo
  }

  hasReachedDestination(): boolean {
    return this.state.destinationReached
  }

  getMemoryRetention(): number {
    return this.state.memoryRetention
  }
}
