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
