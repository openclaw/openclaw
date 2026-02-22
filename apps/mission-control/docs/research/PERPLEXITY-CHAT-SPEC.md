# Perplexity AI Chat Interface Specification

> **Research Date:** February 2026  
> **Purpose:** Feature analysis for Mission Control implementation  
> **Sources:** Wikipedia, Zapier, Medium, official Perplexity documentation, user reports

---

## Executive Summary

Perplexity AI is an AI-powered search engine that combines conversational AI with real-time web search. Unlike traditional chatbots, it provides cited, sourced answers with inline references. This document analyzes its chat interface for potential adaptation in Mission Control.

---

## 1. Chat Input Features

### 1.1 Main Input Component

**Visual Description:**
- Clean, centered text input with rounded corners
- Placeholder text: "Ask anything..."
- Expands vertically as user types (multi-line support)
- Submit button (arrow icon) appears on right when text is entered

**Component Breakdown:**
```
┌─────────────────────────────────────────────────────────────┐
│ [📎] Ask anything...                              [🎤] [➤] │
│ ─────────────────────────────────────────────────────────── │
│ [Focus: All ▾]  [Attach]  [Pro Search toggle]              │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 File Upload Features

| Feature | Description | Supported Types |
|---------|-------------|-----------------|
| **Document Upload** | Click paperclip or drag-drop | PDF, Word, Excel, TXT, CSV |
| **Image Upload** | Inline or via button | JPG, PNG, GIF, WebP |
| **Multi-file** | Upload multiple files at once | Up to 5 files (Pro) |
| **Internal Knowledge** | Search uploaded docs alongside web | Pro/Enterprise feature |

**Upload States:**
1. **Idle:** Paperclip icon, subtle
2. **Hover:** Icon highlights, tooltip "Attach files"
3. **Uploading:** Progress indicator replaces icon
4. **Uploaded:** File chip appears above input with filename + remove button
5. **Error:** Red border, error message toast

### 1.3 @ Mentions & Context

Perplexity uses **Focus modes** rather than @ mentions:
- No traditional @ mention system for users/sources
- Focus dropdown acts as context selector
- Spaces feature allows mentioning shared context/collaborators

### 1.4 Voice Input

- Microphone button for voice-to-text
- Uses browser speech recognition API
- Visual waveform animation during recording

**Implementation Recommendations:**
```typescript
interface ChatInput {
  placeholder: string;
  maxLength?: number;
  attachments: Attachment[];
  focus: FocusMode;
  isProSearch: boolean;
  onSubmit: (query: string, attachments: Attachment[]) => void;
  onVoiceInput?: () => void;
}
```

---

## 2. Sources & Citations Display

### 2.1 Inline Citation System

**Visual Pattern:**
- Superscript numbers [1], [2], [3] appear inline within response text
- Numbers are clickable, linking to source panel
- Color-coded: typically blue/purple like standard hyperlinks

**Example Response:**
```
Zone 2 training improves mitochondrial function[1] and increases
fat oxidation[2]. Studies show a 15-20% improvement in aerobic
capacity over 8 weeks[3].
```

### 2.2 Source Panel/Cards

**Desktop Layout:**
```
┌──────────────────────────────────────────────┐
│ Sources (5)                                   │
├──────────────────────────────────────────────┤
│ [1] 🌐 healthline.com                        │
│     "Zone 2 Training: Benefits and How..."   │
│                                              │
│ [2] 📄 pubmed.gov                            │
│     "Effects of moderate-intensity..."       │
│                                              │
│ [3] 🎓 journals.physiology.org              │
│     "Mitochondrial adaptations to..."        │
└──────────────────────────────────────────────┘
```

**Source Card Components:**
- **Favicon:** Site icon for quick recognition
- **Domain:** Truncated URL showing primary domain
- **Title:** Article/page title (truncated with ellipsis)
- **Snippet:** Brief excerpt (optional, on hover/expand)
- **Type Badge:** 🎓 Academic, 📰 News, 🛒 Shopping, etc.

### 2.3 Citation Interaction

| Action | Behavior |
|--------|----------|
| **Hover on [n]** | Tooltip preview of source |
| **Click on [n]** | Scrolls source panel to that source |
| **Click source card** | Opens source URL in new tab |
| **View All** | Expands collapsed source list |

**Implementation Recommendations:**
```typescript
interface Citation {
  index: number;
  sourceUrl: string;
  domain: string;
  title: string;
  snippet?: string;
  type: 'web' | 'academic' | 'news' | 'social' | 'video';
  favicon?: string;
}

interface ResponseWithCitations {
  content: string; // Markdown with [n] references
  citations: Citation[];
  searchQueries?: string[]; // What Perplexity searched for
}
```

---

## 3. Chat History Sidebar

### 3.1 Layout Structure

**Desktop Sidebar (Left):**
```
┌─────────────────────────┐
│ 🔍 Perplexity           │
│ [+ New Thread]          │
├─────────────────────────┤
│ 📚 Library              │
│   └─ Threads            │
│   └─ Collections        │
│   └─ Pages              │
├─────────────────────────┤
│ 🕐 Recent               │
│ ├─ Today                │
│ │  └─ "Zone 2 training" │
│ │  └─ "React hooks..."  │
│ ├─ Yesterday            │
│ │  └─ "Best coffee..."  │
│ ├─ Previous 7 Days      │
│ │  └─ ...               │
├─────────────────────────┤
│ ⭐ Spaces               │
│   └─ Research Project   │
│   └─ Work               │
├─────────────────────────┤
│ ⚙️ Settings             │
│ 👤 Profile              │
└─────────────────────────┘
```

### 3.2 Thread Entry Components

Each thread entry displays:
- **Title:** Auto-generated from first query (truncated)
- **Timestamp:** Relative time (Today, Yesterday) or date
- **Preview:** First line of query (subtle, truncated)
- **Actions (on hover):** Delete, Share, Add to Collection

### 3.3 Sidebar Behavior

| State | Behavior |
|-------|----------|
| **Desktop** | Always visible, collapsible |
| **Tablet** | Overlay on hamburger click |
| **Mobile** | Full-screen overlay |
| **Collapsed** | Icon-only rail (Pro feature) |

### 3.4 Search Within History

- Search bar at top of sidebar
- Filters threads by title/content match
- Keyboard shortcut: `Cmd/Ctrl + K`

---

## 4. "Searching the Web" Progress Indicator

### 4.1 Visual States

**State Sequence:**
1. **Initiating:** "Understanding your question..."
2. **Searching:** "Searching the web..." with animated dots
3. **Reading:** "Reading [n] sources..." with source previews appearing
4. **Analyzing:** "Analyzing information..."
5. **Generating:** Response starts streaming

**Visual Design:**
```
┌─────────────────────────────────────────────┐
│ 🔄 Searching the web...                     │
│ ━━━━━━━━━━░░░░░░░░░░░░░░░░░░░░░░░░░ 35%    │
│                                             │
│ Found sources:                              │
│ [healthline.com] [pubmed.gov] [...]         │
└─────────────────────────────────────────────┘
```

### 4.2 Pro Search Deep Dive

For Pro Search queries, expanded progress:
- Shows clarifying questions (optional)
- Lists search queries being performed
- Displays source discovery in real-time
- Numbered steps with checkmarks on completion

**Example:**
```
✓ 1. Understanding your question
✓ 2. Searching: "zone 2 training benefits"
✓ 3. Searching: "mitochondrial adaptation exercise"
● 4. Reading 12 sources...
○ 5. Generating comprehensive answer
```

### 4.3 Cancelation

- Cancel button appears during search
- Partial results shown if cancelled mid-search
- Clear feedback: "Search cancelled"

**Implementation Recommendations:**
```typescript
interface SearchProgress {
  phase: 'understanding' | 'searching' | 'reading' | 'analyzing' | 'generating';
  queries?: string[];
  sourcesFound?: SourcePreview[];
  progress?: number; // 0-100
  canCancel: boolean;
}
```

---

## 5. Follow-up Questions / Suggested Prompts

### 5.1 Placement & Design

**Location:** Below each AI response, before next input area

**Visual Layout:**
```
┌─────────────────────────────────────────────┐
│ [AI Response content...]                    │
│                                             │
│ Related                                     │
│ ┌─────────────────┐ ┌─────────────────────┐ │
│ │ What are the    │ │ How do I measure    │ │
│ │ risks of over-  │ │ my heart rate for   │ │
│ │ training?       │ │ Zone 2?             │ │
│ └─────────────────┘ └─────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ Compare Zone 2 vs HIIT for weight loss  │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 5.2 Characteristics

| Property | Value |
|----------|-------|
| **Count** | 2-4 suggestions typically |
| **Layout** | Responsive grid/flex, wraps |
| **Style** | Pill/chip buttons, subtle border |
| **Interaction** | Click to submit as new query |
| **Generation** | Context-aware, based on response |

### 5.3 Suggestion Types

1. **Clarifying Questions:** Dig deeper into current topic
2. **Related Topics:** Adjacent areas of interest
3. **Practical Applications:** "How to" follow-ups
4. **Comparisons:** "X vs Y" queries

**Implementation Recommendations:**
```typescript
interface SuggestedPrompt {
  text: string;
  category: 'clarify' | 'related' | 'howto' | 'compare';
}

// Generate 3-4 suggestions after each response
const suggestions = await generateSuggestions(response, context);
```

---

## 6. Code Block Rendering

### 6.1 Syntax Highlighting

- Full syntax highlighting for 50+ languages
- Language auto-detection
- Manual language override available

### 6.2 Code Block Components

```
┌─ python ──────────────────────────────────┬──────┐
│                                           │ 📋   │
│ def zone2_heart_rate(age: int) -> tuple:  │      │
│     max_hr = 220 - age                    │      │
│     zone2_low = int(max_hr * 0.6)         │      │
│     zone2_high = int(max_hr * 0.7)        │      │
│     return (zone2_low, zone2_high)        │      │
│                                           │      │
└───────────────────────────────────────────┴──────┘
```

**Elements:**
- **Language Badge:** Top-left, indicates detected/specified language
- **Copy Button:** Top-right, clipboard icon
- **Line Numbers:** Optional, subtle gray
- **Horizontal Scroll:** For long lines
- **Word Wrap Toggle:** Available in settings

### 6.3 Copy Button Behavior

| State | Visual | Duration |
|-------|--------|----------|
| **Default** | 📋 Copy icon | - |
| **Hover** | Highlighted, tooltip "Copy code" | - |
| **Clicked** | ✓ Checkmark, "Copied!" | 2 seconds |
| **Error** | ❌ "Failed to copy" | 2 seconds |

### 6.4 Multi-Block Handling

- Sequential code blocks maintain independent copy buttons
- "Copy All" option when multiple related blocks
- Execution context awareness (shows output blocks differently)

**Implementation Recommendations:**
```typescript
interface CodeBlock {
  language: string;
  code: string;
  filename?: string;
  showLineNumbers: boolean;
  highlightLines?: number[];
}

// Use Prism.js or Shiki for highlighting
// Implement copy with navigator.clipboard API with fallback
```

---

## 7. Image Display in Conversations

### 7.1 User-Uploaded Images

**Display:**
- Thumbnail preview in chat (max ~300px width)
- Click to expand in lightbox/modal
- Maintains aspect ratio
- Shows filename on hover

### 7.2 AI-Generated Images

Perplexity can generate images via DALL-E integration:
- Displayed inline in response
- Multiple images in carousel/grid
- Download button on hover
- Regenerate option

### 7.3 Image Search Results

When response includes relevant images from web:
```
┌──────────────────────────────────────────────┐
│ Images                                        │
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐             │
│ │     │ │     │ │     │ │     │ [View more] │
│ │ 📷  │ │ 📷  │ │ 📷  │ │ 📷  │             │
│ └─────┘ └─────┘ └─────┘ └─────┘             │
│ Source: healthline.com                       │
└──────────────────────────────────────────────┘
```

### 7.4 Image Interaction

| Action | Result |
|--------|--------|
| **Click** | Open in lightbox |
| **Right-click** | Context menu: Save, Copy, Search |
| **Hover** | Show source attribution |
| **Drag** | Download or open in new tab |

---

## 8. Focus Modes

### 8.1 Available Focus Modes

| Mode | Icon | Description | Source Priority |
|------|------|-------------|-----------------|
| **All** | 🌐 | Default web search | Balanced |
| **Academic** | 🎓 | Scholarly sources | PubMed, arXiv, journals |
| **Writing** | ✍️ | Creative assistance | Writing guides, examples |
| **Wolfram** | 🔢 | Computational | Wolfram Alpha integration |
| **YouTube** | ▶️ | Video content | YouTube transcripts |
| **Reddit** | 💬 | Community discussions | Reddit posts/comments |
| **Social** | 📱 | Social media posts | Twitter/X, etc. |
| **Finance** | 📈 | Financial data | SEC filings, market data |
| **Travel** | ✈️ | Travel information | Booking sites, guides |

### 8.2 Focus Mode UI

**Selector Design:**
```
┌─────────────────────────┐
│ Focus: All        ▾     │
└─────────────────────────┘
         │
         ▼
┌─────────────────────────┐
│ 🌐 All                  │
│ 🎓 Academic             │
│ ✍️ Writing              │
│ 🔢 Wolfram|Alpha        │
│ ▶️ YouTube              │
│ 💬 Reddit               │
│ ─────────────────────── │
│ 📈 Finance              │
│ ✈️ Travel               │
└─────────────────────────┘
```

### 8.3 Focus Mode Behavior

- Persists for entire thread once selected
- Can be changed mid-conversation
- Affects source filtering, not AI model
- Some modes require Pro subscription

**Implementation Recommendations:**
```typescript
type FocusMode = 
  | 'all' 
  | 'academic' 
  | 'writing' 
  | 'wolfram' 
  | 'youtube' 
  | 'reddit'
  | 'social'
  | 'finance'
  | 'travel';

interface FocusModeConfig {
  mode: FocusMode;
  icon: string;
  label: string;
  sourceFilter: string[];
  requiresPro: boolean;
}
```

---

## 9. Collections / Saved Chats Organization

### 9.1 Organizational Hierarchy

```
Library
├── Threads (all conversations)
├── Collections (user-created folders)
│   ├── "Research Project"
│   │   ├── Thread 1
│   │   └── Thread 2
│   └── "Recipes"
│       └── Thread 3
├── Pages (published content)
└── Spaces (collaborative)
    └── "Team Research"
```

### 9.2 Collections Features

| Feature | Description |
|---------|-------------|
| **Create** | New Collection button, name input |
| **Add Thread** | Drag-drop or context menu |
| **Rename** | Click title to edit inline |
| **Delete** | Requires confirmation |
| **Share** | Generate shareable link |
| **Color/Icon** | Customizable identifiers |

### 9.3 Spaces (Collaborative)

- Shared collections for teams
- Invite members via email
- Permission levels: View, Comment, Edit
- AI context can reference Space contents
- Enterprise/Pro feature

### 9.4 Pages (Published Content)

- Convert thread to formatted article
- Public or private sharing
- Custom styling options
- SEO metadata editing
- Embeddable widget generation

**Implementation Recommendations:**
```typescript
interface Collection {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  threads: Thread[];
  createdAt: Date;
  updatedAt: Date;
}

interface Space extends Collection {
  members: SpaceMember[];
  isPublic: boolean;
  settings: SpaceSettings;
}
```

---

## 10. Mobile vs Desktop Differences

### 10.1 Layout Comparison

| Element | Desktop | Mobile |
|---------|---------|--------|
| **Sidebar** | Always visible, collapsible | Hidden, hamburger menu |
| **Input** | Bottom-fixed, wide | Bottom-fixed, full-width |
| **Sources** | Side panel or inline | Collapsible accordion |
| **Focus selector** | Dropdown in input area | Top bar or sheet |
| **Code blocks** | Horizontal scroll | Horizontal scroll + expand |
| **Images** | Grid layout | Single column |
| **Suggestions** | Horizontal pills | Vertical stack |

### 10.2 Mobile-Specific Features

- **Swipe gestures:** Swipe to access history
- **Voice-first:** Prominent mic button
- **Share sheet:** Native OS share integration
- **Camera input:** Direct photo capture for visual queries
- **Haptic feedback:** On interactions
- **Pull-to-refresh:** In thread list

### 10.3 Desktop-Specific Features

- **Keyboard shortcuts:**
  - `Cmd/Ctrl + K`: Search history
  - `Cmd/Ctrl + N`: New thread
  - `Cmd/Ctrl + Shift + C`: Copy response
  - `Esc`: Clear input
- **Multi-column:** Source panel + response side-by-side
- **Drag-and-drop:** Files, threads to collections
- **Browser extensions:** Chrome, Firefox integration

### 10.4 Responsive Breakpoints

```css
/* Perplexity approximate breakpoints */
@media (max-width: 640px)  { /* Mobile */ }
@media (max-width: 1024px) { /* Tablet */ }
@media (min-width: 1025px) { /* Desktop */ }
@media (min-width: 1440px) { /* Wide desktop - source panel always visible */ }
```

### 10.5 Mobile App Features (iOS/Android)

- **Widgets:** Quick search from home screen
- **Shortcuts/Actions:** Siri Shortcuts, Android Actions
- **Offline:** View cached threads
- **Notifications:** Thread updates, Space mentions
- **Biometric lock:** Face ID / fingerprint for sensitive Spaces

---

## 11. Additional Features

### 11.1 Research & Labs Modes

**Research Mode:**
- Extended search depth (more sources)
- Multi-query synthesis
- Longer, report-style outputs
- Progress shows multiple search phases

**Labs Mode:**
- Document generation (slides, dashboards)
- Structured output formatting
- Export options (PDF, DOCX, PPTX)

### 11.2 Model Selection (Pro)

Available models:
- GPT-5, GPT-4.1, o4-mini (OpenAI)
- Claude 4.0 (Anthropic)
- Gemini Pro 3 (Google)
- Grok 4 (xAI)
- Sonar (Perplexity's own, based on Llama)
- R1 1776 (based on DeepSeek R1)

### 11.3 Tasks (Scheduled Reports)

- Schedule recurring searches
- Delivery via email or in-app
- Customizable frequency (daily, weekly, monthly)
- Topic monitoring and alerts

### 11.4 Discover Feed

- Curated trending topics
- Personalized based on search history
- Pre-generated summaries on current events
- Quick-access to popular threads

---

## 12. Implementation Recommendations for Mission Control

### 12.1 Priority Features (High Impact)

1. **Inline Citations** - Critical differentiator for AI search
2. **Search Progress** - User trust and transparency
3. **Suggested Prompts** - Engagement and discoverability
4. **Code Copy Button** - Developer essential
5. **Thread Organization** - Power user retention

### 12.2 Technical Considerations

```typescript
// Suggested component architecture
components/
├── chat/
│   ├── ChatInput/
│   │   ├── AttachmentButton.tsx
│   │   ├── FocusSelector.tsx
│   │   ├── VoiceInput.tsx
│   │   └── index.tsx
│   ├── ChatMessage/
│   │   ├── CitationLink.tsx
│   │   ├── CodeBlock.tsx
│   │   ├── ImageDisplay.tsx
│   │   ├── SourcePanel.tsx
│   │   └── index.tsx
│   ├── SearchProgress/
│   │   ├── ProgressSteps.tsx
│   │   ├── SourceDiscovery.tsx
│   │   └── index.tsx
│   └── SuggestedPrompts/
│       └── index.tsx
├── sidebar/
│   ├── ThreadList.tsx
│   ├── Collections.tsx
│   └── SearchHistory.tsx
└── shared/
    ├── Lightbox.tsx
    ├── CopyButton.tsx
    └── Tooltip.tsx
```

### 12.3 State Management

```typescript
interface ChatState {
  threads: Thread[];
  activeThread: Thread | null;
  collections: Collection[];
  focusMode: FocusMode;
  isSearching: boolean;
  searchProgress: SearchProgress | null;
  suggestions: SuggestedPrompt[];
}
```

### 12.4 Accessibility Requirements

- ARIA labels for all interactive elements
- Keyboard navigation throughout
- Screen reader support for citations
- High contrast mode support
- Reduced motion option for progress animations

### 12.5 Performance Considerations

- Virtualized thread list for large histories
- Lazy-load images and source previews
- Progressive response rendering (streaming)
- Service worker for offline thread access
- Optimistic UI for immediate feedback

---

## 13. Competitive Comparison

| Feature | Perplexity | ChatGPT | Claude | Google AI |
|---------|------------|---------|--------|-----------|
| Inline Citations | ✅ Core feature | ✅ (web mode) | ❌ | ✅ |
| Focus Modes | ✅ Multiple | ❌ | ❌ | ❌ |
| Real-time Search | ✅ | ✅ | ❌ | ✅ |
| Collections | ✅ | ✅ (folders) | ✅ (projects) | ❌ |
| Code Execution | ❌ | ✅ | ✅ | ✅ |
| Image Generation | ✅ | ✅ | ✅ | ✅ |
| API Access | ✅ | ✅ | ✅ | ✅ |
| Deep Research | ✅ | ✅ | ❌ | ✅ |

---

## Appendix: UI Color Palette (Approximate)

```css
:root {
  /* Perplexity brand */
  --primary: #20808D;        /* Teal accent */
  --primary-hover: #1A6B75;
  
  /* Backgrounds */
  --bg-primary: #FFFFFF;
  --bg-secondary: #F7F7F8;
  --bg-sidebar: #FAFAFA;
  --bg-dark: #1A1A1A;        /* Dark mode */
  
  /* Text */
  --text-primary: #1A1A1A;
  --text-secondary: #6B6B6B;
  --text-link: #20808D;
  
  /* Citations */
  --citation-bg: #E8F4F5;
  --citation-text: #20808D;
  
  /* Code */
  --code-bg: #F5F5F5;
  --code-border: #E5E5E5;
  
  /* Status */
  --success: #22C55E;
  --warning: #F59E0B;
  --error: #EF4444;
}
```

---

*This specification is based on publicly available information and user reports as of February 2026. Perplexity AI actively updates its interface; verify current state before implementation.*
