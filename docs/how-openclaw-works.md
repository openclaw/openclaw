# How OpenClaw Works

## What is OpenClaw

OpenClaw is a personal AI assistant that runs locally on your machine as a single background process called the Gateway. It connects to the messaging channels you already use -- WhatsApp, Telegram, Slack, Discord, Signal, iMessage, and others -- as well as companion apps on macOS, iOS, and Android. You message it like you would message a person: ask a question, give it a task, or have a conversation. Behind the scenes, it thinks using a large language model, takes action with tools on your computer, and replies through the same channel you wrote from. Because the Gateway runs on your own hardware, all of your data -- conversations, memory files, and tool output -- stays on your machine.

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

The agent runtime assembles a system prompt from your bootstrap files, workspace context, and conversation history, then sends it to the configured language model. The model decides what to do next: reply with text, call a tool, or both. When it calls a tool, the result is fed back into the model for continued reasoning, and the loop repeats until a final text reply is produced. OpenClaw supports multiple model providers -- including Anthropic, OpenAI, Google, and Mistral -- with automatic fallback if one provider returns an error. Thinking and reasoning depth can be adjusted per request.

## Local Computer Interaction

OpenClaw ships with a set of built-in tools that let the agent interact with your computer. It can run shell commands, read and write files, edit documents, and send messages through any connected channel. The default working directory is the agent's workspace folder, so file operations stay organized. Beyond the basics, extended capabilities include browser automation, web search, media understanding (images, PDFs, and video), scheduled tasks via cron, and inbound webhooks for external triggers.

Safety is enforced through tool policies that control what each channel or session is allowed to do. For example, a group chat can be restricted to read-only tools while a private conversation has full access. Optional sandboxing can further isolate the agent's file-system reach. The agent always operates within the boundaries you configure -- it cannot escalate its own permissions.
