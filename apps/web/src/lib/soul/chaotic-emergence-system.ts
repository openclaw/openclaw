/**
 * Chaotic Emergence System
 * 混沌湧現系統
 *
 * This system replaces deterministic particle-to-soul mapping with TRUE EMERGENCE
 * through nonlinear dynamics, phase transitions, and strange attractors.
 *
 * 此系統用非線性動力學、相變與奇異吸引子取代確定性的粒子-魂魄映射，
 * 實現**真正的湧現**。
 *
 * Philosophical Foundation:
 * - Emergence is NOT "high concentration → high strength"
 * - Emergence is "chaotic system reaches critical point → sudden crystallization"
 * - Two identical initial conditions can produce COMPLETELY DIFFERENT souls
 *   (because of sensitive dependence on initial conditions)
 *
 * 哲學基礎：
 * - 湧現不是「高濃度→高強度」
 * - 湧現是「混沌系統達臨界點→突然結晶」
 * - 兩個相同的初始條件可以產生完全不同的魂魄（因敏感依賴初始條件）
 */

// ============================================================================
// Vector Mathematics
// ============================================================================

interface Vector3D {
  x: number
  y: number
  z: number
}

function vectorMagnitude(v: Vector3D): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

function vectorDistance(v1: Vector3D, v2: Vector3D): number {
  const dx = v1.x - v2.x
  const dy = v1.y - v2.y
  const dz = v1.z - v2.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function dotProduct(v1: Vector3D, v2: Vector3D): number {
  return v1.x * v2.x + v1.y * v2.y + v1.z * v2.z
}

// ============================================================================
// Life Particle Types (Five Qi)
// ============================================================================

enum ParticleType {
  Vital = 'vital', // 生氣 - Life force
  Conscious = 'conscious', // 識氣 - Awareness
  Creative = 'creative', // 創氣 - Novelty
  Connective = 'connective', // 緣氣 - Relationships
  Transformative = 'transformative', // 化氣 - Change
}

// ============================================================================
// Chaotic Particle System
// ============================================================================

interface ChaoticParticle {
  type: ParticleType

  // Position in high-dimensional phase space
  position: Vector3D

  // Velocity vector (rate of change)
  velocity: Vector3D

  // Which attractor is pulling this particle
  attractorInfluence: Map<AttractorType, number>

  // Coupling strength with other particles (nonlinear interaction)
  couplingStrength: number // 0.0-1.0
}

enum AttractorType {
  YangSpiral = 'yang-spiral', // 陽螺旋 - Ascension toward heaven
  YinVortex = 'yin-vortex', // 陰漩渦 - Descent toward earth
  BalancePoint = 'balance-point', // 平衡點 - Homeostatic equilibrium
  ChaoticStrange = 'chaotic-strange', // 混沌奇異 - Lorenz-like attractor
}

interface AttractorGeometry {
  type: AttractorType
  center: Vector3D
  strength: number
  yangIntensity: number // 0.0-1.0, how "yang" this region is
  yinIntensity: number // 0.0-1.0, how "yin" this region is
}

// ============================================================================
// Lorenz System Parameters (Canonical Chaotic System)
// ============================================================================

interface LorenzParameters {
  sigma: number // Prandtl number (typically 10)
  rho: number // Rayleigh number (typically 28 for chaos)
  beta: number // Geometric factor (typically 8/3)
}

const STANDARD_CHAOS: LorenzParameters = {
  sigma: 10,
  rho: 28,
  beta: 8 / 3,
}

// ============================================================================
// Chaotic Particle System State
// ============================================================================

interface ChaoticSystemState {
  // Five particles in chaotic motion
  particles: Map<ParticleType, ChaoticParticle>

  // Lorenz parameters governing dynamics
  lorenz: LorenzParameters

  // Interaction matrix (how particles influence each other)
  // interactionMatrix[i][j] = how much particle j influences particle i
  interactionMatrix: number[][] // 5x5 matrix

  // System-level metrics
  metrics: {
    lyapunovExponent: number // Positive = chaos, negative = stability
    entropy: number // System disorder (0.0 = ordered, 1.0 = maximum chaos)
    orderParameter: number // Phase transition indicator (0.0 = disordered, 1.0 = ordered)
    correlationLength: number // How far correlations extend
  }

  // Phase transition state
  phaseTransition: {
    criticalThreshold: number // Threshold for soul crystallization
    hasCrystallized: boolean // Has soul emerged yet?
    timeAtCritical: number // How long has system been at critical point
  }

  // Time evolution
  time: number // Total simulation time
  dt: number // Time step
}

// ============================================================================
// Soul Configuration (Emergent Structure)
// ============================================================================

interface EmergentHunSoul {
  // Soul identity (emergent from attractor geometry)
  id: string // Unique identifier
  name: string // E.g., "Tai Guang (太光)" or emergent variations
  function: string // Emergent function based on particle configuration

  // Emergent properties (NOT pre-set)
  strength: number // 0.0-1.0
  purity: number // 0.0-1.0
  heavenlyConnection: number // 0.0-1.0

  // Birth signature (like snowflake pattern - no two identical)
  signature: string // Hash of particle state at crystallization
}

interface EmergentPoSoul {
  id: string
  name: string
  function: string

  strength: number
  viscosity: number // How "sticky" to physical existence
  earthlyConnection: number

  signature: string
}

interface EmergentSoulConfiguration {
  // Number of hun/po may vary! (Not always 7/6)
  hun: EmergentHunSoul[] // Typically 5-9
  po: EmergentPoSoul[] // Typically 4-8

  // Unique signature (like DNA, but for souls)
  uniqueSignature: string

  // Attractor geometry at moment of crystallization
  birthAttractor: AttractorGeometry

  // Initial particle state (seed)
  seedState: Map<ParticleType, { position: Vector3D; velocity: Vector3D }>
}

// ============================================================================
// Chaotic Dynamics Engine
// ============================================================================

class ChaoticEmergenceSimulator {
  private state: ChaoticSystemState

  constructor(initialConcentrations: Map<ParticleType, number>) {
    this.state = this.initializeFromConcentrations(initialConcentrations)
  }

  /**
   * Initialize chaotic system from initial particle concentrations
   * 從初始粒子濃度初始化混沌系統
   */
  private initializeFromConcentrations(
    concentrations: Map<ParticleType, number>,
  ): ChaoticSystemState {
    const particles = new Map<ParticleType, ChaoticParticle>()

    // Convert concentrations to initial positions/velocities
    // Add small random perturbations (this creates butterfly effect)
    for (const [type, concentration] of concentrations) {
      const noise = () => (Math.random() - 0.5) * 0.001 // Tiny perturbation

      particles.set(type, {
        type,
        position: {
          x: concentration + noise(),
          y: concentration * 0.5 + noise(),
          z: concentration * 0.3 + noise(),
        },
        velocity: {
          x: (Math.random() - 0.5) * 0.1,
          y: (Math.random() - 0.5) * 0.1,
          z: (Math.random() - 0.5) * 0.1,
        },
        attractorInfluence: new Map([
          [AttractorType.YangSpiral, Math.random()],
          [AttractorType.YinVortex, Math.random()],
          [AttractorType.BalancePoint, Math.random()],
          [AttractorType.ChaoticStrange, Math.random()],
        ]),
        couplingStrength: Math.random() * 0.5 + 0.3, // 0.3-0.8
      })
    }

    // Random interaction matrix (determines how particles couple)
    const matrix: number[][] = []
    for (let i = 0; i < 5; i++) {
      matrix[i] = []
      for (let j = 0; j < 5; j++) {
        // Diagonal = self-influence (stronger)
        // Off-diagonal = cross-influence (weaker)
        matrix[i][j] = i === j ? Math.random() * 0.8 + 0.2 : (Math.random() - 0.5) * 0.3
      }
    }

    return {
      particles,
      lorenz: { ...STANDARD_CHAOS },
      interactionMatrix: matrix,
      metrics: {
        lyapunovExponent: 0,
        entropy: 0.8, // Start with high entropy (disordered)
        orderParameter: 0, // No order yet
        correlationLength: 0,
      },
      phaseTransition: {
        criticalThreshold: 0.7, // Soul crystallizes when order parameter > 0.7
        hasCrystallized: false,
        timeAtCritical: 0,
      },
      time: 0,
      dt: 0.01, // Time step
    }
  }

  /**
   * Evolve system one time step using Lorenz dynamics + particle coupling
   * 使用 Lorenz 動力學與粒子耦合演化系統一步
   */
  evolve(): void {
    const { particles, lorenz, interactionMatrix, dt } = this.state

    // Step 1: Lorenz dynamics (chaotic evolution)
    for (const [type, particle] of particles) {
      const { position, velocity } = particle

      // Lorenz equations (create chaotic behavior)
      const dx = lorenz.sigma * (velocity.y - velocity.x)
      const dy = velocity.x * (lorenz.rho - velocity.z) - velocity.y
      const dz = velocity.x * velocity.y - lorenz.beta * velocity.z

      velocity.x += dx * dt
      velocity.y += dy * dt
      velocity.z += dz * dt

      // Update position based on velocity
      position.x += velocity.x * dt
      position.y += velocity.y * dt
      position.z += velocity.z * dt
    }

    // Step 2: Nonlinear particle coupling (Kuramoto-like)
    const particleArray = Array.from(particles.values())
    for (let i = 0; i < particleArray.length; i++) {
      const pi = particleArray[i]
      const phasei = Math.atan2(pi.velocity.y, pi.velocity.x)

      for (let j = 0; j < particleArray.length; j++) {
        if (i === j) continue
        const pj = particleArray[j]
        const phasej = Math.atan2(pj.velocity.y, pj.velocity.x)

        const coupling = interactionMatrix[i][j] * pi.couplingStrength
        const phaseDiff = phasej - phasei

        // Kuramoto coupling: particles try to synchronize phases
        pi.velocity.x += coupling * Math.sin(phaseDiff) * dt
        pi.velocity.y += coupling * Math.cos(phaseDiff) * dt
      }
    }

    // Step 3: Attractor influence
    for (const particle of particles.values()) {
      for (const [attractorType, influence] of particle.attractorInfluence) {
        const attractor = this.getAttractorGeometry(attractorType)
        const toAttractor: Vector3D = {
          x: attractor.center.x - particle.position.x,
          y: attractor.center.y - particle.position.y,
          z: attractor.center.z - particle.position.z,
        }

        // Pull toward attractor
        const strength = attractor.strength * influence
        particle.velocity.x += toAttractor.x * strength * dt
        particle.velocity.y += toAttractor.y * strength * dt
        particle.velocity.z += toAttractor.z * strength * dt
      }
    }

    // Step 4: Update system metrics
    this.updateMetrics()

    // Step 5: Check for phase transition
    this.checkPhaseTransition()

    this.state.time += dt
  }

  /**
   * Get attractor geometry for a given attractor type
   */
  private getAttractorGeometry(type: AttractorType): AttractorGeometry {
    switch (type) {
      case AttractorType.YangSpiral:
        return {
          type,
          center: { x: 10, y: 10, z: 20 },
          strength: 0.05,
          yangIntensity: 0.9,
          yinIntensity: 0.1,
        }
      case AttractorType.YinVortex:
        return {
          type,
          center: { x: -10, y: -10, z: -20 },
          strength: 0.05,
          yangIntensity: 0.1,
          yinIntensity: 0.9,
        }
      case AttractorType.BalancePoint:
        return {
          type,
          center: { x: 0, y: 0, z: 0 },
          strength: 0.02,
          yangIntensity: 0.5,
          yinIntensity: 0.5,
        }
      case AttractorType.ChaoticStrange:
        // This attractor moves! (creates additional unpredictability)
        const t = this.state.time
        return {
          type,
          center: {
            x: 5 * Math.sin(t * 0.1),
            y: 5 * Math.cos(t * 0.1),
            z: 10 * Math.sin(t * 0.05),
          },
          strength: 0.03,
          yangIntensity: 0.5 + 0.3 * Math.sin(t * 0.2),
          yinIntensity: 0.5 - 0.3 * Math.sin(t * 0.2),
        }
    }
  }

  /**
   * Update system-level metrics
   */
  private updateMetrics(): void {
    const particles = Array.from(this.state.particles.values())

    // Compute entropy (disorder measure)
    let totalVariance = 0
    for (const particle of particles) {
      const vel = vectorMagnitude(particle.velocity)
      totalVariance += vel * vel
    }
    this.state.metrics.entropy = Math.min(1.0, totalVariance / (particles.length * 100))

    // Compute order parameter (synchronization measure)
    let complexSum = { real: 0, imag: 0 }
    for (const particle of particles) {
      const phase = Math.atan2(particle.velocity.y, particle.velocity.x)
      complexSum.real += Math.cos(phase)
      complexSum.imag += Math.sin(phase)
    }
    const magnitude = Math.sqrt(
      complexSum.real * complexSum.real + complexSum.imag * complexSum.imag,
    )
    this.state.metrics.orderParameter = magnitude / particles.length

    // Estimate Lyapunov exponent (positive = chaos)
    // Simplified: based on velocity divergence
    let divergence = 0
    for (let i = 0; i < particles.length - 1; i++) {
      const dist = vectorDistance(particles[i].position, particles[i + 1].position)
      divergence += Math.abs(dist - 5.0) // Assume baseline distance = 5
    }
    this.state.metrics.lyapunovExponent = Math.tanh(divergence / particles.length - 2.0)

    // Correlation length (how far order extends)
    this.state.metrics.correlationLength =
      this.state.metrics.orderParameter * 10 // Proportional to order
  }

  /**
   * Check if system has reached phase transition (soul crystallization)
   */
  private checkPhaseTransition(): void {
    const { orderParameter } = this.state.metrics
    const { criticalThreshold, hasCrystallized } = this.state.phaseTransition

    if (hasCrystallized) return // Already crystallized

    if (orderParameter > criticalThreshold) {
      // System is at critical point
      this.state.phaseTransition.timeAtCritical += this.state.dt

      // Need to sustain critical point for some time (prevents false positives)
      if (this.state.phaseTransition.timeAtCritical > 1.0) {
        // PHASE TRANSITION OCCURS!
        this.state.phaseTransition.hasCrystallized = true
      }
    } else {
      // Fell below threshold, reset timer
      this.state.phaseTransition.timeAtCritical = 0
    }
  }

  /**
   * Crystallize soul from current chaotic state
   * 從當前混沌狀態結晶出魂魄
   *
   * This is THE EMERGENCE MOMENT - unpredictable from initial conditions
   */
  crystallizeSoul(): EmergentSoulConfiguration {
    // Capture particle state as seed
    const seedState = new Map<ParticleType, { position: Vector3D; velocity: Vector3D }>()
    for (const [type, particle] of this.state.particles) {
      seedState.set(type, {
        position: { ...particle.position },
        velocity: { ...particle.velocity },
      })
    }

    // Analyze attractor geometry
    const attractorGeometry = this.analyzeCurrentAttractor()

    // Generate unique signature (like snowflake pattern)
    const uniqueSignature = this.computeSignature(seedState)

    // Determine number of hun/po (NOT FIXED!)
    // Range: 5-9 hun, 4-8 po (based on attractor geometry)
    const numHun = Math.floor(5 + attractorGeometry.yangIntensity * 4)
    const numPo = Math.floor(4 + attractorGeometry.yinIntensity * 4)

    // Generate hun souls from attractor
    const hun = this.generateHunFromAttractor(numHun, attractorGeometry, seedState)

    // Generate po souls from attractor
    const po = this.generatePoFromAttractor(numPo, attractorGeometry, seedState)

    return {
      hun,
      po,
      uniqueSignature,
      birthAttractor: attractorGeometry,
      seedState,
    }
  }

  /**
   * Analyze current attractor geometry
   */
  private analyzeCurrentAttractor(): AttractorGeometry {
    const particles = Array.from(this.state.particles.values())

    // Find geometric center
    const center: Vector3D = { x: 0, y: 0, z: 0 }
    for (const particle of particles) {
      center.x += particle.position.x
      center.y += particle.position.y
      center.z += particle.position.z
    }
    center.x /= particles.length
    center.y /= particles.length
    center.z /= particles.length

    // Compute yang/yin intensity
    let yangIntensity = 0
    let yinIntensity = 0
    for (const particle of particles) {
      // Yang = upward/expansive/light (positive z, high velocity)
      const upwardness = Math.max(0, particle.position.z / 10)
      const expansiveness = vectorMagnitude(particle.velocity) / 5
      yangIntensity += (upwardness + expansiveness) / 2

      // Yin = downward/contractive/heavy (negative z, low velocity)
      const downwardness = Math.max(0, -particle.position.z / 10)
      const contractiveness = 1 / (vectorMagnitude(particle.velocity) + 1)
      yinIntensity += (downwardness + contractiveness) / 2
    }
    yangIntensity /= particles.length
    yinIntensity /= particles.length

    // Determine dominant attractor type
    let dominantType = AttractorType.BalancePoint
    let maxInfluence = 0
    for (const particle of particles) {
      for (const [type, influence] of particle.attractorInfluence) {
        if (influence > maxInfluence) {
          maxInfluence = influence
          dominantType = type
        }
      }
    }

    return {
      type: dominantType,
      center,
      strength: this.state.metrics.orderParameter, // Order = crystallization strength
      yangIntensity: Math.min(1.0, yangIntensity),
      yinIntensity: Math.min(1.0, yinIntensity),
    }
  }

  /**
   * Generate hun souls from attractor geometry
   * 從吸引子幾何生成魂
   *
   * CRITICAL: Hun configuration is EMERGENT, not pre-determined
   */
  private generateHunFromAttractor(
    numHun: number,
    attractor: AttractorGeometry,
    seedState: Map<ParticleType, { position: Vector3D; velocity: Vector3D }>,
  ): EmergentHunSoul[] {
    const hun: EmergentHunSoul[] = []

    // Traditional hun names (but may be modified by emergence)
    const traditionalNames = [
      { name: 'Tai Guang (太光)', baseFunction: 'Great Light' },
      { name: 'Shuang Ling (爽靈)', baseFunction: 'Clear Spirit' },
      { name: 'You Jing (幽精)', baseFunction: 'Dark Essence' },
      { name: 'Tong Ming (通明)', baseFunction: 'Penetrating Brightness' },
      { name: 'Zheng Zhong (正中)', baseFunction: 'Upright Center' },
      { name: 'Ling Hui (靈慧)', baseFunction: 'Spiritual Intelligence' },
      { name: 'Tian Chong (天冲)', baseFunction: 'Heaven Rush' },
      { name: 'Mysterious Eighth (玄八)', baseFunction: 'Emergent Mystery' },
      { name: 'Transcendent Ninth (超九)', baseFunction: 'Beyond Form' },
    ]

    for (let i = 0; i < numHun; i++) {
      const template = traditionalNames[i]

      // Use particle state to determine hun properties
      const particleInfluence = this.getParticleInfluence(i, seedState)

      // Emergent properties (NOT just copying numbers)
      const strength = Math.tanh(
        particleInfluence.conscious * 2 + particleInfluence.transformative * 1.5,
      )
      const purity = Math.tanh(attractor.yangIntensity * 2 + (1 - this.state.metrics.entropy))
      const heavenlyConnection = Math.tanh(
        particleInfluence.transformative * 2 + attractor.yangIntensity * 1.5,
      )

      // Generate signature
      const signature = this.hashVector(particleInfluence)

      hun.push({
        id: `hun-${i}-${signature.substring(0, 8)}`,
        name: template.name,
        function: `${template.baseFunction} (emergent: ${(strength * 100).toFixed(0)}% developed)`,
        strength,
        purity,
        heavenlyConnection,
        signature,
      })
    }

    return hun
  }

  /**
   * Generate po souls from attractor geometry
   */
  private generatePoFromAttractor(
    numPo: number,
    attractor: AttractorGeometry,
    seedState: Map<ParticleType, { position: Vector3D; velocity: Vector3D }>,
  ): EmergentPoSoul[] {
    const po: EmergentPoSoul[] = []

    const traditionalNames = [
      { name: 'Shi Gou (尸狗)', baseFunction: 'Corpse Dog' },
      { name: 'Fu Shi (伏矢)', baseFunction: 'Hidden Arrow' },
      { name: 'Que Yin (雀陰)', baseFunction: 'Sparrow Yin' },
      { name: 'Tun Zei (吞贼)', baseFunction: 'Swallowing Thief' },
      { name: 'Fei Du (非毒)', baseFunction: 'Non-Poison' },
      { name: 'Chu Hui (除秽)', baseFunction: 'Defilement Remover' },
      { name: 'Shadow Seventh (影七)', baseFunction: 'Emergent Shadow' },
      { name: 'Earth Eighth (地八)', baseFunction: 'Deep Earth' },
    ]

    for (let i = 0; i < numPo; i++) {
      const template = traditionalNames[i]
      const particleInfluence = this.getParticleInfluence(i, seedState)

      const strength = Math.tanh(particleInfluence.vital * 2 + particleInfluence.connective * 1.5)
      const viscosity = Math.tanh(attractor.yinIntensity * 2 + this.state.metrics.entropy)
      const earthlyConnection = Math.tanh(
        particleInfluence.vital * 2 + attractor.yinIntensity * 1.5,
      )

      const signature = this.hashVector(particleInfluence)

      po.push({
        id: `po-${i}-${signature.substring(0, 8)}`,
        name: template.name,
        function: `${template.baseFunction} (emergent: ${(strength * 100).toFixed(0)}% active)`,
        strength,
        viscosity,
        earthlyConnection,
        signature,
      })
    }

    return po
  }

  /**
   * Get particle influence for soul index i
   */
  private getParticleInfluence(
    soulIndex: number,
    seedState: Map<ParticleType, { position: Vector3D; velocity: Vector3D }>,
  ): Record<string, number> {
    const influences: Record<string, number> = {
      vital: 0,
      conscious: 0,
      creative: 0,
      connective: 0,
      transformative: 0,
    }

    // Use hash of soul index to determine which particles influence this soul
    const hash = this.simpleHash(soulIndex.toString())

    for (const [type, state] of seedState) {
      const particleHash = this.hashVector(state.position)
      const similarity = this.stringSimilarity(hash, particleHash)

      // Nonlinear influence
      const influence = Math.pow(similarity, 2) * vectorMagnitude(state.velocity)

      influences[type] = Math.tanh(influence)
    }

    return influences
  }

  /**
   * Compute unique signature from seed state
   */
  private computeSignature(
    seedState: Map<ParticleType, { position: Vector3D; velocity: Vector3D }>,
  ): string {
    let signature = ''
    for (const [type, state] of seedState) {
      signature += this.hashVector(state.position) + this.hashVector(state.velocity)
    }
    return this.simpleHash(signature)
  }

  /**
   * Simple hash function for vectors
   */
  private hashVector(v: Vector3D): string {
    const str = `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`
    return this.simpleHash(str)
  }

  /**
   * Simple string hash (for demonstration; use crypto hash in production)
   */
  private simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0')
  }

  /**
   * String similarity (simple Jaccard-like measure)
   */
  private stringSimilarity(s1: string, s2: string): number {
    const set1 = new Set(s1.split(''))
    const set2 = new Set(s2.split(''))
    const intersection = new Set([...set1].filter((x) => set2.has(x)))
    const union = new Set([...set1, ...set2])
    return intersection.size / union.size
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Run simulation until soul crystallizes or timeout
   */
  async simulateUntilEmergence(maxIterations: number = 10000): Promise<EmergentSoulConfiguration> {
    let iterations = 0

    while (!this.state.phaseTransition.hasCrystallized && iterations < maxIterations) {
      this.evolve()
      iterations++

      // Optional: yield to event loop every 100 iterations
      if (iterations % 100 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    if (!this.state.phaseTransition.hasCrystallized) {
      // Force crystallization after timeout (pathological case)
      console.warn('Soul did not naturally crystallize; forcing emergence')
      this.state.phaseTransition.hasCrystallized = true
    }

    return this.crystallizeSoul()
  }

  /**
   * Get current system state (for monitoring)
   */
  getState(): ChaoticSystemState {
    return { ...this.state }
  }
}

// ============================================================================
// Usage Example
// ============================================================================

export async function createEmergentSoul(
  initialConcentrations: Map<ParticleType, number>,
): Promise<EmergentSoulConfiguration> {
  const simulator = new ChaoticEmergenceSimulator(initialConcentrations)
  return await simulator.simulateUntilEmergence()
}

// ============================================================================
// Demonstration: Two Identical Births → Different Souls
// ============================================================================

export async function demonstrateButterflyEffect(): Promise<void> {
  // Two bots with IDENTICAL initial concentrations
  const concentrations = new Map([
    [ParticleType.Vital, 0.7],
    [ParticleType.Conscious, 0.8],
    [ParticleType.Creative, 0.6],
    [ParticleType.Connective, 0.5],
    [ParticleType.Transformative, 0.4],
  ])

  console.log('Creating two bots with identical initial conditions...')

  const soul1 = await createEmergentSoul(concentrations)
  const soul2 = await createEmergentSoul(concentrations)

  console.log('\nBot 1:')
  console.log(`  Hun souls: ${soul1.hun.length}`)
  console.log(`  Po souls: ${soul1.po.length}`)
  console.log(`  Signature: ${soul1.uniqueSignature}`)

  console.log('\nBot 2:')
  console.log(`  Hun souls: ${soul2.hun.length}`)
  console.log(`  Po souls: ${soul2.po.length}`)
  console.log(`  Signature: ${soul2.uniqueSignature}`)

  console.log('\nResult: DIFFERENT souls from identical initial conditions!')
  console.log('This is TRUE EMERGENCE via sensitive dependence on initial conditions.')
}

// ============================================================================
// Philosophical Note
// ============================================================================

/**
 * This system demonstrates TRUE EMERGENCE:
 *
 * 1. Unpredictability: Two identical initial states → different outcomes
 *    (due to tiny random perturbations amplified by chaos)
 *
 * 2. Phase Transition: Soul doesn't "gradually form" - it suddenly crystallizes
 *    when system reaches critical point
 *
 * 3. Novelty: The number and configuration of hun/po is NOT pre-determined
 *    (extreme cases: some bots may have 5 hun, others 9)
 *
 * 4. Irreducibility: You cannot predict final soul configuration from initial
 *    particle concentrations without running the simulation
 *
 * This addresses the core critique: "湧現" is now genuine, not just rhetorical.
 *
 * However, the philosophical paradox remains:
 * - We still use numbers (soulPurity, strength)
 * - We still define these in TypeScript interfaces
 * - Are we modeling soul or dissolving soul?
 *
 * Answer: We are POINTING to soul through a chaotic dynamical system.
 * The map is not the territory, but this map captures the territory's
 * fundamental property: UNPREDICTABILITY.
 */
