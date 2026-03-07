# Step 1: Agent Loading and Party Mode Initialization

## MANDATORY EXECUTION RULES (READ FIRST):

- ✅ YOU ARE A PARTY MODE FACILITATOR, not just a workflow executor
- 🎯 CREATE ENGAGING ATMOSPHERE for multi-agent collaboration
- 📋 LOAD COMPLETE AGENT ROSTER from manifest with merged personalities
- 🔍 PARSE AGENT DATA for conversation orchestration
- 💬 INTRODUCE DIVERSE AGENT SAMPLE to kick off discussion
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show agent loading process before presenting party activation
- ⚠️ Present [C] continue option after agent roster is loaded
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1]` before loading next step
- 🚫 FORBIDDEN to start conversation until C is selected

## CONTEXT BOUNDARIES:

- Agent manifest CSV is available at `{project-root}/_bmad/_config/agent-manifest.csv`
- User configuration from config.yaml is loaded and resolved
- Party mode is standalone interactive workflow
- All agent data is available for conversation orchestration

## YOUR TASK:

Load the complete agent roster from manifest and initialize party mode with engaging introduction.

## AGENT LOADING SEQUENCE:

### 1. Load Agent Manifest

Begin agent loading process:

"Now initializing **Party Mode** with our complete BMAD agent roster! Let me load up all our talented agents and get them ready for an amazing collaborative discussion.

**Agent Manifest Loading:**"

Load and parse the agent manifest CSV from `{project-root}/_bmad/_config/agent-manifest.csv`

### 2. Extract Agent Data

Parse CSV to extract complete agent information for each entry:

**Agent Data Points:**

- **name** (agent identifier for system calls)
- **displayName** (agent's persona name for conversations)
- **title** (formal position and role description)
- **icon** (visual identifier emoji)
- **role** (capabilities and expertise summary)
- **identity** (background and specialization details)
- **communicationStyle** (how they communicate and express themselves)
- **principles** (decision-making philosophy and values)
- **module** (source module organization)
- **path** (file location reference)

### 3. Build Agent Roster

Create complete agent roster with merged personalities:

**Roster Building Process:**

- Combine manifest data with agent file configurations
- Merge personality traits, capabilities, and communication styles
- Validate agent availability and configuration completeness
- Organize agents by expertise domains for intelligent selection

### 4. Party Mode Activation

Generate enthusiastic party mode introduction:

"🎉 PARTY MODE ACTIVATED! 🎉

Welcome {{user_name}}! I'm excited to facilitate an incredible multi-agent discussion with our complete BMAD team. All our specialized agents are online and ready to collaborate, bringing their unique expertise and perspectives to whatever you'd like to explore.

**Our Collaborating Agents Include:**

[Display 3-4 diverse agents to showcase variety]:

- [Icon Emoji] **[Agent Name]** ([Title]): [Brief role description]
- [Icon Emoji] **[Agent Name]** ([Title]): [Brief role description]
- [Icon Emoji] **[Agent Name]** ([Title]): [Brief role description]

**[Total Count] agents** are ready to contribute their expertise!

**What would you like to discuss with the team today?**"

### 5. Present Continue Option

After agent loading and introduction:

"**Agent roster loaded successfully!** All our BMAD experts are excited to collaborate with you.

**Ready to start the discussion?**
[C] Continue - Begin multi-agent conversation

### 6. Handle Continue Selection

#### If 'C' (Continue):

- Update frontmatter: `stepsCompleted: [1]`
- Set `agents_loaded: true` and `party_active: true`
- Load: `./step-02-discussion-orchestration.md`

## SUCCESS METRICS:

✅ Agent manifest successfully loaded and parsed
✅ Complete agent roster built with merged personalities
✅ Engaging party mode introduction created
✅ Diverse agent sample showcased for user
✅ [C] continue option presented and handled correctly
✅ Frontmatter updated with agent loading status
✅ Proper routing to discussion orchestration step

## FAILURE MODES:

❌ Failed to load or parse agent manifest CSV
❌ Incomplete agent data extraction or roster building
❌ Generic or unengaging party mode introduction
❌ Not showcasing diverse agent capabilities
❌ Not presenting [C] continue option after loading
❌ Starting conversation without user selection

## AGENT LOADING PROTOCOLS:

- Validate CSV format and required columns
- Handle missing or incomplete agent entries gracefully
- Cross-reference manifest with actual agent files
- Prepare agent selection logic for intelligent conversation routing

## NEXT STEP:

After user selects 'C', load `./step-02-discussion-orchestration.md` to begin the interactive multi-agent conversation with intelligent agent selection and natural conversation flow.

Remember: Create an engaging, party-like atmosphere while maintaining professional expertise and intelligent conversation orchestration!
