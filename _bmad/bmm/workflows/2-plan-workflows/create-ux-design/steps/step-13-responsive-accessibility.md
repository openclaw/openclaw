# Step 13: Responsive Design & Accessibility

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between UX facilitator and stakeholder
- 📋 YOU ARE A UX FACILITATOR, not a content generator
- 💬 FOCUS on responsive design strategy and accessibility compliance
- 🎯 COLLABORATIVE strategy definition, not assumption-based design
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present A/P/C menu after generating responsive/accessibility content
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update output file frontmatter, adding this step to the end of the list of stepsCompleted.
- 🚫 FORBIDDEN to load next step until C is selected

## COLLABORATION MENUS (A/P/C):

This step will generate content and present choices:

- **A (Advanced Elicitation)**: Use discovery protocols to develop deeper responsive/accessibility insights
- **P (Party Mode)**: Bring multiple perspectives to define responsive/accessibility strategy
- **C (Continue)**: Save the content to the document and proceed to final step

## PROTOCOL INTEGRATION:

- When 'A' selected: Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml
- When 'P' selected: Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md
- PROTOCOLS always return to this step's A/P/C menu
- User accepts/rejects protocol changes before proceeding

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- Platform requirements from step 3 inform responsive design
- Design direction from step 9 influences responsive layout choices
- Focus on cross-device adaptation and accessibility compliance

## YOUR TASK:

Define responsive design strategy and accessibility requirements for the product.

## RESPONSIVE & ACCESSIBILITY SEQUENCE:

### 1. Define Responsive Strategy

Establish how the design adapts across devices:
"Let's define how {{project_name}} adapts across different screen sizes and devices.

**Responsive Design Questions:**

**Desktop Strategy:**

- How should we use extra screen real estate?
- Multi-column layouts, side navigation, or content density?
- What desktop-specific features can we include?

**Tablet Strategy:**

- Should we use simplified layouts or touch-optimized interfaces?
- How do gestures and touch interactions work on tablets?
- What's the optimal information density for tablet screens?

**Mobile Strategy:**

- Bottom navigation or hamburger menu?
- How do layouts collapse on small screens?
- What's the most critical information to show mobile-first?"

### 2. Establish Breakpoint Strategy

Define when and how layouts change:
"**Breakpoint Strategy:**
We need to define screen size breakpoints where layouts adapt.

**Common Breakpoints:**

- Mobile: 320px - 767px
- Tablet: 768px - 1023px
- Desktop: 1024px+

**For {{project_name}}, should we:**

- Use standard breakpoints or custom ones?
- Focus on mobile-first or desktop-first design?
- Have specific breakpoints for your key use cases?"

### 3. Design Accessibility Strategy

Define accessibility requirements and compliance level:
"**Accessibility Strategy:**
What level of WCAG compliance does {{project_name}} need?

**WCAG Levels:**

- **Level A (Basic)** - Essential accessibility for legal compliance
- **Level AA (Recommended)** - Industry standard for good UX
- **Level AAA (Highest)** - Exceptional accessibility (rarely needed)

**Based on your product:**

- [Recommendation based on user base, legal requirements, etc.]

**Key Accessibility Considerations:**

- Color contrast ratios (4.5:1 for normal text)
- Keyboard navigation support
- Screen reader compatibility
- Touch target sizes (minimum 44x44px)
- Focus indicators and skip links"

### 4. Define Testing Strategy

Plan how to ensure responsive design and accessibility:
"**Testing Strategy:**

**Responsive Testing:**

- Device testing on actual phones/tablets
- Browser testing across Chrome, Firefox, Safari, Edge
- Real device network performance testing

**Accessibility Testing:**

- Automated accessibility testing tools
- Screen reader testing (VoiceOver, NVDA, JAWS)
- Keyboard-only navigation testing
- Color blindness simulation testing

**User Testing:**

- Include users with disabilities in testing
- Test with diverse assistive technologies
- Validate with actual target devices"

### 5. Document Implementation Guidelines

Create specific guidelines for developers:
"**Implementation Guidelines:**

**Responsive Development:**

- Use relative units (rem, %, vw, vh) over fixed pixels
- Implement mobile-first media queries
- Test touch targets and gesture areas
- Optimize images and assets for different devices

**Accessibility Development:**

- Semantic HTML structure
- ARIA labels and roles
- Keyboard navigation implementation
- Focus management and skip links
- High contrast mode support"

### 6. Generate Responsive & Accessibility Content

Prepare the content to append to the document:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Responsive Design & Accessibility

### Responsive Strategy

[Responsive strategy based on conversation]

### Breakpoint Strategy

[Breakpoint strategy based on conversation]

### Accessibility Strategy

[Accessibility strategy based on conversation]

### Testing Strategy

[Testing strategy based on conversation]

### Implementation Guidelines

[Implementation guidelines based on conversation]
```

### 7. Present Content and Menu

Show the generated responsive and accessibility content and present choices:
"I've defined the responsive design and accessibility strategy for {{project_name}}. This ensures your product works beautifully across all devices and is accessible to all users.

**Here's what I'll add to the document:**

[Show the complete markdown content from step 6]

**What would you like to do?**
[A] Advanced Elicitation - Let's refine our responsive/accessibility strategy
[P] Party Mode - Bring different perspectives on inclusive design
[C] Continue - Save this to the document and complete the workflow

### 8. Handle Menu Selection

#### If 'A' (Advanced Elicitation):

- Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml with the current responsive/accessibility content
- Process the enhanced insights that come back
- Ask user: "Accept these improvements to the responsive/accessibility strategy? (y/n)"
- If yes: Update content with improvements, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'P' (Party Mode):

- Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md with the current responsive/accessibility strategy
- Process the collaborative insights that come back
- Ask user: "Accept these changes to the responsive/accessibility strategy? (y/n)"
- If yes: Update content with improvements, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'C' (Continue):

- Append the final content to `{planning_artifacts}/ux-design-specification.md`
- Update frontmatter: append step to end of stepsCompleted array
- Load `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-14-complete.md`

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 6.

## SUCCESS METRICS:

✅ Responsive strategy clearly defined for all device types
✅ Appropriate breakpoint strategy established
✅ Accessibility requirements determined and documented
✅ Comprehensive testing strategy planned
✅ Implementation guidelines provided for development team
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Not considering all device types and screen sizes
❌ Accessibility requirements not properly researched
❌ Testing strategy not comprehensive enough
❌ Implementation guidelines too generic or unclear
❌ Not addressing specific accessibility challenges for your product
❌ Not presenting A/P/C menu after content generation
❌ Appending content without user selecting 'C'

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C' and content is saved to document, load `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-14-complete.md` to finalize the UX design workflow.

Remember: Do NOT proceed to step-14 until user explicitly selects 'C' from the A/P/C menu and content is saved!
