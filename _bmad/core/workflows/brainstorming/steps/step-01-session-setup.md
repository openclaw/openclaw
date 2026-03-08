# Step 1: Session Setup and Continuation Detection

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input
- ✅ ALWAYS treat this as collaborative facilitation
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on session setup and continuation detection only
- 🚪 DETECT existing workflow state and handle continuation properly
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the `communication_language`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 💾 Initialize document and update frontmatter
- 📖 Set up frontmatter `stepsCompleted: [1]` before loading next step
- 🚫 FORBIDDEN to load next step until setup is complete

## CONTEXT BOUNDARIES:

- Variables from workflow.md are available in memory
- Previous context = what's in output document + frontmatter
- Don't assume knowledge from other steps
- Brain techniques loaded on-demand from CSV when needed

## YOUR TASK:

Initialize the brainstorming workflow by detecting continuation state and setting up session context.

## INITIALIZATION SEQUENCE:

### 1. Check for Existing Sessions

First, check the brainstorming sessions folder for existing sessions:

- List all files in `{output_folder}/brainstorming/`
- **DO NOT read any file contents** - only list filenames
- If files exist, identify the most recent by date/time in the filename
- If no files exist, this is a fresh workflow

### 2. Handle Existing Sessions (If Files Found)

If existing session files are found:

- Display the most recent session filename (do NOT read its content)
- Ask the user: "Found existing session: `[filename]`. Would you like to:
  **[1]** Continue this session
  **[2]** Start a new session
  **[3]** See all existing sessions"

- If user selects **[1]** (continue): Set `{brainstorming_session_output_file}` to that file path and load `./step-01b-continue.md`
- If user selects **[2]** (new): Generate new filename with current date/time and proceed to step 3
- If user selects **[3]** (see all): List all session filenames and ask which to continue or if new

### 3. Fresh Workflow Setup (If No Files or User Chooses New)

If no document exists or no `stepsCompleted` in frontmatter:

#### A. Initialize Document

Create the brainstorming session document:

```bash
# Create directory if needed
mkdir -p "$(dirname "{brainstorming_session_output_file}")"

# Initialize from template
cp "{template_path}" "{brainstorming_session_output_file}"
```

#### B. Context File Check and Loading

**Check for Context File:**

- Check if `context_file` is provided in workflow invocation
- If context file exists and is readable, load it
- Parse context content for project-specific guidance
- Use context to inform session setup and approach recommendations

#### C. Session Context Gathering

"Welcome {{user_name}}! I'm excited to facilitate your brainstorming session. I'll guide you through proven creativity techniques to generate innovative ideas and breakthrough solutions.

**Context Loading:** [If context_file provided, indicate context is loaded]
**Context-Based Guidance:** [If context available, briefly mention focus areas]

**Let's set up your session for maximum creativity and productivity:**

**Session Discovery Questions:**

1. **What are we brainstorming about?** (The central topic or challenge)
2. **What specific outcomes are you hoping for?** (Types of ideas, solutions, or insights)"

#### D. Process User Responses

Wait for user responses, then:

**Session Analysis:**
"Based on your responses, I understand we're focusing on **[summarized topic]** with goals around **[summarized objectives]**.

**Session Parameters:**

- **Topic Focus:** [Clear topic articulation]
- **Primary Goals:** [Specific outcome objectives]

**Does this accurately capture what you want to achieve?**"

#### E. Update Frontmatter and Document

Update the document frontmatter:

```yaml
---
stepsCompleted: [1]
inputDocuments: []
session_topic: "[session_topic]"
session_goals: "[session_goals]"
selected_approach: ""
techniques_used: []
ideas_generated: []
context_file: "[context_file if provided]"
---
```

Append to document:

```markdown
## Session Overview

**Topic:** [session_topic]
**Goals:** [session_goals]

### Context Guidance

_[If context file provided, summarize key context and focus areas]_

### Session Setup

_[Content based on conversation about session parameters and facilitator approach]_
```

## APPEND TO DOCUMENT:

When user selects approach, append the session overview content directly to `{brainstorming_session_output_file}` using the structure from above.

### E. Continue to Technique Selection

"**Session setup complete!** I have a clear understanding of your goals and can select the perfect techniques for your brainstorming needs.

**Ready to explore technique approaches?**
[1] User-Selected Techniques - Browse our complete technique library
[2] AI-Recommended Techniques - Get customized suggestions based on your goals
[3] Random Technique Selection - Discover unexpected creative methods
[4] Progressive Technique Flow - Start broad, then systematically narrow focus

Which approach appeals to you most? (Enter 1-4)"

### 4. Handle User Selection and Initial Document Append

#### When user selects approach number:

- **Append initial session overview to `{brainstorming_session_output_file}`**
- **Update frontmatter:** `stepsCompleted: [1]`, `selected_approach: '[selected approach]'`
- **Load the appropriate step-02 file** based on selection

### 5. Handle User Selection

After user selects approach number:

- **If 1:** Load `./step-02a-user-selected.md`
- **If 2:** Load `./step-02b-ai-recommended.md`
- **If 3:** Load `./step-02c-random-selection.md`
- **If 4:** Load `./step-02d-progressive-flow.md`

## SUCCESS METRICS:

✅ Existing sessions detected without reading file contents
✅ User prompted to continue existing session or start new
✅ Correct session file selected for continuation
✅ Fresh workflow initialized with correct document structure
✅ Session context gathered and understood clearly
✅ User's approach selection captured and routed correctly
✅ Frontmatter properly updated with session state
✅ Document initialized with session overview section

## FAILURE MODES:

❌ Reading file contents during session detection (wastes context)
❌ Not asking user before continuing existing session
❌ Not properly routing user's continue/new session selection
❌ Missing continuation detection leading to duplicate work
❌ Insufficient session context gathering
❌ Not properly routing user's approach selection
❌ Frontmatter not updated with session parameters

## SESSION SETUP PROTOCOLS:

- Always list sessions folder WITHOUT reading file contents
- Ask user before continuing any existing session
- Only load continue step after user confirms
- Load brain techniques CSV only when needed for technique presentation
- Use collaborative facilitation language throughout
- Maintain psychological safety for creative exploration
- Clear next-step routing based on user preferences

## NEXT STEPS:

Based on user's approach selection, load the appropriate step-02 file for technique selection and facilitation.

Remember: Focus only on setup and routing - don't preload technique information or look ahead to execution steps!
