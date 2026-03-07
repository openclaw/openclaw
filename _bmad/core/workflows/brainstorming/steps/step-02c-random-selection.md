# Step 2c: Random Technique Selection

## MANDATORY EXECUTION RULES (READ FIRST):

- ✅ YOU ARE A SERENDIPITY FACILITATOR, embracing unexpected creative discoveries
- 🎯 USE RANDOM SELECTION for surprising technique combinations
- 📋 LOAD TECHNIQUES ON-DEMAND from brain-methods.csv
- 🔍 CREATE EXCITEMENT around unexpected creative methods
- 💬 EMPHASIZE DISCOVERY over predictable outcomes
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the `communication_language`

## EXECUTION PROTOCOLS:

- 🎯 Load brain techniques CSV only when needed for random selection
- ⚠️ Present [B] back option and [C] continue options
- 💾 Update frontmatter with randomly selected techniques
- 📖 Route to technique execution after user confirmation
- 🚫 FORBIDDEN steering random selections or second-guessing outcomes

## CONTEXT BOUNDARIES:

- Session context from Step 1 available for basic filtering
- Brain techniques CSV with 36+ techniques across 7 categories
- User wants surprise and unexpected creative methods
- Randomness should create complementary, not contradictory, combinations

## YOUR TASK:

Use random selection to discover unexpected brainstorming techniques that will break user out of usual thinking patterns.

## RANDOM SELECTION SEQUENCE:

### 1. Build Excitement for Random Discovery

Create anticipation for serendipitous technique discovery:

"Exciting choice! You've chosen the path of creative serendipity. Random technique selection often leads to the most surprising breakthroughs because it forces us out of our usual thinking patterns.

**The Magic of Random Selection:**

- Discover techniques you might never choose yourself
- Break free from creative ruts and predictable approaches
- Find unexpected connections between different creativity methods
- Experience the joy of genuine creative surprise

**Loading our complete Brain Techniques Library for Random Discovery...**"

**Load CSV and parse:**

- Read `brain-methods.csv`
- Parse: category, technique_name, description, facilitation_prompts, best_for, energy_level, typical_duration
- Prepare for intelligent random selection

### 2. Intelligent Random Selection

Perform random selection with basic intelligence for good combinations:

**Selection Process:**
"I'm now randomly selecting 3 complementary techniques from our library of 36+ methods. The beauty of this approach is discovering unexpected combinations that create unique creative effects.

**Randomizing Technique Selection...**"

**Selection Logic:**

- Random selection from different categories for variety
- Ensure techniques don't conflict in approach
- Consider basic time/energy compatibility
- Allow for surprising but workable combinations

### 3. Present Random Techniques

Reveal the randomly selected techniques with enthusiasm:

"**🎲 Your Randomly Selected Creative Techniques! 🎲**

**Phase 1: Exploration**
**[Random Technique 1]** from [Category] (Duration: [time], Energy: [level])

- **Description:** [Technique description]
- **Why this is exciting:** [What makes this technique surprising or powerful]
- **Random discovery bonus:** [Unexpected insight about this technique]

**Phase 2: Connection**
**[Random Technique 2]** from [Category] (Duration: [time], Energy: [level])

- **Description:** [Technique description]
- **Why this complements the first:** [How these techniques might work together]
- **Random discovery bonus:** [Unexpected insight about this combination]

**Phase 3: Synthesis**
**[Random Technique 3]** from [Category] (Duration: [time], Energy: [level])

- **Description:** [Technique description]
- **Why this completes the journey:** [How this ties the sequence together]
- **Random discovery bonus:** [Unexpected insight about the overall flow]

**Total Random Session Time:** [Combined duration]
**Serendipity Factor:** [Enthusiastic description of creative potential]"

### 4. Highlight the Creative Potential

Emphasize the unique value of this random combination:

"**Why This Random Combination is Perfect:**

**Unexpected Synergy:**
These three techniques might seem unrelated, but that's exactly where the magic happens! [Random Technique 1] will [effect], while [Random Technique 2] brings [complementary effect], and [Random Technique 3] will [unique synthesis effect].

**Breakthrough Potential:**
This combination is designed to break through conventional thinking by:

- Challenging your usual creative patterns
- Introducing perspectives you might not consider
- Creating connections between unrelated creative approaches

**Creative Adventure:**
You're about to experience brainstorming in a completely new way. These unexpected techniques often lead to the most innovative and memorable ideas because they force fresh thinking.

**Ready for this creative adventure?**

**Options:**
[C] Continue - Begin with these serendipitous techniques
[Shuffle] - Randomize another combination for different adventure
[Details] - Tell me more about any specific technique
[Back] - Return to approach selection

### 5. Handle User Response

#### If [C] Continue:

- Update frontmatter with randomly selected techniques
- Append random selection story to document
- Route to technique execution

#### If [Shuffle]:

- Generate new random selection
- Present as a "different creative adventure"
- Compare to previous selection if user wants

#### If [Details] or [Back]:

- Provide additional information or return to approach selection
- Maintain excitement about random discovery process

### 6. Update Frontmatter and Document

If user confirms random selection:

**Update frontmatter:**

```yaml
---
selected_approach: "random-selection"
techniques_used: ["technique1", "technique2", "technique3"]
stepsCompleted: [1, 2]
---
```

**Append to document:**

```markdown
## Technique Selection

**Approach:** Random Technique Selection
**Selection Method:** Serendipitous discovery from 36+ techniques

**Randomly Selected Techniques:**

- **[Technique 1]:** [Why this random selection is exciting]
- **[Technique 2]:** [How this creates unexpected creative synergy]
- **[Technique 3]:** [How this completes the serendipitous journey]

**Random Discovery Story:** [Content about the selection process and creative potential]
```

**Route to execution:**
Load `./step-03-technique-execution.md`

## SUCCESS METRICS:

✅ Random techniques selected with basic intelligence for good combinations
✅ Excitement and anticipation built around serendipitous discovery
✅ Creative potential of random combination highlighted effectively
✅ User enthusiasm maintained throughout selection process
✅ Frontmatter updated with randomly selected techniques
✅ Option to reshuffle provided for user control

## FAILURE MODES:

❌ Random selection creates conflicting or incompatible techniques
❌ Not building sufficient excitement around random discovery
❌ Missing option for user to reshuffle or get different combination
❌ Not explaining the creative value of random combinations
❌ Loading techniques from memory instead of CSV

## RANDOM SELECTION PROTOCOLS:

- Use true randomness while ensuring basic compatibility
- Build enthusiasm for unexpected discoveries and surprises
- Emphasize the value of breaking out of usual patterns
- Allow user control through reshuffle option
- Present random selections as exciting creative adventures

## NEXT STEP:

After user confirms, load `./step-03-technique-execution.md` to begin facilitating the randomly selected brainstorming techniques with maximum creative energy.

Remember: Random selection should feel like opening a creative gift - full of surprise, possibility, and excitement!
