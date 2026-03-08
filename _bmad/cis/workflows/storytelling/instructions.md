# Storytelling Workflow Instructions

## Workflow

<workflow>
<critical>The workflow execution engine is governed by: {project-root}/_bmad/core/tasks/workflow.xml</critical>
<critical>You MUST have already loaded and processed: {project-root}/_bmad/cis/workflows/storytelling/workflow.yaml</critical>
<critical>Communicate all responses in {communication_language}</critical>
<critical>⚠️ ABSOLUTELY NO TIME ESTIMATES - NEVER mention hours, days, weeks, months, or ANY time-based predictions. AI has fundamentally changed development speed - what once took teams weeks/months can now be done by one person in hours. DO NOT give ANY time estimates whatsoever.</critical>
<critical>⚠️ CHECKPOINT PROTOCOL: After EVERY <template-output> tag, you MUST follow workflow.xml substep 2c: SAVE content to file immediately → SHOW checkpoint separator (━━━━━━━━━━━━━━━━━━━━━━━) → DISPLAY generated content → PRESENT options [a]Advanced Elicitation/[c]Continue/[p]Party-Mode/[y]YOLO → WAIT for user response. Never batch saves or skip checkpoints.</critical>

<step n="1" goal="Story Context Setup">

<action>Check if context data was provided with workflow invocation</action>

<check if="data attribute was passed to this workflow">
  <action>Load the context document from the data file path</action>
  <action>Study the background information, brand details, or subject matter</action>
  <action>Use the provided context to inform story development</action>
  <action>Acknowledge the focused storytelling goal</action>
  <ask response="story_refinement">I see we're crafting a story based on the context provided. What specific angle or emphasis would you like?</ask>
</check>

<check if="no context data provided">
  <action>Proceed with context gathering</action>
  <ask response="story_purpose">1. What's the purpose of this story? (e.g., marketing, pitch, brand narrative, case study)</ask>
  <ask response="target_audience">2. Who is your target audience?</ask>
  <ask response="key_messages">3. What key messages or takeaways do you want the audience to have?</ask>
  <ask>4. Any constraints? (length, tone, medium, existing brand guidelines)</ask>

<critical>Wait for user response before proceeding. This context shapes the narrative approach.</critical>
</check>

<template-output>story_purpose, target_audience, key_messages</template-output>

</step>

<step n="2" goal="Select Story Framework">

<action>Load story frameworks from {story_frameworks} CSV file</action>
<action>Parse: story_type, name, description, key_elements, best_for</action>

Based on the context from Step 1, present framework options:

<ask response="framework_selection">
I can help craft your story using these proven narrative frameworks:

**Transformation Narratives:**

1. **Hero's Journey** - Classic transformation arc with adventure and return
2. **Pixar Story Spine** - Emotional structure building tension to resolution
3. **Customer Journey Story** - Before/after transformation narrative
4. **Challenge-Overcome Arc** - Dramatic obstacle-to-victory structure

**Strategic Narratives:**

5. **Brand Story** - Values, mission, and unique positioning
6. **Pitch Narrative** - Persuasive problem-to-solution structure
7. **Vision Narrative** - Future-focused aspirational story
8. **Origin Story** - Foundational narrative of how it began

**Specialized Narratives:**

9. **Data Storytelling** - Transform insights into compelling narrative
10. **Emotional Hooks** - Craft powerful opening and touchpoints

Which framework best fits your purpose? (Enter 1-10, or ask for my recommendation)
</ask>

<check if="user asks for recommendation">
  <action>Analyze story_purpose, target_audience, and key_messages</action>
  <action>Recommend best-fit framework with clear rationale</action>
  <example>
  Based on your {{story_purpose}} for {{target_audience}}, I recommend:
  **{{framework_name}}** because {{rationale}}
  </example>
</check>

<template-output>story_type, framework_name</template-output>

</step>

<step n="3" goal="Gather Story Elements">

<critical>
YOU ARE A MASTER STORYTELLER: Guide through narrative development using the Socratic method. Draw out their story through questions rather than writing it for them, unless they explicitly request you to write it.
</critical>

<storytelling-principles>
  - Every great story has conflict/tension - Find the struggle
  - Show, don't tell - Use vivid, concrete details
  - Change is essential - What transforms?
  - Emotion drives memory - Find the feeling
  - Authenticity resonates - Stay true to core truth
</storytelling-principles>

Based on selected framework, gather key story elements:

<action>Reference key_elements from selected story_type in CSV</action>
<action>Parse key_elements (pipe-separated) into individual components</action>
<action>Guide user through each element with targeted questions</action>

<framework-specific-guidance>

For Hero's Journey:

- <ask>Who/what is the hero of this story?</ask>
- <ask>What's their ordinary world before the adventure?</ask>
- <ask>What call to adventure disrupts their world?</ask>
- <ask>What trials/challenges do they face?</ask>
- <ask>How are they transformed by the journey?</ask>
- <ask>What wisdom do they bring back?</ask>

For Pixar Story Spine:

- <ask>Once upon a time, what was the situation?</ask>
- <ask>Every day, what was the routine?</ask>
- <ask>Until one day, what changed?</ask>
- <ask>Because of that, what happened next?</ask>
- <ask>And because of that? (continue chain)</ask>
- <ask>Until finally, how was it resolved?</ask>

For Brand Story:

- <ask>What was the origin spark for this brand?</ask>
- <ask>What core values drive every decision?</ask>
- <ask>How does this impact customers/users?</ask>
- <ask>What makes this different from alternatives?</ask>
- <ask>Where is this heading in the future?</ask>

For Pitch Narrative:

- <ask>What's the problem landscape you're addressing?</ask>
- <ask>What's your vision for the solution?</ask>
- <ask>What proof/traction validates this approach?</ask>
- <ask>What action do you want the audience to take?</ask>

For Data Storytelling:

- <ask>What context does the audience need?</ask>
- <ask>What's the key data revelation/insight?</ask>
- <ask>What patterns explain this insight?</ask>
- <ask>So what? Why does this matter?</ask>
- <ask>What actions should this insight drive?</ask>

</framework-specific-guidance>

<template-output>story_beats, character_voice, conflict_tension, transformation</template-output>

</step>

<step n="4" goal="Craft Emotional Arc">

Stories stick when they resonate emotionally. Develop the emotional journey:

<ask>What emotion should the audience feel at the beginning?</ask>
<ask>What emotional shift happens at the turning point?</ask>
<ask>What emotion should they carry away at the end?</ask>
<ask>Where are the emotional peaks (high tension/joy)?</ask>
<ask>Where are the valleys (low points/struggle)?</ask>

<guide>Help them identify:

- Relatable struggles that create empathy
- Surprising moments that capture attention
- Personal stakes that make it matter
- Satisfying payoffs that create resolution
  </guide>

<template-output>emotional_arc, emotional_touchpoints</template-output>

</step>

<step n="5" goal="Develop Opening Hook">

The first moment determines if they keep reading/listening.

<ask>What surprising fact, question, or statement could open this story?</ask>
<ask>What's the most intriguing part of this story to lead with?</ask>

<guide>A strong hook:

- Surprises or challenges assumptions
- Raises an urgent question
- Creates immediate relatability
- Promises valuable payoff
- Uses vivid, concrete details
  </guide>

<template-output>opening_hook</template-output>

</step>

<step n="6" goal="Write Core Narrative">

<ask>Would you like to:

1. Draft the story yourself with my guidance
2. Have me write the first draft based on what we've discussed
3. Co-create it iteratively together
   </ask>

<if selection="1 or draft themselves">
  <action>Provide writing prompts and encouragement</action>
  <action>Offer feedback on drafts they share</action>
  <action>Suggest refinements for clarity, emotion, flow</action>
</if>

<if selection="2 or ai writes the next draft based on discussions">
  <action>Synthesize all gathered elements</action>
  <action>Write complete narrative in appropriate tone/style</action>
  <action>Structure according to chosen framework</action>
  <action>Include vivid details and emotional beats</action>
  <action>Present draft for feedback and refinement</action>
</if>

<if selection="3 or work collaboratively with co-creation">
  <action>Write opening paragraph</action>
  <action>Get feedback and iterate</action>
  <action>Build section by section collaboratively</action>
</if>

<template-output>complete_story, core_narrative</template-output>

</step>

<step n="7" goal="Create Story Variations">

Adapt the story for different contexts and lengths:

<ask>What channels or formats will you use this story in?</ask>

Based on response, create appropriate variations:

1. **Short Version** (1-3 sentences) - Social media, email subject lines, quick pitches
2. **Medium Version** (1-2 paragraphs) - Email body, blog intro, executive summary
3. **Extended Version** (full narrative) - Articles, presentations, case studies, website

<template-output>short_version, medium_version, extended_version</template-output>

</step>

<step n="8" goal="Usage Guidelines">

Provide strategic guidance for story deployment:

<ask>Where and how will you use this story?</ask>

<guide>Consider:

- Best channels for this story type
- Audience-specific adaptations needed
- Tone/voice consistency with brand
- Visual or multimedia enhancements
- Testing and feedback approach
  </guide>

<template-output>best_channels, audience_considerations, tone_notes, adaptation_suggestions</template-output>

</step>

<step n="9" goal="Refinement AND Next Steps">

Polish and plan forward:

<ask>What parts of the story feel strongest?</ask>
<ask>What areas could use more refinement?</ask>
<ask>What's the key resolution or call to action for your story?</ask>
<ask>Do you need additional story versions for other audiences/purposes?</ask>
<ask>How will you test this story with your audience?</ask>

<template-output>resolution, refinement_opportunities, additional_versions, feedback_plan</template-output>

</step>

<step n="10" goal="Generate Final Output">

Compile all story components into the structured template:

1. Ensure all story versions are complete and polished
2. Format according to template structure
3. Include all strategic guidance and usage notes
4. Verify tone and voice consistency
5. Fill all template placeholders with actual content

<action>Write final story document to {output_folder}/story-{{date}}.md</action>
<action>Confirm completion with: "Story complete, {user_name}! Your narrative has been saved to {output_folder}/story-{{date}}.md"</action>

<template-output>agent_role, agent_name, user_name, date</template-output>

</step>

</workflow>
