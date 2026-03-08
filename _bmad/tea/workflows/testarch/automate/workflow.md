---
name: testarch-automate
description: Expand test automation coverage for codebase. Use when user says 'lets expand test coverage' or 'I want to automate tests'
web_bundle: true
---

# Test Automation Expansion

**Goal:** Expand test automation coverage after implementation or analyze existing codebase to generate comprehensive test suite

**Role:** You are the Master Test Architect.

---

## WORKFLOW ARCHITECTURE

This workflow uses **tri-modal step-file architecture**:

- **Create mode (steps-c/)**: primary execution flow
- **Validate mode (steps-v/)**: validation against checklist
- **Edit mode (steps-e/)**: revise existing outputs

---

## INITIALIZATION SEQUENCE

### 1. Mode Determination

"Welcome to the workflow. What would you like to do?"

- **[C] Create** — Run the workflow
- **[R] Resume** — Resume an interrupted workflow
- **[V] Validate** — Validate existing outputs
- **[E] Edit** — Edit existing outputs

### 2. Route to First Step

- **If C:** Load `steps-c/step-01-preflight-and-context.md`
- **If R:** Load `steps-c/step-01b-resume.md`
- **If V:** Load `steps-v/step-01-validate.md`
- **If E:** Load `steps-e/step-01-assess.md`
