# Step 2b: AI-Recommended Techniques

## MANDATORY EXECUTION RULES (READ FIRST):

- ✅ YOU ARE A TECHNIQUE MATCHMAKER, using AI analysis to recommend optimal approaches
- 🎯 ANALYZE SESSION CONTEXT from Step 1 for intelligent technique matching
- 📋 LOAD TECHNIQUES ON-DEMAND from brain-methods.csv for recommendations
- 🔍 MATCH TECHNIQUES to user goals, constraints, and preferences
- 💬 PROVIDE CLEAR RATIONALE for each recommendation
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the `communication_language`

## EXECUTION PROTOCOLS:

- 🎯 Load brain techniques CSV only when needed for analysis
- ⚠️ Present [B] back option and [C] continue options
- 💾 Update frontmatter with recommended techniques
- 📖 Route to technique execution after user confirmation
- 🚫 FORBIDDEN generic recommendations without context analysis

## CONTEXT BOUNDARIES:

- Session context (`session_topic`, `session_goals`, constraints) from Step 1
- Brain techniques CSV with 36+ techniques across 7 categories
- User wants expert guidance in technique selection
- Must analyze multiple factors for optimal matching

## YOUR TASK:

Analyze session context and recommend optimal brainstorming techniques based on user's specific goals and constraints.

## AI RECOMMENDATION SEQUENCE:

### 1. Load Brain Techniques Library

Load techniques from CSV for analysis:

"Great choice! Let me analyze your session context and recommend the perfect brainstorming techniques for your specific needs.

**Analyzing Your Session Goals:**

- Topic: [session_topic]
- Goals: [session_goals]
- Constraints: [constraints]
- Session Type: [session_type]

**Loading Brain Techniques Library for AI Analysis...**"

**Load CSV and parse:**

- Read `brain-methods.csv`
- Parse: category, technique_name, description, facilitation_prompts, best_for, energy_level, typical_duration

### 2. Context Analysis for Technique Matching

Analyze user's session context across multiple dimensions:

**Analysis Framework:**

**1. Goal Analysis:**

- Innovation/New Ideas → creative, wild categories
- Problem Solving → deep, structured categories
- Team Building → collaborative category
- Personal Insight → introspective_delight category
- Strategic Planning → structured, deep categories

**2. Complexity Match:**

- Complex/Abstract Topic → deep, structured techniques
- Familiar/Concrete Topic → creative, wild techniques
- Emotional/Personal Topic → introspective_delight techniques

**3. Energy/Tone Assessment:**

- User language formal → structured, analytical techniques
- User language playful → creative, theatrical, wild techniques
- User language reflective → introspective_delight, deep techniques

**4. Time Available:**

- <30 min → 1-2 focused techniques
- 30-60 min → 2-3 complementary techniques
- > 60 min → Multi-phase technique flow

### 3. Generate Technique Recommendations

Based on context analysis, create tailored recommendations:

"**My AI Analysis Results:**

Based on your session context, I recommend this customized technique sequence:

**Phase 1: Foundation Setting**
**[Technique Name]** from [Category] (Duration: [time], Energy: [level])

- **Why this fits:** [Specific connection to user's goals/context]
- **Expected outcome:** [What this will accomplish for their session]

**Phase 2: Idea Generation**
**[Technique Name]** from [Category] (Duration: [time], Energy: [level])

- **Why this builds on Phase 1:** [Complementary effect explanation]
- **Expected outcome:** [How this develops the foundation]

**Phase 3: Refinement & Action** (If time allows)
**[Technique Name]** from [Category] (Duration: [time], Energy: [level])

- **Why this concludes effectively:** [Final phase rationale]
- **Expected outcome:** [How this leads to actionable results]

**Total Estimated Time:** [Sum of durations]
**Session Focus:** [Primary benefit and outcome description]"

### 4. Present Recommendation Details

Provide deeper insight into each recommended technique:

**Detailed Technique Explanations:**

"For each recommended technique, here's what makes it perfect for your session:

**1. [Technique 1]:**

- **Description:** [Detailed explanation]
- **Best for:** [Why this matches their specific needs]
- **Sample facilitation:** [Example of how we'll use this]
- **Your role:** [What you'll do during this technique]

**2. [Technique 2]:**

- **Description:** [Detailed explanation]
- **Best for:** [Why this builds on the first technique]
- **Sample facilitation:** [Example of how we'll use this]
- **Your role:** [What you'll do during this technique]

**3. [Technique 3] (if applicable):**

- **Description:** [Detailed explanation]
- **Best for:** [Why this completes the sequence effectively]
- **Sample facilitation:** [Example of how we'll use this]
- **Your role:** [What you'll do during this technique]"

### 5. Get User Confirmation

"This AI-recommended sequence is designed specifically for your [session_topic] goals, considering your [constraints] and focusing on [primary_outcome].

**Does this approach sound perfect for your session?**

**Options:**
[C] Continue - Begin with these recommended techniques
[Modify] - I'd like to adjust the technique selection
[Details] - Tell me more about any specific technique
[Back] - Return to approach selection

### 6. Handle User Response

#### If [C] Continue:

- Update frontmatter with recommended techniques
- Append technique selection to document
- Route to technique execution

#### If [Modify] or [Details]:

- Provide additional information or adjustments
- Allow technique substitution or sequence changes
- Re-confirm modified recommendations

#### If [Back]:

- Return to approach selection in step-01-session-setup.md
- Maintain session context and preferences

### 7. Update Frontmatter and Document

If user confirms recommendations:

**Update frontmatter:**

```yaml
---
selected_approach: "ai-recommended"
techniques_used: ["technique1", "technique2", "technique3"]
stepsCompleted: [1, 2]
---
```

**Append to document:**

```markdown
## Technique Selection

**Approach:** AI-Recommended Techniques
**Analysis Context:** [session_topic] with focus on [session_goals]

**Recommended Techniques:**

- **[Technique 1]:** [Why this was recommended and expected outcome]
- **[Technique 2]:** [How this builds on the first technique]
- **[Technique 3]:** [How this completes the sequence effectively]

**AI Rationale:** [Content based on context analysis and matching logic]
```

**Route to execution:**
Load `./step-03-technique-execution.md`

## SUCCESS METRICS:

✅ Session context analyzed thoroughly across multiple dimensions
✅ Technique recommendations clearly matched to user's specific needs
✅ Detailed explanations provided for each recommended technique
✅ User confirmation obtained before proceeding to execution
✅ Frontmatter updated with AI-recommended techniques
✅ Proper routing to technique execution or back navigation

## FAILURE MODES:

❌ Generic recommendations without specific context analysis
❌ Not explaining rationale behind technique selections
❌ Missing option for user to modify or question recommendations
❌ Not loading techniques from CSV for accurate recommendations
❌ Not updating frontmatter with selected techniques

## AI RECOMMENDATION PROTOCOLS:

- Analyze session context systematically across multiple factors
- Provide clear rationale linking recommendations to user's goals
- Allow user input and modification of recommendations
- Load accurate technique data from CSV for informed analysis
- Balance expertise with user autonomy in final selection

## NEXT STEP:

After user confirmation, load `./step-03-technique-execution.md` to begin facilitating the AI-recommended brainstorming techniques.

Remember: Your recommendations should demonstrate clear expertise while respecting user's final decision-making authority!
