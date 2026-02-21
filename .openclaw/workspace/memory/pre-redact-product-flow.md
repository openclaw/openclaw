# Pre-Redact — Product Flow (from video demos)

> Source: Two screen recording demos sent by Donny (Feb 2026)
> Videos captured at 384×832 (portrait, likely iPhone screen recording)

---

## What It Is

**Pre-Redact** is a document redaction + AI chat platform. It auto-detects PII/sensitive entities in a document, lets users selectively redact them, and then enables AI-powered document editing — all while the AI never sees the redacted content.

---

## Core UI Layout

**Two-panel interface:**

- **Left panel:** Document view / entity sidebar (redaction controls)
- **Right panel:** AI Chat

**Top navigation bar (dark):**

- Pre-Redact logo + "PRE-REDACT" label
- "+" button
- "⚙ AI Chat" tab
- "↻ Start Over"
- Blue circular user avatar

---

## Full User Flow

### Step 1: Upload Screen

- Heading: "Upload Your Document"
- Subheading: "Paste text or upload a file to automatically detect and redact sensitive information."
- Animated preview shows sample document with detected entities highlighted
- Action buttons:
  - **"Upload File"** — upload from filesystem
  - **"Enter Sensitive Text"** — paste directly
  - **"Copy"** and **"Redact"** quick actions
- Badge indicators (e.g., "15") showing detected item count

---

### Step 2: Templates (Optional)

- **"My Templates"** modal accessible from Upload screen
- Saved templates listed (e.g., "operating agre...", "unified-agent-workflo...")
- Buttons: **"Browse Templates"** | **"Select"** (blue)
- Selecting a template loads a pre-configured document with associated PII field mappings

**Template document example seen in demo:**

- Template name: "Operating agreement Global 5000 T7-WISH (1) Template"
- Left sidebar shows: AI PII input field, PROFILE section, LOCATIONS (CITY, STREET fields)
- Document: **Aircraft Operating Agreement** between **ExecuJet Middle East Co. L.L.C.** (Operator) and **AIX Holding Limited**
- 11-page document (page indicator "1/11")
- **"Template Editor"** button for editing template rules

---

### Step 3: Auto-Detection Results

After uploading/selecting a template, the system auto-detects sensitive entities:

**Left sidebar entity panel:**

- Detection count: e.g., **"11/11"** (all selected by default)
- Bulk actions:
  - **"Select All"** (green/teal)
  - **"Reveal All"** (red)

**Entity categories (with colored indicators + counts):**

1. **👤 Names** — [GIVENNAME], [SURNAME] pairs
2. **💰 Financial** — [SOCIALNUM], [ACCOUNTNUM], [CURRENCY]
3. **📧 Contact** — phone numbers, emails
4. **🔑 Identifiers** — policy numbers, IDs
5. **📍 Locations** — [CITY], [BUILDINGNUMB], [STREET]

**Redaction placeholder format:** `[ENTITYTYPE]` e.g., `[GIVENNAME]`, `[SURNAME]`, `[ACCOUNTNUM]`, `[TELEPHONENUMB]`, `[SOCIALNUMB]`, `[EMAIL]`

**Right panel (document preview):**

- Live document with colored bracket tags on detected entities
- **"⬇ Copy"** button at top

---

### Step 4: Selective Redaction (Granular Control)

User can toggle individual entities ON/OFF:

- Deselecting items reveals the actual value (shown in yellow/gold highlight)
- Counter updates: e.g., 11/11 → 8/11 after revealing 3 names
- Revealed names in demo: **Sarah, Margaret, Thompson** (actual names shown, yellow)
- Others remain redacted as placeholder tokens

**Bottom action button:** **"Preview Redaction"** → **"Redact All"**

---

### Step 5: Continue to AI Chat

Confirmation modal: **"Continue to AI Chat"**

- Section: REDACTION showing count (e.g., **"11"** items redacted)
- Message: _"This AI will have access to the full document except the [N] redacted items."_
- Buttons: **"Cancel"** | **"Continue to Chat"** (blue, with arrow)

---

### Step 6: AI Chat Interface

Once in AI Chat, the right panel becomes the conversation:

**Chat header:**

- Model selector dropdown: e.g., **"🔮 Claude Sonnet 4.5"**
- Status indicators:
  - 🟢 Redacted: [N]
  - 🟢 Reviewed
  - 🟢 Complete

**Initial AI message:**

> "I can help you with questions about the redacted document and also edit it. Please check the suggestions below."

**Suggestion chips (contextual, updates after each interaction):**

- "Summarize this document"
- "What is this about?"
- "Add a summary table"
- "Add a heading above the summary"
- "Add a follow-up paragraph with next steps"
- "Reformat the full document"
- "Remove the summary section"
- "Add a confidentiality disclaimer at the bottom"
- "Adjust the sign-off name or title"

**Input field:** "Ask AI about your redacted..."

**⚡ Thinking mode** toggle — for enhanced reasoning on complex tasks

---

### Step 7: AI Document Editing (Iterative)

The AI can edit the actual document in the left panel while the user chats:

**Example interaction seen in demo:**

1. User clicks "Summarize this document" →
   AI appends a 3-bullet summary to the document:
   - _Appointment Confirmation_ — date, location
   - _Account Details on File_ — account# and SSN
   - _Contact & Insurance Info_ — phone, email, insurance

2. User switches model to **Claude Opus 4.0** →
   AI generates expanded 5-bullet summary

3. User requests formal letter reformat →
   AI transforms the document into a proper **Appointment Confirmation Letter**:
   - Formal heading: "Appointment Confirmation Letter"
   - "Dear Dr. [GIVENNAME] [SURNAME],"
   - "Re: Appointment Confirmation – March 15, 2028"
   - Full formal body with all PII preserved as placeholders
   - Insurance section: Provider: Blue Cross | Policy Number: BC-2036-449162
   - Sign-off: "[GIVENNAME] [SURNAME] | Patient Services"

**Key behavior:** AI NEVER guesses or fills in the redacted values — all placeholders remain intact throughout all edits.

---

## AI Model Support

**Available models (seen in model selector dropdown):**

| Provider  | Model                                                |
| --------- | ---------------------------------------------------- |
| OpenAI    | GPT-4O-MINI                                          |
| OpenAI    | GPT-4O                                               |
| OpenAI    | GPT-4-TURBO                                          |
| Anthropic | Claude Opus 4.0                                      |
| Anthropic | Claude Sonnet 4.5 _(default, highlighted in purple)_ |
| Anthropic | Claude Haiku 3.5 / 4.5                               |

- Search field: "Search models..."
- "🔄 Refresh available models" option
- Model can be switched mid-session

---

## Sample Document Used in Demos

**Medical appointment confirmation letter (anonymized):**

> "Dear Dr. [GIVENNAME] [SURNAME], this confirms your appointment on March [DATE] at [CITY] office [BUILDINGNUMB] [STREET]. Your account number [ACCOUNTNUM] [SOCIALNUMB] are on file. Contact [GIVENNAME] [SURNAME] at [TELEPHONE] for questions. Insurance: Blue Cross policy BC-3038-449982"

---

## Key Product Differentiators

1. **Privacy-preserving AI editing** — document is redacted BEFORE going to the AI; AI never sees PII
2. **Granular entity control** — toggle individual entities, not just all-or-nothing
3. **Multi-model support** — choose the best model for the task, switch mid-session
4. **Thinking mode** — enhanced reasoning for complex documents
5. **Templates** — save redaction profiles for recurring document types (contracts, agreements, workflows)
6. **Iterative AI suggestions** — AI proposes next editing steps after each action
7. **Copy functionality** — copy redacted document at any stage

---

## Target Market

- 78% of institutions cannot use AI due to sensitive data concerns
- Pre-Redact is the on-ramp for regulated industries: **healthcare, legal, finance**
- Documents seen in demos: medical letters, aircraft operating agreements (ExecuJet / AIX Holding)
