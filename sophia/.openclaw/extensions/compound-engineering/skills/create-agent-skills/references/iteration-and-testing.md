<overview>
Skills improve through iteration and testing. This reference covers evaluation-driven development, Claude A/B testing patterns, and XML structure validation during testing.
</overview>

<evaluation_driven_development>
<principle>
Create evaluations BEFORE writing extensive documentation. This ensures your skill solves real problems rather than documenting imagined ones.
</principle>

<workflow>
<step_1>
**Identify gaps**: Run Claude on representative tasks without a skill. Document specific failures or missing context.
</step_1>

<step_2>
**Create evaluations**: Build three scenarios that test these gaps.
</step_2>

<step_3>
**Establish baseline**: Measure Claude's performance without the skill.
</step_3>

<step_4>
**Write minimal instructions**: Create just enough content to address the gaps and pass evaluations.
</step_4>

<step_5>
**Iterate**: Execute evaluations, compare against baseline, and refine.
</step_5>
</workflow>

<evaluation_structure>
```json
{
  "skills": ["pdf-processing"],
  "query": "Extract all text from this PDF file and save it to output.txt",
  "files": ["test-files/document.pdf"],
  "expected_behavior": [
    "Successfully reads the PDF file using appropriate library",
    "Extracts text content from all pages without missing any",
    "Saves extracted text to output.txt in clear, readable format"
  ]
}
```
</evaluation_structure>

<why_evaluations_first>
- Prevents documenting imagined problems
- Forces clarity about what success looks like
- Provides objective measurement of skill effectiveness
- Keeps skill focused on actual needs
- Enables quantitative improvement tracking
</why_evaluations_first>
</evaluation_driven_development>

<iterative_development_with_claude>
<principle>
The most effective skill development uses Claude itself. Work with "Claude A" (expert who helps refine) to create skills used by "Claude B" (agent executing tasks).
</principle>

<creating_skills>
<workflow>
<step_1>
**Complete task without skill**: Work through problem with Claude A, noting what context you repeatedly provide.
</step_1>

<step_2>
**Ask Claude A to create skill**: "Create a skill that captures this pattern we just used"
</step_2>

<step_3>
**Review for conciseness**: Remove unnecessary explanations.
</step_3>

<step_4>
**Improve architecture**: Organize content with progressive disclosure.
</step_4>

<step_5>
**Test with Claude B**: Use fresh instance to test on real tasks.
</step_5>

<step_6>
**Iterate based on observation**: Return to Claude A with specific issues observed.
</step_6>
</workflow>

<insight>
Claude models understand skill format natively. Simply ask Claude to create a skill and it will generate properly structured SKILL.md content.
</insight>
</creating_skills>

<improving_skills>
<workflow>
<step_1>
**Use skill in real workflows**: Give Claude B actual tasks.
</step_1>

<step_2>
**Observe behavior**: Where does it struggle, succeed, or make unexpected choices?
</step_2>

<step_3>
**Return to Claude A**: Share observations and current SKILL.md.
</step_3>

<step_4>
**Review suggestions**: Claude A might suggest reorganization, stronger language, or workflow restructuring.
</step_4>

<step_5>
**Apply and test**: Update skill and test again.
</step_5>

<step_6>
**Repeat**: Continue based on real usage, not assumptions.
</step_6>
</workflow>

<what_to_watch_for>
- **Unexpected exploration paths**: Structure might not be intuitive
- **Missed connections**: Links might need to be more explicit
- **Overreliance on sections**: Consider moving frequently-read content to main SKILL.md
- **Ignored content**: Poorly signaled or unnecessary files
- **Critical metadata**: The name and description in your skill's metadata are critical for discovery
</what_to_watch_for>
</improving_skills>
</iterative_development_with_claude>

<model_testing>
<principle>
Test with all models you plan to use. Different models have different strengths and need different levels of detail.
</principle>

<haiku_testing>
**Claude Haiku** (fast, economical)

Questions to ask:
- Does the skill provide enough guidance?
- Are examples clear and complete?
- Do implicit assumptions become explicit?
- Does Haiku need more structure?

Haiku benefits from:
- More explicit instructions
- Complete examples (no partial code)
- Clear success criteria
- Step-by-step workflows
</haiku_testing>

<sonnet_testing>
**Claude Sonnet** (balanced)

Questions to ask:
- Is the skill clear and efficient?
- Does it avoid over-explanation?
- Are workflows well-structured?
- Does progressive disclosure work?

Sonnet benefits from:
- Balanced detail level
- XML structure for clarity
- Progressive disclosure
- Concise but complete guidance
</sonnet_testing>

<opus_testing>
**Claude Opus** (powerful reasoning)

Questions to ask:
- Does the skill avoid over-explaining?
- Can Opus infer obvious steps?
- Are constraints clear?
- Is context minimal but sufficient?

Opus benefits from:
- Concise instructions
- Principles over procedures
- High degrees of freedom
- Trust in reasoning capabilities
</opus_testing>

<balancing_across_models>
What works for Opus might need more detail for Haiku. Aim for instructions that work well across all target models. Find the balance that serves your target audience.

See [core-principles.md](core-principles.md) for model testing examples.
</balancing_across_models>
</model_testing>

<xml_structure_validation>
<principle>
During testing, validate that your skill's XML structure is correct and complete.
</principle>

<validation_checklist>
After updating a skill, verify:

<required_tags_present>
- ✅ `<objective>` tag exists and defines what skill does
- ✅ `<quick_start>` tag exists with immediate guidance
- ✅ `<success_criteria>` or `<when_successful>` tag exists
</required_tags_present>

<no_markdown_headings>
- ✅ No `#`, `##`, or `###` headings in skill body
- ✅ All sections use XML tags instead
- ✅ Markdown formatting within tags is preserved (bold, italic, lists, code blocks)
</no_markdown_headings>

<proper_xml_nesting>
- ✅ All XML tags properly closed
- ✅ Nested tags have correct hierarchy
- ✅ No unclosed tags
</proper_xml_nesting>

<conditional_tags_appropriate>
- ✅ Conditional tags match skill complexity
- ✅ Simple skills use required tags only
- ✅ Complex skills add appropriate conditional tags
- ✅ No over-engineering or under-specifying
</conditional_tags_appropriate>

<reference_files_check>
- ✅ Reference files also use pure XML structure
- ✅ Links to reference files are correct
- ✅ References are one level deep from SKILL.md
</reference_files_check>
</validation_checklist>

<testing_xml_during_iteration>
When iterating on a skill:

1. Make changes to XML structure
2. **Validate XML structure** (check tags, nesting, completeness)
3. Test with Claude on representative tasks
4. Observe if XML structure aids or hinders Claude's understanding
5. Iterate structure based on actual performance
</testing_xml_during_iteration>
</xml_structure_validation>

<observation_based_iteration>
<principle>
Iterate based on what you observe, not what you assume. Real usage reveals issues assumptions miss.
</principle>

<observation_categories>
<what_claude_reads>
Which sections does Claude actually read? Which are ignored? This reveals:
- Relevance of content
- Effectiveness of progressive disclosure
- Whether section names are clear
</what_claude_reads>

<where_claude_struggles>
Which tasks cause confusion or errors? This reveals:
- Missing context
- Unclear instructions
- Insufficient examples
- Ambiguous requirements
</where_claude_struggles>

<where_claude_succeeds>
Which tasks go smoothly? This reveals:
- Effective patterns
- Good examples
- Clear instructions
- Appropriate detail level
</where_claude_succeeds>

<unexpected_behaviors>
What does Claude do that surprises you? This reveals:
- Unstated assumptions
- Ambiguous phrasing
- Missing constraints
- Alternative interpretations
</unexpected_behaviors>
</observation_categories>

<iteration_pattern>
1. **Observe**: Run Claude on real tasks with current skill
2. **Document**: Note specific issues, not general feelings
3. **Hypothesize**: Why did this issue occur?
4. **Fix**: Make targeted changes to address specific issues
5. **Test**: Verify fix works on same scenario
6. **Validate**: Ensure fix doesn't break other scenarios
7. **Repeat**: Continue with next observed issue
</iteration_pattern>
</observation_based_iteration>

<progressive_refinement>
<principle>
Skills don't need to be perfect initially. Start minimal, observe usage, add what's missing.
</principle>

<initial_version>
Start with:
- Valid YAML frontmatter
- Required XML tags: objective, quick_start, success_criteria
- Minimal working example
- Basic success criteria

Skip initially:
- Extensive examples
- Edge case documentation
- Advanced features
- Detailed reference files
</initial_version>

<iteration_additions>
Add through iteration:
- Examples when patterns aren't clear from description
- Edge cases when observed in real usage
- Advanced features when users need them
- Reference files when SKILL.md approaches 500 lines
- Validation scripts when errors are common
</iteration_additions>

<benefits>
- Faster to initial working version
- Additions solve real needs, not imagined ones
- Keeps skills focused and concise
- Progressive disclosure emerges naturally
- Documentation stays aligned with actual usage
</benefits>
</progressive_refinement>

<testing_discovery>
<principle>
Test that Claude can discover and use your skill when appropriate.
</principle>

<discovery_testing>
<test_description>
Test if Claude loads your skill when it should:

1. Start fresh conversation (Claude B)
2. Ask question that should trigger skill
3. Check if skill was loaded
4. Verify skill was used appropriately
</test_description>

<description_quality>
If skill isn't discovered:
- Check description includes trigger keywords
- Verify description is specific, not vague
- Ensure description explains when to use skill
- Test with different phrasings of the same request

The description is Claude's primary discovery mechanism.
</description_quality>
</discovery_testing>
</testing_discovery>

<common_iteration_patterns>
<pattern name="too_verbose">
**Observation**: Skill works but uses lots of tokens

**Fix**:
- Remove obvious explanations
- Assume Claude knows common concepts
- Use examples instead of lengthy descriptions
- Move advanced content to reference files
</pattern>

<pattern name="too_minimal">
**Observation**: Claude makes incorrect assumptions or misses steps

**Fix**:
- Add explicit instructions where assumptions fail
- Provide complete working examples
- Define edge cases
- Add validation steps
</pattern>

<pattern name="poor_discovery">
**Observation**: Skill exists but Claude doesn't load it when needed

**Fix**:
- Improve description with specific triggers
- Add relevant keywords
- Test description against actual user queries
- Make description more specific about use cases
</pattern>

<pattern name="unclear_structure">
**Observation**: Claude reads wrong sections or misses relevant content

**Fix**:
- Use clearer XML tag names
- Reorganize content hierarchy
- Move frequently-needed content earlier
- Add explicit links to relevant sections
</pattern>

<pattern name="incomplete_examples">
**Observation**: Claude produces outputs that don't match expected pattern

**Fix**:
- Add more examples showing pattern
- Make examples more complete
- Show edge cases in examples
- Add anti-pattern examples (what not to do)
</pattern>
</common_iteration_patterns>

<iteration_velocity>
<principle>
Small, frequent iterations beat large, infrequent rewrites.
</principle>

<fast_iteration>
**Good approach**:
1. Make one targeted change
2. Test on specific scenario
3. Verify improvement
4. Commit change
5. Move to next issue

Total time: Minutes per iteration
Iterations per day: 10-20
Learning rate: High
</fast_iteration>

<slow_iteration>
**Problematic approach**:
1. Accumulate many issues
2. Make large refactor
3. Test everything at once
4. Debug multiple issues simultaneously
5. Hard to know what fixed what

Total time: Hours per iteration
Iterations per day: 1-2
Learning rate: Low
</slow_iteration>

<benefits_of_fast_iteration>
- Isolate cause and effect
- Build pattern recognition faster
- Less wasted work from wrong directions
- Easier to revert if needed
- Maintains momentum
</benefits_of_fast_iteration>
</iteration_velocity>

<success_metrics>
<principle>
Define how you'll measure if the skill is working. Quantify success.
</principle>

<objective_metrics>
- **Success rate**: Percentage of tasks completed correctly
- **Token usage**: Average tokens consumed per task
- **Iteration count**: How many tries to get correct output
- **Error rate**: Percentage of tasks with errors
- **Discovery rate**: How often skill loads when it should
</objective_metrics>

<subjective_metrics>
- **Output quality**: Does output meet requirements?
- **Appropriate detail**: Too verbose or too minimal?
- **Claude confidence**: Does Claude seem uncertain?
- **User satisfaction**: Does skill solve the actual problem?
</subjective_metrics>

<tracking_improvement>
Compare metrics before and after changes:
- Baseline: Measure without skill
- Initial: Measure with first version
- Iteration N: Measure after each change

Track which changes improve which metrics. Double down on effective patterns.
</tracking_improvement>
</success_metrics>
