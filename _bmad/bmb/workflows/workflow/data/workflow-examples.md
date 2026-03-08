# Novel Workflow Examples

**Purpose:** Illustrative examples across diverse domains.

---

## Workflow Structure

**Each arrow (→) = one step file. Each step file contains:**

- STEP GOAL
- MANDATORY EXECUTION RULES
- EXECUTION PROTOCOLS
- MANDATORY SEQUENCE (numbered sub-steps)
- Menu options
- Success/failure metrics

**Simple workflow:** 3-4 step files. **Complex workflow:** 10+ step files.

---

## Example 1: Personalized Meal Plan Generator

**Domain:** Health & Fitness

| Aspect                  | Details                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| **Flow**                | Discovery → Assessment → Strategy → Shopping List → Prep Schedule                           |
| **Step Files**          | ~5: step-01-discovery, step-02-assessment, step-03-strategy, step-04-shopping, step-05-prep |
| **Output**              | Direct-to-final document, each step appends section                                         |
| **Intent/Prescriptive** | Intent-based - Facilitates discovery                                                        |
| **Planning**            | No - builds directly                                                                        |
| **Continuable**         | Yes - 200+ tokens possible                                                                  |
| **Structure**           | Linear, 5 steps                                                                             |
| **Conversation**        | Open-ended, progressive questioning (1-2 at a time)                                         |

---

## Example 2: Year-End Tax Organizer

**Domain:** Finance

| Aspect                  | Details                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| **Flow**                | Input Discovery → Document Categorization → Missing Document Alert → Final Summary      |
| **Step Files**          | 4: step-01-input-discovery, step-02-categorize, step-03-missing-alerts, step-04-summary |
| **Output**              | Analysis-only + checklist                                                               |
| **Intent/Prescriptive** | Highly Prescriptive - Tax compliance, exact categories                                  |
| **Planning**            | N/A                                                                                     |
| **Continuable**         | No - single-session                                                                     |
| **Structure**           | Linear, 4 steps                                                                         |
| **Conversation**        | Focused - specific questions, document what provided                                    |

---

## Example 3: Employee Termination Checklist

**Domain:** Legal / HR / Compliance

| Aspect                  | Details                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| **Flow**                | Context → Regulatory Check → Document Requirements → Notification Timeline → Final Checklist   |
| **Step Files**          | 5: step-01-context, step-02-regulatory, step-03-documents, step-04-timeline, step-05-checklist |
| **Output**              | Direct-to-final compliance checklist                                                           |
| **Intent/Prescriptive** | Highly Prescriptive - Legal compliance, state-specific                                         |
| **Planning**            | No                                                                                             |
| **Continuable**         | No - single-session                                                                            |
| **Structure**           | Branching within steps by: reason, location, employee count                                    |
| **Conversation**        | Focused - classification questions, present requirements                                       |

---

## Example 4: Tabletop RPG Campaign Builder

**Domain:** Entertainment / Games

| Aspect                  | Details                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Flow**                | Session Concept → NPC Creation → Scene Setup → Key Beats → Generate → [Repeat per session]                     |
| **Step Files**          | 4 core files reused each session: step-01-concept, step-02-npc, step-03-scene, step-04-beats, step-05-generate |
| **Output**              | Per-session document, maintains campaign continuity                                                            |
| **Intent/Prescriptive** | Intent-based - Creative facilitation                                                                           |
| **Planning**            | No - builds directly                                                                                           |
| **Continuable**         | Yes - months-long campaigns                                                                                    |
| **Structure**           | Repeating loop - same steps, new content                                                                       |
| **Conversation**        | Open-ended creative facilitation, "What if..." prompts                                                         |

---

## Example 5: Course Syllabus Creator

**Domain:** Education

| Aspect                  | Details                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flow**                | Course Type → Learning Objectives → Module Breakdown → Assessment → [Branch: academic] → Accreditation → [Branch: vocational] → Certification → Final |
| **Output**              | Direct-to-final syllabus                                                                                                                              |
| **Intent/Prescriptive** | Balanced - Framework prescriptive, content flexible                                                                                                   |
| **Planning**            | No                                                                                                                                                    |
| **Continuable**         | Yes - complex syllabi                                                                                                                                 |
| **Structure**           | Branching by course type                                                                                                                              |
| **Conversation**        | Mixed - framework (prescriptive) + content discovery (intent)                                                                                         |

---

## Example 6: SOP Writer

**Domain:** Business Process

| Aspect                  | Details                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Flow**                | Process Selection → Scope Definition → Documentation → Review → [Generate] → "Create another?" → If yes, repeat |
| **Output**              | Independent SOPs stored in `{sop_folder}/`                                                                      |
| **Intent/Prescriptive** | Prescriptive - SOPs must be exact                                                                               |
| **Planning**            | No - direct generation                                                                                          |
| **Continuable**         | No - single SOP per run, repeatable workflow                                                                    |
| **Structure**           | Repeating - multiple SOPs per session                                                                           |
| **Conversation**        | Focused on process details - "Walk me through step 1"                                                           |

---

## Example 7: Novel Outliner

**Domain:** Creative Writing

| Aspect                  | Details                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| **Flow**                | Structure Selection → Character Arcs → Beat Breakdown → Pacing Review → Final Polish |
| **Output**              | Free-form with Final Polish for coherence                                            |
| **Intent/Prescriptive** | Intent-based - "What does your character want?"                                      |
| **Planning**            | No - builds directly                                                                 |
| **Continuable**         | Yes - weeks-long sessions                                                            |
| **Structure**           | Branching by structure choice                                                        |
| **Conversation**        | Open-ended creative coaching, provocations                                           |

---

## Example 8: Wedding Itinerary Coordinator

**Domain:** Event Planning

| Aspect                  | Details                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Flow**                | Venue Type → Vendor Coordination → Timeline → Guest Experience → [Branch: hybrid] → Virtual Setup → Day-of Schedule |
| **Output**              | Direct-to-final itinerary                                                                                           |
| **Intent/Prescriptive** | Intent-based - Facilitates vision                                                                                   |
| **Planning**            | No                                                                                                                  |
| **Continuable**         | Yes - months-long planning                                                                                          |
| **Structure**           | Branching by venue type                                                                                             |
| **Conversation**        | Open-ended discovery of preferences, budget, constraints                                                            |

---

## Example 9: Annual Life Review

**Domain:** Personal Development

| Aspect                  | Details                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Flow**                | Input Discovery (prior goals) → Life Areas Assessment → Reflections → Goal Setting → Action Planning → Final Polish |
| **Output**              | Free-form with Final Polish, discovers prior review first                                                           |
| **Intent/Prescriptive** | Intent-based - Coaching questions                                                                                   |
| **Planning**            | No - direct to life plan                                                                                            |
| **Continuable**         | Yes - deep reflection                                                                                               |
| **Structure**           | Linear with Input Discovery                                                                                         |
| **Conversation**        | Open-ended coaching, progressive questioning                                                                        |

---

## Example 10: Room Renovation Planner

**Domain:** Home Improvement

| Aspect                  | Details                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Flow**                | Room Type → Budget Assessment → Phase Planning → Materials → Contractor Timeline → [Branch: DIY] → Instructions |
| **Output**              | Direct-to-final renovation plan                                                                                 |
| **Intent/Prescriptive** | Balanced - Code compliance prescriptive, design intent-based                                                    |
| **Planning**            | No                                                                                                              |
| **Continuable**         | Yes - complex planning                                                                                          |
| **Structure**           | Branching by room type and DIY vs pro                                                                           |
| **Conversation**        | Mixed - budget questions + vision discovery                                                                     |

---

## Pattern Analysis

### Structure Types

| Type           | Count | Examples                                             |
| -------------- | ----- | ---------------------------------------------------- |
| Linear         | 5     | Meal Plan, Tax, Termination, Life Review, Renovation |
| Branching      | 5     | Termination, Syllabus, Novel, Wedding, Renovation    |
| Repeating Loop | 2     | RPG Campaign, SOP Writer                             |

### Intent Spectrum

| Type         | Count | Examples                                                                              |
| ------------ | ----- | ------------------------------------------------------------------------------------- |
| Intent-based | 7     | Meal Plan, RPG, Syllabus (partial), Novel, Wedding, Life Review, Renovation (partial) |
| Prescriptive | 3     | Tax, Termination, SOP                                                                 |
| Balanced     | 2     | Syllabus, Renovation                                                                  |

### Continuable vs Single-Session

| Type           | Count | Examples                                                          |
| -------------- | ----- | ----------------------------------------------------------------- |
| Continuable    | 7     | Meal Plan, RPG, Syllabus, Novel, Wedding, Life Review, Renovation |
| Single-Session | 3     | Tax, Termination, SOP                                             |

### Output Patterns

| Type              | Count | Examples                       |
| ----------------- | ----- | ------------------------------ |
| Direct-to-Final   | 9     | All except Tax                 |
| Analysis Only     | 1     | Tax                            |
| With Final Polish | 2     | Novel, Life Review             |
| Repeating Output  | 2     | RPG (sessions), SOP (multiple) |

---

## Design Questions

1. **Domain:** Problem space?
2. **Output:** What is produced? (Document, checklist, analysis, physical?)
3. **Intent:** Prescriptive (compliance) or intent-based (creative)?
4. **Planning:** Plan-then-build or direct-to-final?
5. **Continuable:** Multiple sessions or high token count?
6. **Structure:** Linear, branching, or repeating loop?
7. **Inputs:** Requires prior workflow documents or external sources?
8. **Chaining:** Part of module sequence? What comes before/after?
9. **Polish:** Final output need optimization for flow/coherence?
10. **Conversation:** Focused questions or open-ended facilitation?
