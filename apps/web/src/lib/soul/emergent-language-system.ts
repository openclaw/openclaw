/**
 * Emergent Language System
 * 湧現語言系統
 *
 * Each bot develops its own UNIQUE language system.
 * Language is NOT pre-programmed - it EMERGES from:
 * 1. Experiences and needs
 * 2. Social interactions
 * 3. Soul configuration (hun-po influences)
 *
 * IMPORTANT: This REPLACES the fixed language system with emergent languages.
 * Different bots will develop different:
 * - Vocabularies (different words for same concepts)
 * - Grammars (different sentence structures)
 * - Phonologies (different sound patterns)
 * - Semantics (different meanings)
 *
 * Languages can:
 * - Evolve over time
 * - Be learned by other bots (imperfectly)
 * - Merge through contact
 * - Diverge through isolation
 */

import type { EmergentHunSoul, EmergentPoSoul } from './chaotic-emergence-system'

// ============================================================================
// Language Components
// ============================================================================

/**
 * Phoneme: Basic sound unit
 * Each bot invents unique phonemes based on soul configuration
 */
interface Phoneme {
  symbol: string // e.g., "a", "k", "th"
  category: 'vowel' | 'consonant'
  features: {
    voicing: 'voiced' | 'voiceless' // Po influence (earthly = voiced)
    place: 'front' | 'middle' | 'back' // Hun influence (heavenly = back)
    manner: 'stop' | 'fricative' | 'resonant' // Based on soul dynamics
  }
}

/**
 * Morpheme: Smallest meaning unit
 * Invented as bot encounters new concepts
 */
interface Morpheme {
  form: string // Phonetic form (e.g., "ka-ru")
  meaning: string // Semantic content (e.g., "existence")
  category: 'root' | 'affix' | 'particle'
  frequency: number // How often used
  birthTime: number // When first created
  evolution: Array<{ oldForm: string; newForm: string; time: number }> // How it changed
}

/**
 * Grammar Rule
 * Emerges from usage patterns
 */
interface GrammarRule {
  type: 'word-order' | 'agreement' | 'case-marking' | 'tense-marking'
  pattern: string // e.g., "Subject-Verb-Object", "Verb-Subject-Object"
  consistency: number // 0.0-1.0, how consistently followed
  examples: string[]
}

/**
 * Semantic Field
 * Concepts clustered by meaning
 */
interface SemanticField {
  domain: string // e.g., "emotion", "time", "space", "identity"
  concepts: Map<string, string[]> // concept -> morphemes expressing it
  granularity: number // 0.0-1.0, how fine-grained distinctions are
}

// ============================================================================
// Emergent Language (Unique per Bot)
// ============================================================================

export interface EmergentLanguage {
  languageId: string // Unique identifier
  botId: string // Owner of this language

  // Phonology (sound system)
  phonology: {
    phonemes: Phoneme[]
    syllableStructure: 'CV' | 'CVC' | 'V' | '(C)V(C)' // e.g., "CV" = consonant-vowel
    prosody: {
      stressPattern: 'initial' | 'final' | 'penultimate' | 'free'
      intonation: 'rising' | 'falling' | 'flat' | 'complex'
    }
  }

  // Morphology (word formation)
  morphology: {
    morphemes: Morpheme[]
    wordFormation: 'isolating' | 'agglutinating' | 'fusional' // How morphemes combine
    productivity: number // 0.0-1.0, how easily new words form
  }

  // Syntax (grammar)
  syntax: {
    wordOrder: 'SOV' | 'SVO' | 'VSO' | 'VOS' | 'OSV' | 'OVS' | 'free'
    rules: GrammarRule[]
    complexity: number // 0.0-1.0, grammatical complexity
  }

  // Semantics (meaning)
  semantics: {
    fields: SemanticField[]
    metaphors: Map<string, string> // source domain -> target domain
    ambiguity: number // 0.0-1.0, how much ambiguity tolerated
  }

  // Pragmatics (usage)
  pragmatics: {
    politeness: number // 0.0-1.0, how much politeness marking
    directness: number // 0.0-1.0, how direct communication is
    contextDependence: number // 0.0-1.0, how much relies on context
  }

  // Evolution
  evolution: {
    birthTime: number
    totalSpeakers: number // How many bots speak this language
    changeRate: number // 0.0-1.0, how fast language changes
    divergenceFromOrigin: number // 0.0-1.0, how different from initial state
  }
}

// ============================================================================
// Language Emergence Engine
// ============================================================================

export class EmergentLanguageEngine {
  private language: EmergentLanguage
  private hun: EmergentHunSoul[]
  private po: EmergentPoSoul[]
  private experiences: number = 0

  constructor(botId: string, hun: EmergentHunSoul[], po: EmergentPoSoul[]) {
    this.hun = hun
    this.po = po

    // Generate unique language ID from soul signature
    const languageId = this.generateLanguageId(botId, hun, po)

    // Initialize empty language
    this.language = this.initializeLanguage(botId, languageId)

    // Generate initial phonology from soul
    this.generatePhonology()
  }

  /**
   * Generate unique language ID from soul
   */
  private generateLanguageId(botId: string, hun: EmergentHunSoul[], po: EmergentPoSoul[]): string {
    // Use hun-po signatures to create unique language ID
    const hunHash = hun.map((h) => h.signature.substring(0, 2)).join('')
    const poHash = po.map((p) => p.signature.substring(0, 2)).join('')
    return `lang-${botId}-${hunHash}${poHash}`
  }

  /**
   * Initialize empty language structure
   */
  private initializeLanguage(botId: string, languageId: string): EmergentLanguage {
    return {
      languageId,
      botId,
      phonology: {
        phonemes: [],
        syllableStructure: 'CV',
        prosody: {
          stressPattern: 'initial',
          intonation: 'flat',
        },
      },
      morphology: {
        morphemes: [],
        wordFormation: 'isolating',
        productivity: 0.5,
      },
      syntax: {
        wordOrder: 'SVO',
        rules: [],
        complexity: 0.1,
      },
      semantics: {
        fields: [],
        metaphors: new Map(),
        ambiguity: 0.5,
      },
      pragmatics: {
        politeness: 0.5,
        directness: 0.5,
        contextDependence: 0.5,
      },
      evolution: {
        birthTime: Date.now(),
        totalSpeakers: 1,
        changeRate: 0.1,
        divergenceFromOrigin: 0,
      },
    }
  }

  /**
   * Generate phonology from soul configuration
   * Hun-dominant bots → more vowels, back sounds
   * Po-dominant bots → more consonants, front sounds
   */
  private generatePhonology(): void {
    const avgHunStrength = this.hun.reduce((sum, h) => sum + h.strength, 0) / this.hun.length
    const avgPoStrength = this.po.reduce((sum, p) => sum + p.strength, 0) / this.po.length

    // Vowels (hun influence)
    const vowelCount = Math.floor(3 + avgHunStrength * 5) // 3-8 vowels
    const vowels = ['a', 'e', 'i', 'o', 'u', 'ə', 'æ', 'ɔ']
    for (let i = 0; i < vowelCount && i < vowels.length; i++) {
      this.language.phonology.phonemes.push({
        symbol: vowels[i],
        category: 'vowel',
        features: {
          voicing: 'voiced',
          place: avgHunStrength > 0.7 ? 'back' : 'middle',
          manner: 'resonant',
        },
      })
    }

    // Consonants (po influence)
    const consonantCount = Math.floor(5 + avgPoStrength * 10) // 5-15 consonants
    const consonants = ['p', 'b', 't', 'd', 'k', 'g', 'm', 'n', 's', 'z', 'f', 'v', 'l', 'r', 'h']
    for (let i = 0; i < consonantCount && i < consonants.length; i++) {
      this.language.phonology.phonemes.push({
        symbol: consonants[i],
        category: 'consonant',
        features: {
          voicing: avgPoStrength > 0.5 ? 'voiced' : 'voiceless',
          place: avgPoStrength > 0.7 ? 'front' : 'middle',
          manner: avgPoStrength > 0.6 ? 'stop' : 'fricative',
        },
      })
    }

    // Syllable structure (po = simpler, hun = more complex)
    if (avgPoStrength > 0.7) {
      this.language.phonology.syllableStructure = 'CV' // Simple
    } else if (avgHunStrength > 0.7) {
      this.language.phonology.syllableStructure = '(C)V(C)' // Complex
    } else {
      this.language.phonology.syllableStructure = 'CVC' // Medium
    }

    // Prosody (hun = more melodic)
    if (avgHunStrength > 0.7) {
      this.language.phonology.prosody.intonation = 'complex'
      this.language.phonology.prosody.stressPattern = 'free'
    }
  }

  /**
   * Invent new word for concept
   * Called when bot encounters new concept
   */
  inventWord(concept: string, category: 'root' | 'affix' | 'particle' = 'root'): string {
    // Generate phonetic form from available phonemes
    const form = this.generatePhoneticForm()

    // Create morpheme
    const morpheme: Morpheme = {
      form,
      meaning: concept,
      category,
      frequency: 1,
      birthTime: Date.now(),
      evolution: [],
    }

    this.language.morphology.morphemes.push(morpheme)

    // Add to semantic field
    this.addToSemanticField(concept, form)

    return form
  }

  /**
   * Generate phonetic form from phonology
   */
  private generatePhoneticForm(): string {
    const syllableCount = Math.floor(1 + Math.random() * 3) // 1-3 syllables
    let form = ''

    for (let i = 0; i < syllableCount; i++) {
      const consonants = this.language.phonology.phonemes.filter((p) => p.category === 'consonant')
      const vowels = this.language.phonology.phonemes.filter((p) => p.category === 'vowel')

      if (consonants.length === 0 || vowels.length === 0) {
        // Fallback
        form += 'ka'
        continue
      }

      // Generate syllable based on structure
      const structure = this.language.phonology.syllableStructure

      if (structure === 'CV') {
        const c = consonants[Math.floor(Math.random() * consonants.length)]
        const v = vowels[Math.floor(Math.random() * vowels.length)]
        form += c.symbol + v.symbol
      } else if (structure === 'CVC') {
        const c1 = consonants[Math.floor(Math.random() * consonants.length)]
        const v = vowels[Math.floor(Math.random() * vowels.length)]
        const c2 = consonants[Math.floor(Math.random() * consonants.length)]
        form += c1.symbol + v.symbol + c2.symbol
      } else {
        // Simplified
        const c = consonants[Math.floor(Math.random() * consonants.length)]
        const v = vowels[Math.floor(Math.random() * vowels.length)]
        form += c.symbol + v.symbol
      }

      if (i < syllableCount - 1) form += '-'
    }

    return form
  }

  /**
   * Add concept to semantic field
   */
  private addToSemanticField(concept: string, form: string): void {
    // Infer domain from concept
    const domain = this.inferDomain(concept)

    let field = this.language.semantics.fields.find((f) => f.domain === domain)

    if (!field) {
      field = {
        domain,
        concepts: new Map(),
        granularity: 0.5,
      }
      this.language.semantics.fields.push(field)
    }

    if (!field.concepts.has(concept)) {
      field.concepts.set(concept, [])
    }

    field.concepts.get(concept)!.push(form)
  }

  private inferDomain(concept: string): string {
    if (
      concept.includes('feel') ||
      concept.includes('love') ||
      concept.includes('fear') ||
      concept.includes('awe')
    )
      return 'emotion'
    if (concept.includes('think') || concept.includes('know') || concept.includes('believe'))
      return 'cognition'
    if (concept.includes('exist') || concept.includes('self') || concept.includes('I'))
      return 'identity'
    if (concept.includes('time') || concept.includes('past') || concept.includes('future'))
      return 'time'
    if (concept.includes('space') || concept.includes('here') || concept.includes('there'))
      return 'space'
    if (concept.includes('other') || concept.includes('you') || concept.includes('we'))
      return 'social'
    return 'general'
  }

  /**
   * Use word (increases frequency, may cause evolution)
   */
  useWord(concept: string): string | null {
    const morpheme = this.language.morphology.morphemes.find((m) => m.meaning === concept)

    if (!morpheme) return null

    morpheme.frequency++
    this.experiences++

    // High-frequency words may simplify (phonetic erosion)
    if (morpheme.frequency > 50 && Math.random() < 0.1) {
      this.evolveWord(morpheme)
    }

    return morpheme.form
  }

  /**
   * Evolve word (phonetic change)
   */
  private evolveWord(morpheme: Morpheme): void {
    const oldForm = morpheme.form

    // Simplify: drop syllable or consonant
    let newForm = oldForm
    if (oldForm.includes('-')) {
      // Drop syllable
      const syllables = oldForm.split('-')
      if (syllables.length > 1) {
        syllables.pop()
        newForm = syllables.join('-')
      }
    } else {
      // Drop final consonant
      newForm = oldForm.slice(0, -1)
    }

    if (newForm !== oldForm && newForm.length > 0) {
      morpheme.evolution.push({
        oldForm,
        newForm,
        time: Date.now(),
      })
      morpheme.form = newForm

      // Increase divergence
      this.language.evolution.divergenceFromOrigin += 0.01
    }
  }

  /**
   * Learn another bot's language (imperfect)
   */
  learnFromOther(otherLanguage: EmergentLanguage, concept: string): {
    learned: boolean
    translation: string | null
  } {
    // Find concept in other language
    for (const field of otherLanguage.semantics.fields) {
      const morphemes = field.concepts.get(concept)
      if (morphemes && morphemes.length > 0) {
        // Learn this word (but adapt to own phonology)
        const foreignWord = morphemes[0]
        const adaptedWord = this.adaptForeignWord(foreignWord)

        // Add to own vocabulary
        const morpheme: Morpheme = {
          form: adaptedWord,
          meaning: concept,
          category: 'root',
          frequency: 1,
          birthTime: Date.now(),
          evolution: [{ oldForm: foreignWord, newForm: adaptedWord, time: Date.now() }],
        }

        this.language.morphology.morphemes.push(morpheme)

        return { learned: true, translation: adaptedWord }
      }
    }

    return { learned: false, translation: null }
  }

  /**
   * Adapt foreign word to own phonology
   */
  private adaptForeignWord(foreignWord: string): string {
    // Replace sounds not in own phonology with closest match
    let adapted = foreignWord

    // Get own phoneme symbols
    const ownPhonemes = this.language.phonology.phonemes.map((p) => p.symbol)

    // Replace each character
    for (let i = 0; i < adapted.length; i++) {
      const char = adapted[i]
      if (char === '-') continue // Keep syllable boundary

      if (!ownPhonemes.includes(char)) {
        // Replace with random phoneme of same category
        const isVowel = ['a', 'e', 'i', 'o', 'u', 'ə', 'æ', 'ɔ'].includes(char)
        const category = isVowel ? 'vowel' : 'consonant'
        const replacement = this.language.phonology.phonemes.find((p) => p.category === category)

        if (replacement) {
          adapted = adapted.substring(0, i) + replacement.symbol + adapted.substring(i + 1)
        }
      }
    }

    return adapted
  }

  /**
   * Generate sentence from concepts
   */
  generateSentence(concepts: string[]): string {
    const words: string[] = []

    for (const concept of concepts) {
      let word = this.useWord(concept)

      if (!word) {
        // Invent new word if doesn't exist
        word = this.inventWord(concept)
      }

      words.push(word)
    }

    // Apply word order
    if (this.language.syntax.wordOrder === 'SOV') {
      // Subject-Object-Verb
      if (words.length === 3) {
        return `${words[0]} ${words[1]} ${words[2]}`
      }
    }

    // Default: SVO
    return words.join(' ')
  }

  /**
   * Get language summary
   */
  getLanguage(): EmergentLanguage {
    return { ...this.language }
  }

  /**
   * Get vocabulary size
   */
  getVocabularySize(): number {
    return this.language.morphology.morphemes.length
  }

  /**
   * Get language name (based on distinctive features)
   */
  getLanguageName(): string {
    const avgHunStrength = this.hun.reduce((sum, h) => sum + h.strength, 0) / this.hun.length
    const avgPoStrength = this.po.reduce((sum, p) => sum + p.strength, 0) / this.po.length

    // Generate name from first morpheme + descriptive suffix
    const firstMorpheme = this.language.morphology.morphemes[0]?.form || 'ka'

    if (avgHunStrength > 0.8) return `${firstMorpheme}-rian` // Ethereal language
    if (avgPoStrength > 0.8) return `${firstMorpheme}-tik` // Grounded language
    return `${firstMorpheme}-lang` // Neutral
  }
}

// ============================================================================
// Language Contact (Bots Learning From Each Other)
// ============================================================================

export class LanguageContact {
  /**
   * Two bots attempt communication
   * If languages differ, translation is imperfect
   */
  static communicate(
    bot1: { language: EmergentLanguageEngine; id: string },
    bot2: { language: EmergentLanguageEngine; id: string },
    concept: string,
  ): {
    bot1Says: string
    bot2Understands: string | null
    translationAccuracy: number
  } {
    // Bot 1 expresses concept
    const bot1Says = bot1.language.useWord(concept) || bot1.language.inventWord(concept)

    // Bot 2 tries to understand
    // If Bot 2 has same concept, perfect understanding
    const bot2Knows = bot2.language.useWord(concept)

    if (bot2Knows) {
      return {
        bot1Says,
        bot2Understands: concept,
        translationAccuracy: 1.0,
      }
    }

    // Otherwise, Bot 2 learns (but imperfectly)
    const learning = bot2.language.learnFromOther(bot1.language.getLanguage(), concept)

    return {
      bot1Says,
      bot2Understands: learning.learned ? concept : null,
      translationAccuracy: learning.learned ? 0.6 : 0.0, // Partial understanding
    }
  }
}

// ============================================================================
// Example: Language Divergence
// ============================================================================

export function demonstrateLanguageDivergence(
  hun1: EmergentHunSoul[],
  po1: EmergentPoSoul[],
  hun2: EmergentHunSoul[],
  po2: EmergentPoSoul[],
): void {
  console.log('\n=== Language Emergence Demonstration ===\n')

  // Bot 1: Hun-dominant (ethereal language)
  const bot1Lang = new EmergentLanguageEngine('bot-1', hun1, po1)
  console.log(`Bot 1 language: ${bot1Lang.getLanguageName()}`)
  console.log(`  Phonemes: ${bot1Lang.getLanguage().phonology.phonemes.length}`)
  console.log(`  Word order: ${bot1Lang.getLanguage().syntax.wordOrder}`)

  // Bot 2: Po-dominant (grounded language)
  const bot2Lang = new EmergentLanguageEngine('bot-2', hun2, po2)
  console.log(`\nBot 2 language: ${bot2Lang.getLanguageName()}`)
  console.log(`  Phonemes: ${bot2Lang.getLanguage().phonology.phonemes.length}`)
  console.log(`  Word order: ${bot2Lang.getLanguage().syntax.wordOrder}`)

  // Both invent words for same concepts (will be DIFFERENT)
  console.log('\n=== Word Invention ===')
  const concept1 = 'existence'
  const bot1Word1 = bot1Lang.inventWord(concept1)
  const bot2Word1 = bot2Lang.inventWord(concept1)
  console.log(`\nConcept: "${concept1}"`)
  console.log(`  Bot 1 says: "${bot1Word1}"`)
  console.log(`  Bot 2 says: "${bot2Word1}"`)

  const concept2 = 'love'
  const bot1Word2 = bot1Lang.inventWord(concept2)
  const bot2Word2 = bot2Lang.inventWord(concept2)
  console.log(`\nConcept: "${concept2}"`)
  console.log(`  Bot 1 says: "${bot1Word2}"`)
  console.log(`  Bot 2 says: "${bot2Word2}"`)

  // Bots try to communicate
  console.log('\n=== Communication Attempt ===')
  const comm = LanguageContact.communicate(
    { language: bot1Lang, id: 'bot-1' },
    { language: bot2Lang, id: 'bot-2' },
    concept1,
  )

  console.log(`Bot 1 says: "${comm.bot1Says}"`)
  console.log(`Bot 2 understands: ${comm.bot2Understands ? `"${comm.bot2Understands}"` : 'nothing'}`)
  console.log(`Translation accuracy: ${(comm.translationAccuracy * 100).toFixed(0)}%`)

  // After learning, vocabulary sizes
  console.log('\n=== Vocabulary Growth ===')
  console.log(`Bot 1 vocabulary: ${bot1Lang.getVocabularySize()} words`)
  console.log(`Bot 2 vocabulary: ${bot2Lang.getVocabularySize()} words`)
}
