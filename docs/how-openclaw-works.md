# How OpenClaw Works — A Technical Overview

This document is structured in two layers. Part 1 (below) is a high-level overview suitable for anyone who wants to understand what OpenClaw does and how it fits together. Parts 2 through 6 go deeper: deployment and installation, features and capabilities, internal architecture, performance and reliability, and a comparison with alternatives.

## What is OpenClaw

OpenClaw is a personal AI assistant that runs locally on your machine as a single background process called the Gateway. It connects to the messaging channels you already use -- WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Feishu, and others -- as well as companion apps on macOS, iOS, and Android. You message it like you would message a person: ask a question, give it a task, or have a conversation. Behind the scenes, it thinks using a large language model, takes action with tools on your computer, and replies through the same channel you wrote from. Because the Gateway runs on your own hardware, all of your data -- conversations, memory files, and tool output -- stays on your machine.

## The Agent Workflow

When you send a message from any channel, the Gateway receives it and routes it to the correct session. Sessions are serialized so only one turn runs at a time, preventing races or conflicting actions. The agent runtime then loads your workspace context (persona, instructions, memory) along with the session history and hands everything to the configured language model. The model produces text, tool calls, or both. Tool calls execute locally on your computer, and their results feed back into the model for further reasoning. This loop repeats until the model produces a final text reply, which streams back through the Gateway and out through the channel to you.

The Gateway is a single long-lived daemon that owns every channel connection and all session state. It stays running in the background -- typically as a menu-bar app on macOS or a system service on Linux -- so your assistant is always reachable regardless of which messaging app you open.

```
  You
   |
   v
Channel (WhatsApp, Telegram, Slack, ...)
   |
   v
Gateway (routes + serializes)
   |
   v
Agent Runtime
   |
   v
LLM Inference  <──>  Tool Execution
   |                    (shell, files,
   v                     browser, ...)
Reply streams back
   |
   v
Channel --> You
```

## Memory and Context

OpenClaw's memory is built on three layers. The first is **bootstrap files** -- plain Markdown files that the agent loads from its workspace at the start of every session. These include a persona and tone file (SOUL.md), operating instructions (AGENTS.md), a user profile (USER.md), and curated long-term memory (MEMORY.md). Together they give the agent its identity, your preferences, and accumulated knowledge before a single word of conversation is exchanged.

The second layer is **session history**. Each conversation is stored as a transcript on disk. When a session grows too large for the model's context window, OpenClaw automatically compacts it -- but first prompts the agent to save any important notes to its memory files, so nothing critical is lost. The third layer is **semantic search**. Workspace files are indexed with vector embeddings, enabling recall across sessions via hybrid keyword and vector search. This means the agent's memory extends well beyond what fits in a single conversation; it can pull in relevant notes from weeks or months ago when answering a new question.

## LLM-Driven Logic

The agent runtime assembles a system prompt from your bootstrap files, workspace context, and conversation history, then sends it to the configured language model. The model decides what to do next: reply with text, call a tool, or both. When it calls a tool, the result is fed back into the model for continued reasoning, and the loop repeats until a final text reply is produced. OpenClaw supports multiple model providers -- including Anthropic, OpenAI, Google, Mistral, DeepSeek, and Qwen -- with automatic fallback if one provider returns an error. Thinking and reasoning depth can be adjusted per request.

## Local Computer Interaction

OpenClaw ships with a set of built-in tools that let the agent interact with your computer. It can run shell commands, read and write files, edit documents, and send messages through any connected channel. The default working directory is the agent's workspace folder, so file operations stay organized. Beyond the basics, extended capabilities include browser automation, web search, media understanding (images, PDFs, and video), scheduled tasks via cron, and inbound webhooks for external triggers.

Safety is enforced through tool policies that control what each channel or session is allowed to do. For example, a group chat can be restricted to read-only tools while a private conversation has full access. Optional sandboxing can further isolate the agent's file-system reach. The agent always operates within the boundaries you configure -- it cannot escalate its own permissions.

---

# Part 2: Deployment

## Cloud Model API Setup

OpenClaw supports a wide range of cloud model providers out of the box: Anthropic (Claude), OpenAI (GPT), Google (Gemini), Mistral, DeepSeek, Qwen/Tongyi, and OpenRouter. To get started, run the interactive setup wizard (`openclaw configure`), which walks you through selecting a provider and entering credentials. For most providers this means pasting in an API key; Google also supports OAuth-based authentication. If you prefer, you can skip the wizard and edit the configuration file directly -- the result is the same.

For added reliability, you can configure multiple accounts or API keys for the same provider. If one key hits a rate limit or returns an error, OpenClaw automatically rotates to the next available key before retrying. Think of it like having several passes to the same venue: if the line at one entrance is too long, you walk to the next one. This makes your assistant more resilient without any extra effort on your part once the keys are in place.

## Local Model Deployment

If you want to run models entirely on your own hardware -- for privacy, cost, or offline access -- OpenClaw supports several local inference engines. Ollama is the recommended starting point because of its straightforward setup, but LM Studio, vLLM, and LiteLLM are also supported. The mental model is simple: install a local inference engine, pull a model, and OpenClaw discovers it automatically.

In practice, the flow looks like this: install Ollama, use it to pull a model (for example, qwen3:8b), set an environment variable telling OpenClaw to enable the local provider, and restart the Gateway. On startup, OpenClaw queries every configured local engine for its list of available models and adds them to your model menu -- no manual registration or model-by-model configuration required. If you later pull additional models into Ollama, they appear in OpenClaw the next time the Gateway starts.

## Hybrid Mode (Cloud + Local)

The most flexible setup combines cloud and local models in a single configuration -- think of it as having a primary pilot and a backup co-pilot. You designate one model as your primary (say, a cloud model for its reasoning strength) and one or more others as fallbacks (say, a fast local model for when the cloud is unreachable). If the primary provider errors out -- network blip, rate limit, outage -- OpenClaw automatically switches to the next model in the fallback chain, seamlessly and mid-conversation. The user on the other end of the chat never needs to know a swap happened.

Recovery is equally hands-off. When a provider fails, it enters a cooldown period during which OpenClaw stops sending it requests. In the background, the Gateway periodically retests the provider with lightweight probe requests. Once the provider responds successfully, OpenClaw restores it to active duty and resumes using it according to its original priority. The entire cycle -- detection, fallback, cooldown, probe, recovery -- happens without any manual intervention.

---

# Part 3: Features and Comparison

## Core Features

| Feature | Description |
|---------|-------------|
| Multi-channel | 12+ messaging channels including WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Feishu, and more |
| Always-on | Background Gateway daemon -- your assistant is always reachable |
| Tool System | Shell commands, file operations, browser automation, media understanding, scheduled tasks, webhooks |
| Persistent Memory | Three layers: identity files, conversation history, semantic search across all notes |
| Multi-model | 10+ providers (Anthropic, OpenAI, Google, DeepSeek, Qwen, Mistral...) with cloud and local model support |
| Plugin System | Extend with channel plugins, tool plugins, and lifecycle hooks |
| Local-first | All data -- conversations, memory, tool output -- stays on your machine |

## Comparison with Other Agent Frameworks

Before comparing features side by side, it helps to have a one-sentence mental model for each project:

- **Auto-GPT** = "autonomous task runner" -- launches one-shot missions that run to completion.
- **LangChain Agent** = "developer toolkit" -- a framework to build your own agent, not a ready-to-use product.
- **Open Interpreter** = "smart terminal" -- CLI-only, session-scoped, lightweight.
- **Claude Code** = "AI pair programmer" -- IDE/CLI focused, optimized for software engineering.
- **OpenClaw** = "personal assistant that lives in your messaging apps."

With those mental models in mind, here is how the projects compare across key dimensions:

| Dimension | OpenClaw | Auto-GPT | Open Interpreter | LangChain Agent | Claude Code |
|-----------|----------|----------|-----------------|-----------------|-------------|
| Positioning | Personal always-on assistant | Autonomous task runner | Smart terminal | Developer framework | AI pair programmer |
| Multi-channel | 12+ native (WhatsApp, Telegram, Slack, Feishu...) | None | None | Build your own | None |
| Always-on | Yes (Gateway daemon) | No (run-to-complete) | No (session) | Depends on implementation | No (session) |
| Persistent Memory | 3-layer system | Short-term + vector | Session only | Build your own | Session + project |
| Local Models | Native (Ollama, vLLM, LM Studio) | Limited | Yes | Via wrappers | No |
| Local-first Data | Yes | Partial | Yes | Depends | Yes |

## Strengths and Limitations

**Strengths.** OpenClaw's defining advantage is its always-on presence across the messaging apps you already use -- you do not need to open a special interface or remember a URL. Native support for 12+ channels, including Chinese ecosystem channels like Feishu, means it meets you where you are. All data stays on your machine, giving you full sovereignty over conversations and memory. The three-layer memory system (bootstrap files, session history, semantic search) provides continuity that survives individual conversations. Broad model provider support -- including Chinese-region providers like Qwen and DeepSeek -- lets you pick the best model for your situation, and the plugin architecture makes it straightforward to add new channels, tools, or behaviors without modifying the core.

**Limitations.** OpenClaw is single-user by design: it is a personal assistant, not a team or enterprise platform. The Gateway must run continuously on a local machine (or a server you control), which means you need hardware that stays on and connected. Initial setup -- choosing a model provider, connecting channels, configuring memory -- has a steeper learning curve than hosted solutions where you simply sign up and start chatting. And if you choose to run local models, the quality of responses depends directly on the hardware available to you; smaller machines will be limited to smaller, less capable models.

---

# Part 4: Technical Deep-Dive

## Agent Architecture

Mental model: **"think-act-observe loop"**

When you send a message, the agent does not just fire off a single request and return a canned answer. Instead, it enters a cycle. First, it assembles context -- gathering its persona ("who am I"), its memory notes ("what do I know"), and the conversation history ("what happened before") into one coherent package. That entire package is sent to the language model. The model reads everything and decides what to do next: it might reply directly with text, or it might request an action -- for example, "run this shell command" or "read this file." If the model requests an action, the Gateway executes it locally on your machine, observes the result, and feeds that result back to the model. The model reads the new information and decides again: reply, or take another action. This loop repeats -- sometimes just once, sometimes a dozen times -- until the model is satisfied it has a complete answer, at which point it produces a final text reply that streams back to you. Like a chef reading a recipe step by step -- taste, adjust, taste again -- until the dish is done.

```
Message In
    |
    v
[Assemble Context]
    |
    v
[Send to LLM] ──> Reply? ──Yes──> Stream reply out
    |
    No
    v
[Execute Tool]
    |
    v
[Observe Result] ──> back to [Send to LLM]
```

**For developers:** The event loop steps in a well-defined order: workspace resolution, model resolution, auth profile selection, session lock acquisition, system prompt assembly, then the LLM inference and tool execution loop, and finally session persistence. Streaming happens concurrently with this loop -- assistant text deltas, tool invocation events, and lifecycle events are all multiplexed over the same event stream so the caller sees partial progress in real time. Subagents (child agent runs spawned by the parent to handle subtasks) are tracked in a registry with announce/retry semantics and exponential backoff, ensuring that a failed subagent does not silently disappear but is retried or surfaced to the parent.

## Scheduling System

Mental model: **"one queue per conversation, one bouncer at the door"**

Each conversation (session) has its own queue, and messages in that queue are processed strictly one at a time -- no cutting in line. If you send a message while the agent is still thinking about your previous one, the new message waits its turn. This strict ordering prevents the agent from trying to do two contradictory things at once in the same conversation -- imagine asking "delete that file" and "no wait, keep it" at the same time, both executing in parallel. The queue ensures those are handled sequentially, in order.

The Gateway also enforces a global concurrency limit -- the "bouncer." Only a limited number of conversations can run simultaneously across all your channels. If you have messages arriving on WhatsApp, Telegram, and Slack all at once, the bouncer decides how many can enter the agent runtime at the same time. The rest wait in their respective queues. When you send several messages in quick succession before the agent finishes its current turn, they are batched together into a single delivery rather than creating separate turns, keeping things efficient.

There are three queue behaviors that control what happens when a new message arrives while the agent is already working:

- **Collect** (the default): gather all pending messages and deliver them as one combined turn. This is the normal behavior -- your messages accumulate and the agent sees them all at once when it is ready.
- **Steer**: inject the new message into the currently-running turn -- like slipping a note under the door while someone is already working. The agent sees your new instruction mid-thought and can adjust course without finishing the old turn first.
- **Followup**: wait patiently for the current turn to finish, then deliver the new message as the next turn. This is useful when you want to ensure the agent completes its current task before moving on.

**For developers:** Session serialization uses file-based exclusive locks (POSIX `wx` create-exclusive mode) with PID tracking and 30-minute stale lock detection so that crashed processes do not permanently block a session. The lane abstraction provides two levels of concurrency control: per-session lanes (serial, ensuring one turn at a time per conversation) and a global lane (configurable parallelism across all sessions). Generation tokens prevent stale task completions from interfering after in-process restarts -- each generation of the agent runtime gets a unique token, and completions from a previous generation are discarded. The debounce system uses per-key buffers with configurable timeouts to coalesce rapid-fire messages before they reach the queue.

## Memory Management

Mental model: **"a notebook, a filing cabinet, and a librarian"**

**The Notebook.** Every time the agent starts a conversation, it opens its notebook -- a set of plain Markdown files stored in your workspace. These files contain who the agent is (its persona and tone), how it should behave (operating instructions), what it knows about you (your profile and preferences), and what it has learned over time (accumulated memory notes). You can open these files yourself and read or edit them, just like a real notebook. If you correct the agent's understanding of something -- "I actually prefer concise answers" -- it updates its notes. Think of this as the agent's morning briefing before starting work: it reads through its notebook to remember everything before saying a word.

**The Filing Cabinet.** Every conversation is filed away as a transcript on disk. As conversations accumulate, some grow long -- too long to fit in the model's context window, which is the maximum amount of text the language model can consider at once. When this happens, the agent performs a "memory flush": it re-reads its notebook, identifies anything important from the conversation that is not already saved, writes those insights to its memory notes, and then compresses the old transcript into a summary. The full transcript is archived but the active conversation window is trimmed to fit. This ensures nothing critical is lost when old conversations are compressed -- the important bits have already been transferred to the notebook.

**The Librarian.** To recall information from weeks or months ago, the agent relies on a search system that indexes everything in your workspace using vector embeddings -- mathematical fingerprints of meaning. Unlike simple keyword search, this approach understands concepts. A query about "deployment steps" will find notes titled "setup instructions" even though the words differ, because the underlying meaning is similar. The search blends keyword matching (weighted at 30%) with semantic similarity (weighted at 70%) for the best results. This means the agent can draw on its entire history of notes and conversations, not just what fits in the current context window.

**For developers:** Temporal decay applies exponential scoring reduction to older notes with a configurable half-life (default 30 days), so recent information naturally ranks higher in search results without manually curating relevance. MMR (Maximal Marginal Relevance) re-ranks results using Jaccard similarity to prevent redundant or near-duplicate snippets from dominating the top positions. Embedding providers include cloud options (OpenAI, Gemini, Voyage, Mistral) and a fully local option via node-llama-cpp for users who want no data leaving their machine. Storage uses SQLite with the sqlite-vec extension for efficient cosine similarity search over vector embeddings, keeping the entire index in a single portable database file.

---

# Part 5: Performance Testing

## Test Environment

All benchmarks were collected on a Mac Mini M2 (Apple Silicon) with 16 GB of RAM, running on a standard home broadband connection. The cloud model was Claude Sonnet 4.5 accessed through the Anthropic API via the OpenClaw Gateway -- the same path a real user's message would take. The local model was qwen3:8b (8 billion parameters) running on Ollama, called directly through its local API rather than through the OpenClaw pipeline. These tests are not laboratory-grade benchmarks; they are real-world measurements meant to give you a feel for what day-to-day usage is like.

## Use Case 1: Simple Q&A

The first test was a straightforward factual question requiring no tools -- pure language model reasoning. The prompt asked the model to explain the three laws of thermodynamics, each in one sentence. This is the kind of quick lookup question you might send your assistant from a messaging app while reading an article.

| Metric | Cloud (Claude Sonnet) | Local (qwen3:8b) |
|--------|----------------------|-------------------|
| Total response time | ~9 seconds | ~57 seconds |
| Response quality | Excellent (5/5) -- accurate, concise, included bonus context | Good (4/5) -- accurate, clear, slightly verbose |
| Tokens generated | ~150 | ~949 (includes internal reasoning) |

The cloud model returned a polished, concise answer in under ten seconds, and as a bonus included the zeroth law of thermodynamics without being asked. The local model produced an accurate and clear response as well, but took roughly six times longer and generated significantly more tokens -- much of that spent on internal chain-of-thought reasoning before arriving at its final answer.

## Use Case 2: File Operations

The second test involved reading a 20-line text file, adding line numbers to each line, and writing the result back -- a task that exercises tool calling (file read and file write) in addition to reasoning. This was tested end-to-end through the OpenClaw Gateway with the cloud model only, because the local model was not configured as an OpenClaw model provider and therefore could not participate in the tool-calling pipeline.

| Metric | Cloud (Claude Sonnet) | Local (qwen3:8b) |
|--------|----------------------|-------------------|
| Total time | ~12.5 seconds | ~60-70 seconds (estimated) |
| Tool calls | 2 (read + write) | Expected similar |
| Accuracy | Perfect -- all 20 lines correctly numbered | Not tested end-to-end |

The cloud model completed the entire operation in about 12.5 seconds, making two tool calls (one to read the file, one to write the numbered version back) and producing a perfect result. The local model estimate is extrapolated from the roughly 6x inference speed ratio observed in the Q&A test. Running this test end-to-end with a local model would require configuring Ollama as an OpenClaw model provider, which is supported but was not part of this particular benchmark setup.

## Analysis

Cloud models deliver significantly faster responses -- roughly six times faster for simple queries in this test. The quality difference, while present, is more subtle: both models answered correctly, but the cloud model produced more polished output with contextual additions that showed deeper comprehension. For tasks that benefit from speed or complex reasoning -- multi-step tool chains, nuanced writing, or anything where you are waiting on the other end of a chat message -- cloud models are the clear choice. The 9-second response time for a factual question and 12.5 seconds for a file operation with two tool calls are both fast enough to feel conversational.

Local models shine in different scenarios. When privacy is paramount -- no data leaves your machine, period -- local inference is the only option that truly delivers. The same applies when you are offline, in a restricted network environment, or simply want to avoid per-token API costs (local inference is free after the initial hardware investment). An 8-billion-parameter model like qwen3:8b handles straightforward factual and reasoning tasks well, and larger local models in the 70-billion-parameter range narrow the quality gap with cloud models considerably. The practical sweet spot for many users is a hybrid approach: route demanding tasks (complex tool chains, creative writing, nuanced analysis) to a cloud model, and handle routine queries (quick lookups, simple file operations, casual conversation) locally. OpenClaw's fallback system makes this seamless -- you configure your preferred model order once, and the Gateway routes automatically.

---

# Part 6: Alternatives and When to Choose What

## Brief Profiles

**Auto-GPT.** Designed for autonomous multi-step task execution. Launches "missions" that run to completion without continuous interaction. Best for one-shot complex automation; lacks always-on presence and multi-channel messaging support.

**Open Interpreter.** A lightweight CLI agent that can run code and interact with your computer through the terminal. Session-scoped with no persistent memory between runs. Best for quick developer tasks and scripting from the command line.

**LangChain Agent.** A framework for building custom AI agents, not a ready-to-use product. Extremely flexible but requires significant development effort to create a working agent. Best for teams building bespoke agent-powered applications.

**Claude Code.** Anthropic's developer-focused CLI and IDE tool for software engineering tasks. Deep editor integration and codebase awareness. Best for developers who want an AI pair programmer inside their development environment.

## Head-to-Head Comparison

For a side-by-side feature comparison across all five projects, see the [comparison table in Part 3](#comparison-with-other-agent-frameworks).

## When to Choose What

Choose OpenClaw if you want an always-on personal assistant reachable across your messaging apps, with persistent memory and local data sovereignty. Choose Claude Code if you are a developer wanting AI integrated into your coding workflow. Choose Open Interpreter for quick, one-off tasks in the terminal. Choose LangChain if you are building a custom agent-powered product and need maximum flexibility. Choose Auto-GPT for autonomous multi-step missions that run without interaction.
