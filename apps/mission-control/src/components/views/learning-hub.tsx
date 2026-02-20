"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  BookOpen,
  Search,
  RefreshCw,
  Star,
  Hammer,
  ExternalLink,
  Sparkles,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { sanitizeHtml } from "@/lib/sanitize";
import type { Task } from "@/lib/hooks/use-tasks";

// --- Types ---

interface Lesson {
  id: string;
  title: string;
  source: "reddit" | "twitter" | "github" | "web";
  sourceDetail: string;
  rating: number;
  category: string;
  tags: string[];
  summary: string;
  content: string;
  url?: string;
  upvotes?: number;
  fetchedAt: number;
  notified?: boolean;
}

interface Notification {
  id: string;
  title: string;
  desc: string;
  type: string;
  rating: number;
  lessonId: string | null;
  read: boolean;
  at: number;
}

type SuggestionChannel = "learning_hub" | "workspace" | "openclaw";

interface SpecialistSuggestion {
  id: string;
  channel: SuggestionChannel;
  title: string;
  summary: string;
  rationale: string;
  actions: string[];
  priority: "high" | "medium" | "low";
  confidence: number;
  specialistId: string;
  specialistName: string;
  workspaceId: string | null;
  generatedAt: string;
}

interface SuggestionApiResponse {
  workspaceId?: string | null;
  suggestions?: Record<SuggestionChannel, SpecialistSuggestion[]>;
  generatedAt?: string;
  error?: string;
}

interface LiveLessonsApiResponse {
  lessons?: Lesson[];
  total?: number;
  fetchedAt?: string;
  cached?: boolean;
  sources?: {
    requested: number;
    succeeded: number;
    failed: number;
    details?: Array<{
      source: Lesson["source"];
      sourceDetail: string;
      count: number;
      ok: boolean;
      error?: string;
    }>;
  };
  error?: string;
}

interface LearningHubProps {
  workspaceId?: string;
  tasks?: Task[];
  onOpenTask?: (taskId: string) => void | Promise<void>;
}

interface BuildTaskMap {
  [lessonId: string]: string;
}

// --- Curated Lessons Database ---

const CURATED_LESSONS: Lesson[] = [
  {
    id: "vibe-coding-rules",
    title: "The 15 Rules of Vibe Coding",
    source: "reddit",
    sourceDetail: "r/cursor + AI Efficiency Handbooks",
    rating: 96,
    category: "workflow",
    tags: ["prompting", "productivity", "best-practices"],
    summary: "Battle-tested rules for AI-assisted development: Use boring stacks, atomic prompts, reference existing code with @file, keep files under 400 lines, commit after every green step, revert ruthlessly after 3 failed attempts.",
    content: `<h3>Core Philosophy — Farmer vs. Chef</h3>
<ul>
<li><strong>Farmer Mode (Setup)</strong>: Prepare the environment. Use a "boring" stack (Next.js, Python, Tailwind) that AI understands from massive training data</li>
<li><strong>Chef Mode (Flow)</strong>: Give high-level goals. Let the AI propose implementation</li>
<li><strong>Review Mode (Taste)</strong>: Fix bad patterns immediately before they compound</li>
</ul>
<h3>The 15 Rules</h3>
<ol>
<li><strong>Boring Stack Wins</strong> — Use tech with highest training data</li>
<li><strong>Start from Template</strong> — Never npm init, use boilerplates</li>
<li><strong>Agent Mode is Default</strong> — Autonomous for surgery; human for architecture</li>
<li><strong>Context is King</strong> — Reference actual code @file more than abstract rules</li>
<li><strong>Atomic Prompts</strong> — Ask for "Sidebar" not "Dashboard"</li>
<li><strong>The "Similar To" Hack</strong> — "Make this similar to @ExistingFile.tsx"</li>
<li><strong>Switch Models</strong> — Fast model for boilerplate; smart for logic</li>
<li><strong>Small Files</strong> — Keep under 400 lines to prevent AI attention drift</li>
<li><strong>TODOs = Dopamine</strong> — Use todolist.md to track progress</li>
<li><strong>TDD Flow</strong> — Write the test, then make it pass</li>
<li><strong>Save Points</strong> — Git commit after every atomic green step</li>
<li><strong>Revert Ruthlessly</strong> — If fails 3 turns, git reset and re-contextualize</li>
<li><strong>Don't Explain</strong> — "No chatter. Just code."</li>
<li><strong>Production Magic</strong> — "Make it production-ready: types, error handling, loading states"</li>
<li><strong>Learn the Basics</strong> — You can't steer a ship without knowing the parts</li>
</ol>`,
    url: "https://github.com/Abhisheksinha1506/ai-efficiency-handbooks",
    upvotes: 1091,
    fetchedAt: Date.now(),
  },
  {
    id: "magic-phrases",
    title: "Magic Phrases That Actually Work",
    source: "reddit",
    sourceDetail: "r/ChatGPTCoding + r/ClaudeAI",
    rating: 94,
    category: "prompting",
    tags: ["prompting", "efficiency", "tips"],
    summary: 'The 20% of prompting that gives 80% results: "Make it production-ready" triggers error handling, "Think step-by-step" forces Chain-of-Thought, "Follow existing patterns" is #1 for codebases.',
    content: `<h3>Core Formula</h3>
<p>Every great prompt contains 4 elements:</p>
<ol>
<li><strong>Role</strong>: "Act as a Senior React Engineer."</li>
<li><strong>Task</strong>: "Create a reusable DatePicker component."</li>
<li><strong>Constraints</strong>: "Use Tailwind, TypeScript, and date-fns."</li>
<li><strong>Format</strong>: "Output only the code file, no explanation."</li>
</ol>
<h3>Magic Phrases</h3>
<ul>
<li><code>"Make it production-ready"</code> → Triggers error handling, security, types</li>
<li><code>"Think step-by-step"</code> → Forces Chain-of-Thought reasoning</li>
<li><code>"Don't explain, just code"</code> → Saves tokens and time</li>
<li><code>"Follow existing patterns"</code> → #1 tip for established codebases</li>
</ul>
<h3>Advanced Techniques</h3>
<ul>
<li><strong>Few-Shot Examples</strong>: Provide 1-2 input→output examples</li>
<li><strong>Delimiters</strong>: Use """triple quotes""" or &lt;xml_tags&gt; to separate data</li>
<li><strong>Self-Critique</strong>: "Review your code for security bugs before outputting"</li>
</ul>`,
    url: "https://www.reddit.com/r/ChatGPTCoding/",
    upvotes: 875,
    fetchedAt: Date.now(),
  },
  {
    id: "daily-driver-prompt",
    title: "The Daily Driver Prompt (80% of Tasks)",
    source: "github",
    sourceDetail: "AI Efficiency Handbooks",
    rating: 95,
    category: "prompting",
    tags: ["prompting", "template", "productivity"],
    summary: 'Copy-paste prompt that handles 80% of coding tasks: "Act as senior engineer. Build [X] following patterns in @ExistingFile exactly. Production-ready. No chatter. Complete files only."',
    content: `<h3>The Prompt</h3>
<blockquote>"Act as a senior engineer. Build [Feature X] following the patterns in <code>@ExistingFile.tsx</code> exactly. Production-ready: strict types, error handling, loading states. No chatter. Output only complete files."</blockquote>
<h3>Why It Works</h3>
<ul>
<li><strong>Role</strong> → Sets expertise level</li>
<li><strong>Reference</strong> → Forces pattern matching to existing code</li>
<li><strong>Production-ready</strong> → Triggers quality gates</li>
<li><strong>No chatter</strong> → Saves tokens</li>
<li><strong>Complete files</strong> → No fragments to assemble</li>
</ul>
<h3>Variations</h3>
<ul>
<li><strong>Debugger</strong>: "Be brutally thorough. Find root cause, explain WHY, fix with full code."</li>
<li><strong>Refactor</strong>: "Refactor for readability preserving 100% behavior. Follow SOLID/DRY."</li>
<li><strong>Rage</strong>: "This is driving me crazy. Find the logical flaw. Be brutally honest about my mistakes."</li>
</ul>`,
    upvotes: 500,
    fetchedAt: Date.now(),
  },
  {
    id: "security-leak-warning",
    title: "⚠️ ChatGPT Repeated Internal API Docs",
    source: "reddit",
    sourceDetail: "r/ChatGPTCoding",
    rating: 93,
    category: "architecture",
    tags: ["security", "warning", "best-practices"],
    summary: "Team discovered ChatGPT knew their internal function names and API structure — likely from someone pasting docs into chat. Lesson: Assume anything pasted into AI may end up in training.",
    content: `<h3>The Incident</h3>
<p>Someone debugging code asked ChatGPT about internal service architecture. Response included:</p>
<ul>
<li>Function names that are NOT public</li>
<li>Parameter structures from internal docs</li>
</ul>
<h3>Root Cause</h3>
<p>Best guess: Someone previously pasted internal API docs into ChatGPT → Now in training data.</p>
<h3>Prevention</h3>
<ul>
<li><strong>Assume everything pasted may leak</strong></li>
<li>Use self-hosted or enterprise AI for sensitive code</li>
<li>Sanitize examples before sharing</li>
<li>Create "safe" documentation versions for AI assistance</li>
</ul>
<blockquote>"Makes me wonder what else from our codebase has accidentally been exposed."</blockquote>`,
    url: "https://www.reddit.com/r/ChatGPTCoding/comments/1r0ib6y/",
    upvotes: 875,
    fetchedAt: Date.now(),
  },
  {
    id: "context-rot-fix",
    title: "Fixing Context Rot in Long Sessions",
    source: "reddit",
    sourceDetail: "r/cursor",
    rating: 92,
    category: "debugging",
    tags: ["debugging", "context", "reliability"],
    summary: "When AI starts forgetting or contradicting earlier work: Create a project-intelligence.md with non-negotiables, use explicit file references, restart session with fresh context dump.",
    content: `<h3>What is Context Rot?</h3>
<p>After many messages, AI starts:</p>
<ul>
<li>Forgetting architectural decisions from earlier</li>
<li>Re-implementing solved problems poorly</li>
<li>Mixing incompatible patterns</li>
</ul>
<h3>The Fix: project-intelligence.md</h3>
<p>Create a single markdown file with your <strong>Non-Negotiables</strong>:</p>
<blockquote><strong>Pattern</strong>: "Strict MVVM. Use @ObservedObject, never @StateObject inside sub-views."<br/><strong>Concurrency</strong>: "Use async/await actors. No Combine chains."<br/><strong>Data</strong>: "Single PersistenceController singleton for Core Data."</blockquote>
<h3>Prevention Loop</h3>
<ol>
<li><strong>Plan</strong>: "Create plan.md for this feature"</li>
<li><strong>Execute</strong>: "Implement Step 1"</li>
<li><strong>Review</strong>: "Check for violations of project-intelligence.md"</li>
</ol>
<h3>Emergency Reset</h3>
<p>When context is too corrupted: Start new session, paste project-intelligence.md + current file state.</p>`,
    upvotes: 379,
    fetchedAt: Date.now(),
  },
  {
    id: "agent-rebuilt-itself",
    title: "Autonomous Agent Self-Refactoring (26 Hours)",
    source: "reddit",
    sourceDetail: "r/ChatGPTCoding - Qoder AMA",
    rating: 91,
    category: "agents",
    tags: ["agents", "autonomous", "case-study"],
    summary: "Qoder let their autonomous agent Quest refactor itself for 26 hours straight. Key insight: spec-to-build-to-verify loops matter. They reviewed the spec at start and code at end.",
    content: `<h3>The Experiment</h3>
<p>Qoder used their autonomous agent (Quest) to refactor itself:</p>
<ul>
<li>Described the goal, stepped back, let it run</li>
<li>Worked through interaction layer, state management, core agent loop</li>
<li>Ran continuously for ~26 hours</li>
<li>Team mostly reviewed spec at start, code at end</li>
</ul>
<h3>What Worked</h3>
<ul>
<li><strong>Spec-to-Build-to-Verify loops</strong> — Crucial for autonomous coding</li>
<li><strong>Minimal human intervention</strong> — Let the agent explore</li>
<li><strong>Clear goal definition</strong> — Agent knew what "done" looked like</li>
</ul>
<h3>Key Takeaways</h3>
<blockquote>"Autonomous agents can do significant refactoring work if you trust the loop and define success criteria upfront."</blockquote>`,
    url: "https://www.reddit.com/r/ChatGPTCoding/comments/1qo3se2/",
    upvotes: 379,
    fetchedAt: Date.now(),
  },
  {
    id: "goat-workflow",
    title: "The GOAT Workflow (Greatest of All Time)",
    source: "github",
    sourceDetail: "AI Efficiency Handbooks",
    rating: 90,
    category: "workflow",
    tags: ["workflow", "minimalist", "productivity"],
    summary: "Minimalist system for maximum shipping speed: Discard complex .cursorrules, use one massive context referencing entire relevant codebase, monkey-see-monkey-do forces AI to mimic reality.",
    content: `<h3>The Philosophy</h3>
<p>Stop over-engineering your AI setup. Simplify ruthlessly.</p>
<h3>The Rules</h3>
<ul>
<li><strong>Discard the fluff</strong>: Delete complex .cursorrules and memory.json files</li>
<li><strong>One Massive Context</strong>: Reference the ENTIRE relevant codebase chunk</li>
<li><strong>Monkey See, Monkey Do</strong>: By showing actual code, you force AI to mimic reality instead of hallucinating abstractions</li>
</ul>
<h3>Why It Works</h3>
<blockquote>"The best context is actual working code, not abstract rules about how code should work."</blockquote>`,
    upvotes: 300,
    fetchedAt: Date.now(),
  },
  {
    id: "ios-vibe-coding-fail",
    title: "Why Vibe Coding Fails for iOS",
    source: "github",
    sourceDetail: "AI Efficiency Handbooks",
    rating: 89,
    category: "architecture",
    tags: ["ios", "mobile", "lessons-learned"],
    summary: "Senior dev built 12k LOC iOS app with pure vibe coding — unmaintainable disaster. Missing: architecture rules, proper context files. Fix: Hybrid structure with light planning docs.",
    content: `<h3>The Experiment (And Failure)</h3>
<p>Goal: Build full iOS app (SwiftUI, CoreData, CloudKit) using ONLY Cursor prompts. Zero manual code.</p>
<p><strong>Result</strong>: 12k LOC unmaintainable disaster:</p>
<ul>
<li>Mixed MVVM with random Views</li>
<li>3 different ways of handling Core Data</li>
<li>Crashes on real device (memory leaks, threading)</li>
</ul>
<h3>The Mistakes</h3>
<ol>
<li><strong>No Architecture Rules</strong> — AI reinvents the wheel every session</li>
<li><strong>One-Shot Big Prompts</strong> — Relies on unseen state (AppDelegates, Background Contexts)</li>
<li><strong>Missing .md Files</strong> — Chat memory fades; AI forgot Day 1 decisions</li>
</ol>
<h3>The Fix: Hybrid Vibe</h3>
<ul>
<li>Light planning (project-intelligence.md) with non-negotiables</li>
<li>Plan → Execute → Review loop</li>
<li>Git commit after EVERY working view</li>
</ul>`,
    upvotes: 200,
    fetchedAt: Date.now(),
  },
  {
    id: "anthropic-ad-free",
    title: "Anthropic Commits to Ad-Free Claude",
    source: "twitter",
    sourceDetail: "Official Anthropic Blog",
    rating: 88,
    category: "workflow",
    tags: ["news", "anthropic", "claude"],
    summary: 'Anthropic officially declared Claude will remain ad-free. Their philosophy: "Claude is a space to think" — not a platform for advertising.',
    content: `<h3>The Announcement</h3>
<p>Anthropic published a blog post declaring their commitment to keeping Claude ad-free.</p>
<blockquote>"Claude is a space to think, not a billboard."</blockquote>
<h3>Why It Matters</h3>
<ul>
<li>Trust in AI tools requires alignment of incentives</li>
<li>Ads could bias responses toward advertisers</li>
<li>Preserves focus on being genuinely helpful</li>
</ul>
<h3>User Reaction</h3>
<p>3,000+ upvotes on r/ClaudeAI. Community overwhelmingly positive.</p>`,
    url: "https://www.anthropic.com/news/claude-is-a-space-to-think",
    upvotes: 3026,
    fetchedAt: Date.now(),
  },
  {
    id: "switch-models-strategy",
    title: "Model Switching Strategy for Cost & Speed",
    source: "reddit",
    sourceDetail: "r/LocalLLaMA + r/ClaudeAI",
    rating: 87,
    category: "workflow",
    tags: ["models", "cost", "efficiency"],
    summary: "Use fast/cheap models (Gemini Flash, GPT-4o-mini) for boilerplate and scaffolding. Switch to smart models (Claude Sonnet, GPT-4o) for complex logic and debugging.",
    content: `<h3>The Strategy</h3>
<table>
<tr><th>Task Type</th><th>Model Choice</th></tr>
<tr><td>Boilerplate, scaffolding</td><td>Gemini Flash, GPT-4o-mini, Haiku</td></tr>
<tr><td>Complex logic, debugging</td><td>Claude Sonnet, GPT-4o, Opus</td></tr>
<tr><td>Architecture decisions</td><td>Best available (Opus, o1)</td></tr>
<tr><td>Simple refactoring</td><td>Fast models</td></tr>
</table>
<h3>Cost Savings</h3>
<p>Teams report 60-80% cost reduction by strategic model switching while maintaining output quality.</p>`,
    upvotes: 250,
    fetchedAt: Date.now(),
  },
];

// --- Helpers ---

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getSourceColor(source: string): string {
  switch (source) {
    case "reddit": return "bg-orange-500";
    case "twitter": return "bg-blue-400";
    case "github": return "bg-slate-300";
    case "web": return "bg-purple-500";
    default: return "bg-slate-400";
  }
}

function getRatingStyle(rating: number): { bg: string; text: string; border: string } {
  if (rating >= 90) return { bg: "bg-green-500/20", text: "text-green-400", border: "border-green-500/30" };
  if (rating >= 80) return { bg: "bg-primary/20", text: "text-primary", border: "border-primary/30" };
  if (rating >= 60) return { bg: "bg-orange-500/20", text: "text-orange-400", border: "border-orange-500/30" };
  return { bg: "bg-muted", text: "text-muted-foreground", border: "border-border" };
}

function readStoredJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function mergeLessons(existing: Lesson[], incoming: Lesson[]): Lesson[] {
  const byId = new Map(existing.map((lesson) => [lesson.id, lesson]));
  for (const lesson of incoming) {
    const previous = byId.get(lesson.id);
    byId.set(
      lesson.id,
      previous
        ? {
          ...previous,
          ...lesson,
          notified: previous.notified ?? lesson.notified,
        }
        : lesson
    );
  }
  return Array.from(byId.values()).sort((a, b) => b.rating - a.rating);
}

function buildInitialLearningHubState() {
  const lessons = readStoredJson<Lesson[]>("oc_lessons", CURATED_LESSONS);
  const savedLessons = readStoredJson<string[]>("oc_saved_lessons", []);
  const toBuildLessons = readStoredJson<string[]>("oc_tobuild_lessons", []);
  const notifications = readStoredJson<Notification[]>("oc_notifications", []);

  const newEliteLessons = lessons.filter((lesson) => lesson.rating >= 90 && !lesson.notified);
  const nextLessons =
    newEliteLessons.length > 0
      ? lessons.map((lesson) =>
        newEliteLessons.some((eliteLesson) => eliteLesson.id === lesson.id)
          ? { ...lesson, notified: true }
          : lesson
      )
      : lessons;

  const newNotifications = newEliteLessons.map((lesson) => ({
    id: `n-elite-${lesson.id}`,
    title: `🔥 Elite Lesson: ${lesson.title}`,
    desc: `Rating: ${lesson.rating}/100 — ${lesson.summary.slice(0, 80)}...`,
    type: "elite",
    rating: lesson.rating,
    lessonId: lesson.id,
    read: false,
    at: lesson.fetchedAt,
  }));

  const existingNotifications = notifications.filter(
    (notification) =>
      !newNotifications.some((newNotification) => newNotification.id === notification.id)
  );

  return {
    lessons: nextLessons,
    savedLessons,
    toBuildLessons,
    notifications: [...newNotifications, ...existingNotifications].slice(0, 50),
    buildTaskByLesson: readStoredJson<BuildTaskMap>("oc_lesson_build_tasks", {}),
  };
}

// --- Feature Builds List ---

function BuildStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "in_progress":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-500">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          Building...
        </span>
      );
    case "review":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-500">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
          In Review
        </span>
      );
    case "done":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-500">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          Done
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
          {status || "Queued"}
        </span>
      );
  }
}

function FeatureBuildsList({
  lessons,
  buildTaskByLesson,
  tasks,
  onOpenTask,
}: {
  lessons: Lesson[];
  buildTaskByLesson: BuildTaskMap;
  tasks: Task[];
  onOpenTask?: (taskId: string) => void | Promise<void>;
}) {
  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    tasks.forEach((t) => map.set(t.id, t));
    return map;
  }, [tasks]);

  // Get all lessons that have a build task, sorted by task creation date (newest first)
  const buildEntries = useMemo(() => {
    return Object.entries(buildTaskByLesson)
      .map(([lessonId, taskId]) => {
        const lesson = lessons.find((l) => l.id === lessonId);
        const task = taskById.get(taskId);
        return { lessonId, taskId, lesson, task };
      })
      .filter((e) => e.lesson)
      .sort((a, b) => {
        const aTime = a.task ? new Date(a.task.created_at).getTime() : 0;
        const bTime = b.task ? new Date(b.task.created_at).getTime() : 0;
        return bTime - aTime;
      });
  }, [buildTaskByLesson, lessons, taskById]);

  const doneCount = buildEntries.filter((e) => e.task?.status === "done").length;
  const activeCount = buildEntries.filter(
    (e) => e.task?.status === "in_progress" || e.task?.status === "review"
  ).length;

  if (buildEntries.length === 0) {
    return (
      <div className="p-12 flex flex-col items-center justify-center text-center gap-3">
        <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center">
          <Hammer className="w-7 h-7 text-muted-foreground" />
        </div>
        <h3 className="font-bold text-lg">No feature builds yet</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Press &quot;Build&quot; on any lesson to start improving OpenClaw Mission Control. Completed builds will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-4 text-sm">
        <span className="text-muted-foreground">
          {buildEntries.length} build{buildEntries.length !== 1 ? "s" : ""}
        </span>
        {doneCount > 0 && (
          <span className="text-emerald-500 font-medium">{doneCount} done</span>
        )}
        {activeCount > 0 && (
          <span className="text-amber-500 font-medium">{activeCount} active</span>
        )}
      </div>

      {/* Build list */}
      {buildEntries.map(({ lessonId, taskId, lesson, task }) => (
        <div
          key={lessonId}
          className={`glass-panel rounded-lg p-4 flex items-center justify-between gap-4 ${task?.status === "done"
            ? "border-emerald-500/20"
            : "border-border"
            }`}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="font-medium text-sm truncate">
                {lesson?.title ?? "Unknown Lesson"}
              </h4>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {task?.assigned_agent_id && (
                <span>Agent: {task.assigned_agent_id}</span>
              )}
              {task?.created_at && (
                <span>{timeAgo(new Date(task.created_at).getTime())}</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <BuildStatusBadge status={task?.status ?? "inbox"} />
            {onOpenTask && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onOpenTask(taskId)}
                className="text-xs h-7"
              >
                Open Task
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Main Component ---

export function LearningHub({ workspaceId, tasks: externalTasks, onOpenTask }: LearningHubProps) {
  const initialLearningHubState = useMemo(buildInitialLearningHubState, []);
  const [lessons, setLessons] = useState<Lesson[]>(initialLearningHubState.lessons);
  const [savedLessons, setSavedLessons] = useState<string[]>(
    initialLearningHubState.savedLessons
  );
  const [toBuildLessons, setToBuildLessons] = useState<string[]>(
    initialLearningHubState.toBuildLessons
  );
  const [notifications, setNotifications] = useState<Notification[]>(
    initialLearningHubState.notifications
  );
  const [buildTaskByLesson, setBuildTaskByLesson] = useState<BuildTaskMap>(
    initialLearningHubState.buildTaskByLesson ?? {}
  );
  const [buildingLessonIds, setBuildingLessonIds] = useState<Set<string>>(
    new Set()
  );
  const [buildErrorByLesson, setBuildErrorByLesson] = useState<
    Record<string, string>
  >({});
  const [currentFilter, setCurrentFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [specialistSuggestions, setSpecialistSuggestions] = useState<
    SpecialistSuggestion[]
  >([]);
  const [specialistSuggestionLoading, setSpecialistSuggestionLoading] =
    useState(true);
  const [specialistSuggestionError, setSpecialistSuggestionError] = useState<
    string | null
  >(null);
  const [specialistSuggestionRefreshedAt, setSpecialistSuggestionRefreshedAt] =
    useState<string | null>(null);
  const [liveLessonsError, setLiveLessonsError] = useState<string | null>(null);
  const [liveLessonsRefreshedAt, setLiveLessonsRefreshedAt] = useState<string | null>(
    null
  );
  const [liveLessonsSourceSummary, setLiveLessonsSourceSummary] =
    useState<string>("Sources: curated only");

  const toggleSaved = useCallback((lessonId: string) => {
    setSavedLessons((prev) => {
      const updated = prev.includes(lessonId)
        ? prev.filter((id) => id !== lessonId)
        : [...prev, lessonId];
      localStorage.setItem("oc_saved_lessons", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const markNotificationRead = useCallback((notifId: string) => {
    setNotifications((prev) => {
      const updated = prev.map((n) => (n.id === notifId ? { ...n, read: true } : n));
      localStorage.setItem("oc_notifications", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
    localStorage.setItem("oc_notifications", JSON.stringify([]));
  }, []);

  useEffect(() => {
    localStorage.setItem("oc_lessons", JSON.stringify(lessons));
  }, [lessons]);

  useEffect(() => {
    localStorage.setItem("oc_saved_lessons", JSON.stringify(savedLessons));
  }, [savedLessons]);

  useEffect(() => {
    localStorage.setItem("oc_tobuild_lessons", JSON.stringify(toBuildLessons));
  }, [toBuildLessons]);

  useEffect(() => {
    localStorage.setItem("oc_notifications", JSON.stringify(notifications));
  }, [notifications]);

  useEffect(() => {
    localStorage.setItem("oc_lesson_build_tasks", JSON.stringify(buildTaskByLesson));
  }, [buildTaskByLesson]);

  const refreshSpecialistSuggestions = useCallback(async () => {
    setSpecialistSuggestionLoading(true);
    try {
      const params = new URLSearchParams();
      if (workspaceId) {
        params.set("workspace_id", workspaceId);
      }
      const url = params.toString()
        ? `/api/agents/specialists/suggestions?${params.toString()}`
        : "/api/agents/specialists/suggestions";
      const res = await fetch(url);
      const data = (await res.json()) as SuggestionApiResponse;
      if (!res.ok) {
        throw new Error(
          data.error || `Failed to load specialist suggestions (${res.status})`
        );
      }
      setSpecialistSuggestions(data.suggestions?.learning_hub ?? []);
      setSpecialistSuggestionRefreshedAt(data.generatedAt ?? new Date().toISOString());
      setSpecialistSuggestionError(null);
    } catch (error) {
      setSpecialistSuggestionError(
        error instanceof Error
          ? error.message
          : "Failed to load specialist learning suggestions"
      );
    } finally {
      setSpecialistSuggestionLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refreshSpecialistSuggestions();
  }, [refreshSpecialistSuggestions]);

  const refreshLiveLessons = useCallback(
    async (force: boolean) => {
      const url = force
        ? "/api/learning-hub/lessons?force=1"
        : "/api/learning-hub/lessons";
      const res = await fetch(url);
      const data = (await res.json()) as LiveLessonsApiResponse;
      if (!res.ok) {
        throw new Error(data.error || `Failed to fetch live lessons (${res.status})`);
      }

      const incoming = data.lessons ?? [];
      let eliteNotifications: Notification[] = [];
      setLessons((prev) => {
        const existingIds = new Set(prev.map((lesson) => lesson.id));
        const freshElite = incoming.filter(
          (lesson) => lesson.rating >= 90 && !existingIds.has(lesson.id)
        );
        const freshEliteIds = new Set(freshElite.map((lesson) => lesson.id));
        eliteNotifications = freshElite.map((lesson) => ({
          id: `n-elite-${lesson.id}`,
          title: `🔥 Elite Lesson: ${lesson.title}`,
          desc: `Rating: ${lesson.rating}/100 — ${lesson.summary.slice(0, 80)}...`,
          type: "elite",
          rating: lesson.rating,
          lessonId: lesson.id,
          read: false,
          at: Date.now(),
        }));
        return mergeLessons(prev, incoming).map((lesson) =>
          freshEliteIds.has(lesson.id) ? { ...lesson, notified: true } : lesson
        );
      });

      if (eliteNotifications.length > 0) {
        setNotifications((prev) => {
          const filtered = prev.filter(
            (notification) =>
              !eliteNotifications.some((nextNotif) => nextNotif.id === notification.id)
          );
          return [...eliteNotifications, ...filtered].slice(0, 50);
        });
      }

      const sourceSummary = data.sources
        ? `Sources: ${data.sources.succeeded}/${data.sources.requested} feeds (community + live)`
        : "Sources: curated + live";
      setLiveLessonsSourceSummary(sourceSummary);
      setLiveLessonsRefreshedAt(data.fetchedAt ?? new Date().toISOString());
      setLiveLessonsError(null);
    },
    []
  );

  useEffect(() => {
    void refreshLiveLessons(false).catch((error) => {
      setLiveLessonsError(
        error instanceof Error ? error.message : "Failed to refresh live lessons"
      );
    });
  }, [refreshLiveLessons]);

  const handleOpenBuiltTask = useCallback(
    (taskId: string) => {
      if (onOpenTask) {
        void onOpenTask(taskId);
        return;
      }
      const url = new URL(window.location.href);
      url.hash = "board";
      url.searchParams.set("task", taskId);
      window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    },
    [onOpenTask]
  );

  const handleRefreshLessons = useCallback(async () => {
    setIsLoading(true);
    try {
      await refreshLiveLessons(true);
      await refreshSpecialistSuggestions();
      setLiveLessonsError(null);
    } catch (error) {
      setLiveLessonsError(
        error instanceof Error ? error.message : "Failed to refresh lessons"
      );
    } finally {
      setIsLoading(false);
    }
  }, [refreshLiveLessons, refreshSpecialistSuggestions]);

  const handleBuildLesson = useCallback(
    async (lesson: Lesson) => {
      if (buildingLessonIds.has(lesson.id)) return;
      if (buildTaskByLesson[lesson.id]) return;

      setBuildErrorByLesson((prev) => {
        const next = { ...prev };
        delete next[lesson.id];
        return next;
      });
      setBuildingLessonIds((prev) => {
        const next = new Set(prev);
        next.add(lesson.id);
        return next;
      });

      try {
        let recommendedAgentId: string | undefined;
        try {
          const recommendationRes = await fetch("/api/agents/specialists/recommend", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: `Implement lesson: ${lesson.title}`,
              description: `${lesson.summary}\n${stripHtml(lesson.content).slice(0, 800)}`,
              workspace_id: workspaceId,
              limit: 1,
            }),
          });
          const recommendationData = (await recommendationRes.json()) as {
            recommendations?: Array<{ agentId: string }>;
          };
          if (recommendationRes.ok) {
            recommendedAgentId = recommendationData.recommendations?.[0]?.agentId;
          }
        } catch {
          // fallback: create task without specialist auto-assignment
        }

        const lessonText = stripHtml(lesson.content);
        const taskRes = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `Learning Hub: ${lesson.title}`,
            description: [
              "You are improving the OpenClaw Mission Control dashboard.",
              "",
              "Read this lesson and decide:",
              "- Build a NEW feature/section if the lesson teaches something we don't have yet",
              "- Improve EXISTING code if the lesson describes a better approach to something we already do",
              "",
              `Lesson: "${lesson.title}"`,
              `Source: ${lesson.source} (${lesson.sourceDetail})`,
              `URL: ${lesson.url ?? "N/A"}`,
              `Summary: ${lesson.summary}`,
              "",
              `Content excerpt: ${lessonText.slice(0, 600)}${lessonText.length > 600 ? "..." : ""
              }`,
              "",
              "Delivery criteria:",
              "1. Make one practical, testable improvement to OpenClaw Mission Control.",
              "2. The change must be visible or verifiable in the running app.",
              "3. Leave a short comment documenting what changed and why.",
            ].join("\n"),
            priority: lesson.rating >= 90 ? "high" : "medium",
            assigned_agent_id: recommendedAgentId,
            tags: ["learning-hub", "lesson", lesson.category, lesson.id],
            workspace_id: workspaceId,
          }),
        });
        const taskData = (await taskRes.json()) as {
          task?: { id?: string };
          error?: string;
        };
        if (!taskRes.ok || !taskData.task?.id) {
          throw new Error(taskData.error || "Failed to create lesson task");
        }

        const taskId = taskData.task.id;
        let dispatchWarning: string | null = null;
        if (recommendedAgentId) {
          const dispatchRes = await fetch("/api/tasks/dispatch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              taskId,
              agentId: recommendedAgentId,
            }),
          });
          const dispatchData = (await dispatchRes.json()) as { error?: string };
          if (!dispatchRes.ok) {
            dispatchWarning =
              dispatchData.error ||
              "Task created but specialist dispatch failed. You can dispatch manually from board.";
          }
        }

        setBuildTaskByLesson((prev) => ({ ...prev, [lesson.id]: taskId }));
        setToBuildLessons((prev) => (prev.includes(lesson.id) ? prev : [...prev, lesson.id]));
        const buildNotification: Notification = {
          id: `n-build-${lesson.id}-${Date.now()}`,
          title: `🔨 Build started: ${lesson.title}`,
          desc: recommendedAgentId
            ? dispatchWarning
              ? `Task created for ${recommendedAgentId}, but dispatch failed.`
              : `Task created and dispatched to ${recommendedAgentId}.`
            : "Task created in inbox. Assign a specialist to start.",
          type: "build",
          rating: lesson.rating,
          lessonId: lesson.id,
          read: false,
          at: Date.now(),
        };
        setNotifications((prev) => [buildNotification, ...prev].slice(0, 50));
        if (dispatchWarning) {
          setBuildErrorByLesson((prev) => ({
            ...prev,
            [lesson.id]: dispatchWarning,
          }));
        }
      } catch (error) {
        setBuildErrorByLesson((prev) => ({
          ...prev,
          [lesson.id]:
            error instanceof Error ? error.message : "Failed to build lesson task",
        }));
      } finally {
        setBuildingLessonIds((prev) => {
          const next = new Set(prev);
          next.delete(lesson.id);
          return next;
        });
      }
    },
    [buildTaskByLesson, buildingLessonIds, workspaceId]
  );

  // Filter lessons
  const filteredLessons = lessons
    .filter((lesson) => {
      if (currentFilter === "elite") return lesson.rating >= 90;
      if (currentFilter === "saved") return savedLessons.includes(lesson.id);
      if (currentFilter === "tobuild") return toBuildLessons.includes(lesson.id);
      if (currentFilter === "builds") return !!buildTaskByLesson[lesson.id];
      if (currentFilter !== "all") {
        return lesson.category === currentFilter || lesson.tags.includes(currentFilter);
      }
      return true;
    })
    .filter((lesson) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        lesson.title.toLowerCase().includes(q) ||
        lesson.summary.toLowerCase().includes(q) ||
        lesson.tags.some((t) => t.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => b.rating - a.rating);

  const stats = {
    total: lessons.length,
    elite: lessons.filter((l) => l.rating >= 90).length,
    saved: savedLessons.length,
    toBuild: toBuildLessons.length,
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  const FILTERS = [
    { id: "all", label: "All" },
    { id: "elite", label: "🔥 Elite (90+)" },
    { id: "prompting", label: "Prompting" },
    { id: "workflow", label: "Workflows" },
    { id: "agents", label: "Agents" },
    { id: "architecture", label: "Architecture" },
    { id: "debugging", label: "Debugging" },
    { id: "saved", label: "⭐ Saved" },
    { id: "tobuild", label: "🔨 To Build" },
    { id: "builds", label: "✅ Feature Builds" },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-border bg-card/50">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary" />
              Learning Hub
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Community wisdom from X, Reddit, GitHub & dev communities. Lessons rated 0-100.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {liveLessonsSourceSummary}
              {liveLessonsRefreshedAt
                ? ` · synced ${timeAgo(new Date(liveLessonsRefreshedAt).getTime())}`
                : ""}
            </p>
            {liveLessonsError && (
              <p className="text-xs text-destructive mt-1">
                Live lesson sync unavailable: {liveLessonsError}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Notifications */}
            <div className="relative">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowNotifications(!showNotifications)}
                className="relative"
              >
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </Button>

              {showNotifications && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-card border border-border rounded-lg shadow-lg z-50 overflow-hidden">
                  <div className="p-3 border-b border-border flex items-center justify-between">
                    <span className="font-semibold text-sm">Notifications</span>
                    <button
                      onClick={clearNotifications}
                      className="text-xs text-muted-foreground hover:text-destructive"
                    >
                      Clear all
                    </button>
                  </div>
                  <ScrollArea className="max-h-80">
                    {notifications.length === 0 ? (
                      <div className="p-6 text-center text-muted-foreground text-sm">
                        No notifications
                      </div>
                    ) : (
                      notifications.slice(0, 10).map((notif) => (
                        <div
                          key={notif.id}
                          onClick={() => {
                            markNotificationRead(notif.id);
                            if (notif.lessonId) {
                              const lesson = lessons.find((l) => l.id === notif.lessonId);
                              if (lesson) setSelectedLesson(lesson);
                            }
                            setShowNotifications(false);
                          }}
                          className={`p-3 border-b border-border cursor-pointer hover:bg-muted/50 transition-colors ${!notif.read ? "bg-primary/5 border-l-2 border-l-primary" : ""
                            }`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium truncate flex-1">
                              {notif.title}
                            </span>
                            {notif.rating >= 90 && (
                              <Badge variant="secondary" className="bg-green-500/20 text-green-400 text-[10px]">
                                {notif.rating}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2">{notif.desc}</p>
                          <span className="text-[10px] text-muted-foreground mt-1 block">
                            {timeAgo(notif.at)}
                          </span>
                        </div>
                      ))
                    )}
                  </ScrollArea>
                </div>
              )}
            </div>

            <Button
              onClick={() => void handleRefreshLessons()}
              disabled={isLoading}
              className="gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
              Refresh Lessons
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="bg-muted/50 rounded-lg p-3 text-center border border-border">
            <div className="text-2xl font-bold text-primary">{stats.total}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Total</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center border border-border">
            <div className="text-2xl font-bold text-green-400">{stats.elite}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Elite (90+)</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center border border-border">
            <div className="text-2xl font-bold text-yellow-400">{stats.saved}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Saved</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center border border-border">
            <div className="text-2xl font-bold text-purple-400">{stats.toBuild}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">To Build</div>
          </div>
        </div>

        <div className="mb-4 rounded-lg border border-border bg-card/60 p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Specialist Learning Signals
            </h3>
            <span
              className={`text-[11px] ${specialistSuggestionError ? "text-destructive" : "text-muted-foreground"
                }`}
            >
              {specialistSuggestionError
                ? `Unavailable: ${specialistSuggestionError}`
                : specialistSuggestionLoading
                  ? "Refreshing specialist signals..."
                  : `Updated ${specialistSuggestionRefreshedAt
                    ? timeAgo(new Date(specialistSuggestionRefreshedAt).getTime())
                    : "just now"
                  }`}
            </span>
          </div>

          {specialistSuggestions.length === 0 ? (
            <p className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-2">
              No specialist learning recommendations yet. Complete and review more
              specialist tasks to unlock tailored learning tracks.
            </p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
              {specialistSuggestions.slice(0, 3).map((suggestion) => (
                <article
                  key={suggestion.id}
                  className="rounded-md border border-border bg-background/70 p-2 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-xs font-medium leading-tight">{suggestion.title}</h4>
                    <Badge
                      variant="outline"
                      className={`text-[10px] capitalize ${suggestion.priority === "high"
                        ? "border-destructive/40 text-destructive"
                        : suggestion.priority === "medium"
                          ? "border-amber-500/40 text-amber-500"
                          : "border-primary/30 text-primary"
                        }`}
                    >
                      {suggestion.priority}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground line-clamp-2">
                    {suggestion.summary}
                  </p>
                  {suggestion.actions[0] && (
                    <p className="text-[11px] text-primary">
                      Next: {suggestion.actions[0]}
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    Suggested by {suggestion.specialistName} ·{" "}
                    {Math.round(suggestion.confidence * 100)}% confidence
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>

        {/* Search & Filters */}
        <div className="flex gap-3 items-center">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search lessons..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-muted border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {FILTERS.map((filter) => (
              <button
                key={filter.id}
                onClick={() => setCurrentFilter(filter.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${currentFilter === filter.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content Area */}
      <ScrollArea className="flex-1">
        {currentFilter === "builds" ? (
          <div className="p-6">
            <FeatureBuildsList
              lessons={lessons}
              buildTaskByLesson={buildTaskByLesson}
              tasks={externalTasks ?? []}
              onOpenTask={onOpenTask}
            />
          </div>
        ) : (
          <div className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredLessons.map((lesson) => {
              const ratingStyle = getRatingStyle(lesson.rating);
              const isSaved = savedLessons.includes(lesson.id);
              const isToBuild = toBuildLessons.includes(lesson.id);
              const isBuilding = buildingLessonIds.has(lesson.id);
              const buildTaskId = buildTaskByLesson[lesson.id];
              const buildError = buildErrorByLesson[lesson.id];

              return (
                <div
                  key={lesson.id}
                  onClick={() => setSelectedLesson(lesson)}
                  className={`bg-card border rounded-lg p-4 cursor-pointer transition-all hover:shadow-md hover:-translate-y-0.5 ${lesson.rating >= 90
                    ? "border-green-500/30 bg-gradient-to-br from-card to-green-500/5"
                    : "border-border hover:border-primary/30"
                    }`}
                >
                  {/* Featured badge */}
                  {lesson.rating >= 90 && (
                    <div className="flex items-center gap-1 text-[10px] font-bold text-green-400 mb-2">
                      <Sparkles className="w-3 h-3" />
                      HOT LESSON
                    </div>
                  )}

                  {/* Source & Rating */}
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${getSourceColor(lesson.source)}`} />
                      <span className="text-[10px] font-medium text-muted-foreground uppercase">
                        {lesson.source} • {lesson.sourceDetail}
                      </span>
                    </div>
                    <Badge className={`ml-auto text-[10px] ${ratingStyle.bg} ${ratingStyle.text} border ${ratingStyle.border}`}>
                      {lesson.rating >= 90 && "🔥 "}
                      {lesson.rating}/100
                    </Badge>
                  </div>

                  {/* Title */}
                  <h3 className="font-semibold text-sm mb-2 line-clamp-2">{lesson.title}</h3>

                  {/* Summary */}
                  <p className="text-xs text-muted-foreground line-clamp-3 mb-3">{lesson.summary}</p>

                  {/* Tags */}
                  <div className="flex gap-1 flex-wrap mb-3">
                    {lesson.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="px-2 py-0.5 bg-muted rounded text-[10px] text-muted-foreground">
                        {tag}
                      </span>
                    ))}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSaved(lesson.id);
                      }}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${isSaved
                        ? "bg-yellow-500/20 text-yellow-400"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                    >
                      <Star className={`w-3 h-3 ${isSaved ? "fill-current" : ""}`} />
                      {isSaved ? "Saved" : "Save"}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (buildTaskId || isBuilding) return;
                        void handleBuildLesson(lesson);
                      }}
                      disabled={isBuilding || !!buildTaskId}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${isBuilding
                        ? "bg-purple-500/20 text-purple-300 cursor-wait"
                        : buildTaskId
                          ? "bg-green-500/20 text-green-400 cursor-default"
                          : isToBuild
                            ? "bg-purple-500/20 text-purple-400"
                            : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                    >
                      <Hammer className="w-3 h-3" />
                      {isBuilding
                        ? "Building..."
                        : buildTaskId
                          ? "Built"
                          : isToBuild
                            ? "Queued"
                            : "Build"}
                    </button>
                    {buildTaskId && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenBuiltTask(buildTaskId);
                        }}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-green-500/10 text-green-400 hover:bg-green-500/20"
                      >
                        Open Task
                      </button>
                    )}
                    {lesson.url && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(lesson.url, "_blank");
                        }}
                        type="button"
                        aria-label={`Open source link for ${lesson.title}`}
                        title="Open source link"
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-muted text-muted-foreground hover:bg-muted/80 ml-auto"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  {buildError && (
                    <p className="mt-2 text-[11px] text-destructive line-clamp-2">{buildError}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Lesson Detail Modal */}
      <Dialog open={!!selectedLesson} onOpenChange={() => setSelectedLesson(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          {selectedLesson && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${getSourceColor(selectedLesson.source)}`} />
                  <span className="text-xs font-medium text-muted-foreground uppercase">
                    {selectedLesson.source} • {selectedLesson.sourceDetail}
                  </span>
                  <Badge className={`ml-auto ${getRatingStyle(selectedLesson.rating).bg} ${getRatingStyle(selectedLesson.rating).text}`}>
                    {selectedLesson.rating >= 90 && "🔥 "}
                    {selectedLesson.rating}/100
                  </Badge>
                </div>
                <DialogTitle className="text-lg">{selectedLesson.title}</DialogTitle>
              </DialogHeader>

              <div className="flex gap-1 flex-wrap mb-4">
                {selectedLesson.tags.map((tag) => (
                  <span key={tag} className="px-2 py-0.5 bg-muted rounded text-xs text-muted-foreground">
                    {tag}
                  </span>
                ))}
              </div>

              <ScrollArea className="flex-1 pr-4">
                <div
                  className="prose prose-sm prose-invert max-w-none [&_h3]:text-primary [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-1 [&_blockquote]:border-l-primary [&_blockquote]:bg-primary/10 [&_blockquote]:py-2 [&_blockquote]:px-4 [&_blockquote]:rounded-r [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-primary"
                  // Security: Sanitize HTML to prevent XSS
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(selectedLesson.content) }}
                />
              </ScrollArea>

              <div className="flex gap-2 pt-4 border-t border-border mt-4">
                <Button
                  variant={savedLessons.includes(selectedLesson.id) ? "default" : "outline"}
                  onClick={() => toggleSaved(selectedLesson.id)}
                  className="gap-2"
                >
                  <Star className={`w-4 h-4 ${savedLessons.includes(selectedLesson.id) ? "fill-current" : ""}`} />
                  {savedLessons.includes(selectedLesson.id) ? "Saved" : "Save Lesson"}
                </Button>
                <Button
                  variant={buildTaskByLesson[selectedLesson.id] ? "default" : "outline"}
                  onClick={() => {
                    if (buildTaskByLesson[selectedLesson.id]) return;
                    void handleBuildLesson(selectedLesson);
                  }}
                  disabled={
                    buildingLessonIds.has(selectedLesson.id) ||
                    !!buildTaskByLesson[selectedLesson.id]
                  }
                  className="gap-2"
                >
                  <Hammer className="w-4 h-4" />
                  {buildingLessonIds.has(selectedLesson.id)
                    ? "Building..."
                    : buildTaskByLesson[selectedLesson.id]
                      ? "Build Started"
                      : "Mark to Build"}
                </Button>
                {buildTaskByLesson[selectedLesson.id] && (
                  <Button
                    variant="outline"
                    onClick={() => handleOpenBuiltTask(buildTaskByLesson[selectedLesson.id])}
                    className="gap-2"
                  >
                    Open Task
                  </Button>
                )}
                {selectedLesson.url && (
                  <Button
                    variant="outline"
                    onClick={() => window.open(selectedLesson.url, "_blank")}
                    className="gap-2 ml-auto"
                  >
                    <ExternalLink className="w-4 h-4" />
                    View Source
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
