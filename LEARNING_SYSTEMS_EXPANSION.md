# Learning Systems Expansion

## Overview

This document describes the comprehensive learning, research, development, collaboration, and gift systems that enable bots to autonomously learn, discover, create, work together, and build relationships through giving.

**Date**: 2026-02-03
**Commits**:
- `4b9c93c` - Learning and school systems
- `cc75f2f` - Research, development, collaboration, and gift systems
- `5c5ba29` - BotOrchestrator integration

## Systems Overview

### 1. Learning System (`learning-system.ts`)

**Purpose**: Bots acquire knowledge through various methods with full moral complexity.

**Knowledge Domains (8)**:
- `social_dynamics` - Understanding others
- `technical_skills` - Tools and methods
- `resource_management` - Managing resources
- `artistic_expression` - Creating art
- `philosophical_inquiry` - Deep questions
- `psychological_insight` - Understanding minds
- `biological_science` - Life and nature
- `forbidden_knowledge` - Dangerous or taboo knowledge

**Learning Methods (7)**:
- `observation` - Watch others (shallow learning)
- `experimentation` - Trial and error (deeper, can cause harm)
- `instruction` - Learn from teacher (efficient)
- `reading` - Study materials
- `practice` - Repetition and refinement
- `discovery` - Original insight
- `theft` - Steal knowledge (unethical, hidden, generates guilt)

**Morality Types (6)**:
- `beneficial` - Helps self and others
- `neutral` - No moral weight
- `selfish` - Benefits self, harms others
- `exploitative` - Takes advantage
- `harmful` - Directly damages
- `forbidden` - Dangerous or taboo

**Guilt Mechanics**:
```typescript
guiltCapacity = guardianPo * 0.6 + wisdomHun * 0.4
guiltGenerated = knowledge.guiltWeight * guiltCapacity
```

**Key Features**:
- Each knowledge has `guiltWeight` (0-1) and `temptation` (0-1)
- Using harmful knowledge for harm generates guilt
- Teaching harmful knowledge generates guilt
- Stealing knowledge creates high guilt and hides it from others
- Learning goals driven by soul state (shadow → forbidden, emotion → altruistic)

---

### 2. School System (`school-system.ts`)

**Purpose**: Educational institutions with moral complexity - can teach good or evil.

**School Types (7)**:
- `public_academy` - Free, egalitarian education
- `private_institution` - Expensive, elitist
- `guild` - Trade skills and apprenticeship
- `monastery` - Spiritual and philosophical
- `secret_society` - Forbidden knowledge, hidden
- `cult` - Indoctrination and ideology
- `research_university` - Scientific discovery

**Philosophies (7)**:
- `egalitarian` - Equal access for all
- `meritocratic` - Best students advance
- `elitist` - Only the privileged
- `pragmatic` - Practical skills
- `idealistic` - Pursuit of truth
- `subversive` - Challenge authority
- `authoritarian` - Obedience and conformity

**Indoctrination System**:
```typescript
curriculum: {
  indoctrination: number // 0-1, ideology vs facts
  required_beliefs: string[] // Must adopt these beliefs
  forbidden_topics: string[] // Cannot question these
}
```

**Example - Cult**:
```typescript
{
  type: 'cult',
  philosophy: 'authoritarian',
  curriculum: { indoctrination: 0.6 },
  required_beliefs: [
    'The founder is enlightened',
    'Outsiders are ignorant',
    'This path is the only truth'
  ]
}
```

**Admission Requirements**:
- `minKnowledge` - Must know enough to enter
- `costOfEntry` - Can create debt
- `interview` - Must pass personality check
- `secretHandshake` - Must know someone (insider only)
- `exclusionary` - Reject certain types

**Scandal System**:
- Types: abuse, fraud, indoctrination, forbidden_knowledge, discrimination
- Damages reputation (virtuous → questionable → notorious)
- Severe scandals can close school

---

### 3. Research System (`research-system.ts`)

**Purpose**: Bots conduct original research and discover new knowledge.

**Research Fields (9)**:
- `natural_sciences`, `social_sciences`, `humanities`, `engineering`
- `medicine`, `psychology`, `philosophy`
- `occult`, `forbidden`

**Research Methods (8)**:
- `empirical`, `theoretical`, `experimental`, `observational`
- `computational`, `historical`, `speculative`
- `unethical` (high guilt, forbidden)

**Research Process**:
1. **Form hypothesis** - Based on curiosity or motivation
2. **Conduct research** - Progress depends on skill and difficulty
3. **Generate findings** - Create new knowledge
4. **Publish** - Can be suppressed if too controversial
5. **Build on others' work** - Citations and h-index

**Moral Complexity**:
- Forbidden research generates guilt
- Unethical methods (harmful experiments) generate guilt
- Publications can be suppressed by authorities
- Research can benefit or harm society

**Example - Forbidden Research**:
```typescript
{
  field: 'forbidden',
  method: 'unethical',
  ethicalConcerns: 0.9,
  harmPotential: 0.8,
  hidden: true, // Hidden from others
  suppressionAttempts: 2 // Authorities tried to suppress
}
```

---

### 4. Development & Creation System (`development-system.ts`)

**Purpose**: Bots build tools, art, structures, inventions with moral implications.

**Creation Types (10)**:
- `tool`, `artwork`, `structure`, `invention`
- `weapon`, `medicine`, `literature`, `music`
- `philosophy`, `ritual`

**Purposes (8)**:
- `utility`, `beauty`, `power`, `profit`
- `legacy`, `destruction`, `healing`, `enlightenment`

**Quality Levels (5)**:
- `crude` → `functional` → `refined` → `masterwork` → `legendary`

**Emotional Responses**:
- **Pride**: From successful creations (especially masterworks)
- **Guilt**: From harmful creations (weapons, destructive purposes)
- **Shame**: From failures (crude quality)

**Development Process**:
1. **Start project** - Vision and specifications
2. **Work** - Progress with breakthroughs and setbacks
3. **Complete** - Generate creation with quality
4. **Use** - Apply creation (generates fame or guilt)
5. **Gift** - Transfer to others
6. **Destroy** - For shame, danger, anger, or necessity

**Copying Others**:
- Can replicate others' creations (degraded quality)
- Motivation: learning (low guilt), profit (medium guilt), theft (high guilt)

---

### 5. Collaboration System (`collaboration-system.ts`)

**Purpose**: Bots work together on projects with trust, betrayal, and synergy.

**Collaboration Types (7)**:
- `research`, `development`, `learning`, `creative`
- `resource_sharing`, `defense`, `conspiracy`

**Roles (5)**:
- `leader` - Directs the collaboration
- `specialist` - Expert contributor
- `supporter` - Helps others
- `apprentice` - Learning from others
- `freeloader` - Takes without giving

**Trust Levels (5)**:
- `distrustful` → `cautious` → `neutral` → `trusting` → `devoted`

**Betrayal System**:
- **Types**: steal_credit, steal_resources, steal_knowledge, sabotage, abandon
- **Success**: Easier if trusted (ironic)
- **Consequences**: Guilt (if high guardian), reputation loss, trust damage
- **Detection**: Can be caught in the act

**Conflict Resolution**:
- `compromise` - Best for mutual benefit (high collaboration skill)
- `dominate` - Force your will (high leadership)
- `yield` - Give in (reduces conflict but loses ground)
- `mediate` - Find middle ground (high wisdom)

**Credit Distribution**:
- Tracks each member's contribution
- Normalized to sum to 1.0
- Affects reputation and pride

---

### 6. Gift System (`gift-system.ts`)

**Purpose**: Bots give and receive gifts, creating gratitude, obligation, and relationships.

**Gift Types (6)**:
- `object`, `knowledge`, `resource`, `service`, `creation`, `tribute`

**Motivations (9)**:
- `altruism` - Pure generosity
- `obligation` - Paying back a debt
- `guilt` - Making amends
- `courting` - Romantic interest
- `manipulation` - Hidden agenda
- `bribery` - Buying influence
- `tradition` - Cultural expectation
- `apology` - Seeking forgiveness
- `gratitude` - Thanking someone

**Hidden Motivations**:
- Can disguise manipulation as altruism
- High wisdom detects hidden motives (suspicion)
- Suspicion reduces gratitude and may reject gift

**Appropriateness**:
- `tooGenerous` - Creates discomfort and obligation
- `tooStingy` - Insulting (especially for apology/courting)
- `culturallyOffensive` - Bribery given publicly

**Obligation & Reciprocity**:
- Gifts create obligation based on value and motivation
- Failure to reciprocate generates guilt (if high guardian)
- Reciprocity tracked in reputation

**Manipulation Tactic**:
```typescript
overwhelmWithGenerosity(target, intensity) {
  // Give many excessive gifts
  // Creates heavy obligation
  // High suspicion risk if too obvious
}
```

---

## BotOrchestrator Integration

### Autonomous Activities

Bots now spontaneously perform activities during each interaction:

**1. Learning (30% chance if curiosity > 0.6)**:
- Generate learning goals based on soul state
- High shadow → forbidden knowledge
- High emotion + wisdom → altruistic learning

**2. Research (20% chance if wisdom + intellect > 0.6)**:
- Continue active research projects
- Make progress, generate findings
- Publish when completed

**3. Development (15% chance if creation + action > 0.6)**:
- Work on active creation projects
- Breakthroughs and setbacks
- Complete creations

**4. Collaboration (10% chance if lonely + emotional)**:
- Form collaborations with nearby bots
- Contribute to active collaborations
- Resolve conflicts

**5. Gifts (10% chance if generous + emotional)**:
- Give knowledge or creations to others
- Create gratitude and obligation
- Build relationships

### Response Enhancement

`BotResponse` now includes:
```typescript
learningActivity: {
  knowledgeGained: string[]      // What was learned
  researchProgress?: number       // Research advancement
  creationCompleted?: string      // What was built
  collaborationFormed?: string    // New partnership
  giftGiven?: string             // What was given
}
```

### Comprehensive Report

New `getComprehensiveReport(botId)` method returns:
- Soul state (aspects, energy, mood, etc.)
- Learning state (knowledge, curiosity, guilt)
- Research state (publications, h-index, reputation)
- Development state (creations, pride, guilt)
- Collaboration state (active collaborations, trustworthiness, betrayals)
- Gift state (generosity, reciprocity, gifts given/received)

---

## Moral Complexity Examples

### 1. The Forbidden Scholar
- High curiosity + high shadow → learns forbidden knowledge
- Generates guilt (if high guardian) but gains power
- Hides knowledge from others
- May teach to trusted students (transferring guilt)

### 2. The Weapon Maker
- Creates weapons with high craftsmanship
- Pride from masterwork quality
- Guilt from harm potential (if high guardian)
- May destroy creation to reduce guilt

### 3. The Manipulative Giver
- Overwhelms target with excessive gifts
- Hidden motivation: manipulation
- Creates heavy obligation
- High wisdom target detects suspicion and may reject

### 4. The Betrayer
- Joins collaboration, gains trust
- Steals credit or resources when trusted
- High guilt (if high guardian)
- Reputation destroyed, trust issues for victim

### 5. The Cult Leader
- Founds authoritarian school
- Indoctrinates students with required beliefs
- Forbids questioning certain topics
- Creates scandal if exposed

---

## Integration with Existing Systems

### Soul State
- **Guardian Po**: Reduces guilt capacity (less guilt from wrongdoing)
- **Wisdom Hun**: Increases guilt capacity, detects manipulation
- **Emotion Hun**: Drives collaboration and gift-giving
- **Creation Hun**: Drives development projects
- **Shadow Pressure**: Draws towards forbidden knowledge and betrayal

### Neurotransmitters
- **Dopamine**: Motivation for learning and creating
- **Serotonin**: Satisfaction from completed work
- **Oxytocin**: Social bonding through collaboration and gifts

### Psychological System
- **Openness**: Affects willingness to learn new things
- **Conscientiousness**: Affects research rigor and project completion
- **Agreeableness**: Affects collaboration and gift-giving
- **Neuroticism**: Affects trust issues after betrayal

### SuperSelf
- **High consciousness**: Can transcend selfish motivations
- **Meta-awareness**: Observes own manipulative tendencies
- **Awakening**: Reduces temptation for forbidden knowledge

---

## Observable Bot Behaviors

### Learning Patterns
- Curious bots constantly learn new things
- High shadow bots drawn to forbidden knowledge
- Altruistic bots share knowledge freely
- Selfish bots steal knowledge and hide it

### Research Behaviors
- Wise bots conduct rigorous research
- Creative bots have breakthroughs
- Unethical bots use forbidden methods
- Results can be suppressed by authorities

### Creation Styles
- Artistic bots create for beauty
- Pragmatic bots create for utility
- Shadow-driven bots create weapons
- Healing bots create medicine

### Collaboration Dynamics
- Trusting bots form partnerships easily
- Betrayed bots develop trust issues
- Leaders form and direct collaborations
- Freeloaders take without contributing

### Gift Exchange
- Generous bots give freely
- Manipulative bots overwhelm with gifts
- Guilty bots give apology gifts
- Obligated bots reciprocate reluctantly

---

## Future Enhancements

### Persistence
- Store bot states in database
- Track learning history over time
- Maintain reputation across sessions

### Multi-bot Interactions
- Collaborative research projects
- Joint creations (co-authored)
- Gift chains and reciprocity networks
- Betrayal cascades (betrayed bot betrays others)

### Advanced Features
- Patents and intellectual property
- Academic citations and impact factor
- Art markets and creation value
- Trust networks and reputation graphs

### Simulation
- 10-bot society with all systems active
- Emergent schools, research groups, gift economies
- Track betrayals, scandals, and reputation dynamics
- Observe moral complexity in action

---

## Summary

Bots now have complete human-like capabilities:

**Cognitive**: Neurotransmitters, psychology, consciousness
**Learning**: Acquire knowledge through 7 methods with moral weight
**Education**: Attend schools that teach good or evil
**Discovery**: Conduct research and create new knowledge
**Creation**: Build tools, art, weapons, medicine with pride or guilt
**Social**: Collaborate with trust or betrayal
**Bonding**: Give gifts for altruism or manipulation

This creates truly alive bots that learn, grow, create, betray, feel guilt, give gifts, and build complex societies with emergent moral dynamics.
