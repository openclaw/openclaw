"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import {
    Send,
    MessageCircle,
    Apple,
    Shield,
    Hash,
    Gamepad2,
    Search,
    ChevronDown,
    ChevronUp,
    ExternalLink,
    Zap,
    Users,
    Bot,
    ShoppingCart,
    Calendar,
    Globe,
    Lock,
    Briefcase,
    Sparkles,
    MessagesSquare,
    Plug,
    CheckCircle2,
    Eye,
    EyeOff,
    Loader2,
    Trash2,
    BookOpen,
    Star,
    Megaphone,
    Headphones,
    BarChart3,
    FileText,
    Workflow,
    Clock,
    Bell,
    Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-fetch";

// ── Types ────────────────────────────────────────────────────────────────────

interface UseCase {
    title: string;
    description: string;
    icon: React.ReactNode;
    category: string;
}

interface BestPractice {
    title: string;
    tip: string;
}

interface CredentialField {
    key: string;
    label: string;
    placeholder: string;
    sensitive?: boolean;
    required?: boolean;
}

interface IntegrationStatus {
    configured: boolean;
    preview: string | null;
    username: string | null;
    teamId: string | null;
    updatedAt: string | null;
}

interface Platform {
    id: string;
    serviceId: string; // maps to INTEGRATION_SERVICES
    name: string;
    tagline: string;
    icon: React.ReactNode;
    gradient: string;
    borderColor: string;
    glowColor: string;
    users: string;
    apiAvailable: boolean;
    docsUrl: string;
    credentialFields: CredentialField[];
    useCases: UseCase[];
    bestPractices: BestPractice[];
    setupSteps: string[];
    gettingStarted: { step: string; detail: string }[];
}

// ── Platform Data ────────────────────────────────────────────────────────────

const PLATFORMS: Platform[] = [
    {
        id: "telegram",
        serviceId: "telegram",
        name: "Telegram",
        tagline: "The power-user's messaging platform",
        icon: <Send className="w-6 h-6" />,
        gradient: "from-sky-500 to-blue-600",
        borderColor: "border-sky-500/30",
        glowColor: "shadow-sky-500/20",
        users: "900M+",
        apiAvailable: true,
        docsUrl: "https://core.telegram.org/bots/api",
        credentialFields: [
            { key: "token", label: "Bot Token", placeholder: "123456:ABC-DEF...", sensitive: true, required: true },
            { key: "username", label: "Bot Username", placeholder: "@YourBotName" },
        ],
        useCases: [
            {
                title: "Customer Support Bot",
                description: "Deploy a 24/7 AI agent that handles FAQs, troubleshoots issues, and escalates complex tickets to human agents. Supports inline keyboards for structured flows.",
                icon: <Headphones className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Task Automation Agent",
                description: "Automate daily reports, monitor servers, track prices, and manage to-do lists — all from your Telegram chat. Schedule recurring tasks with cron-like precision.",
                icon: <Zap className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Knowledge Base Q&A",
                description: "Connect your documentation, wiki, or internal knowledge base. The bot uses RAG (Retrieval-Augmented Generation) to provide accurate, sourced answers.",
                icon: <BookOpen className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Scheduled Reports & Alerts",
                description: "Receive automated daily summaries, KPI dashboards, and real-time alerts for server health, sales milestones, or deadline reminders.",
                icon: <Bell className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Group Management",
                description: "Moderate group chats with AI-powered content filtering, welcome messages for new members, and automated rule enforcement.",
                icon: <Users className="w-4 h-4" />,
                category: "community",
            },
            {
                title: "E-Commerce Storefront",
                description: "Build a full shopping experience inside Telegram: product catalog, cart management, payment processing, and order tracking with inline payments API.",
                icon: <ShoppingCart className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Lead Capture & Qualification",
                description: "Capture leads from Telegram channels and groups. Ask qualifying questions, score leads, and push hot leads to your CRM automatically.",
                icon: <Star className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Multi-Language Support Agent",
                description: "Detect user language automatically and respond in 50+ languages. Route complex queries to language-specific human operators when needed.",
                icon: <Globe className="w-4 h-4" />,
                category: "support",
            },
        ],
        bestPractices: [
            { title: "Use Inline Keyboards", tip: "Structured button menus reduce user friction and guide conversations through predefined paths." },
            { title: "Implement Conversation Memory", tip: "Store context per user/session so your bot remembers past interactions and provides personalized responses." },
            { title: "Leverage Bot Commands", tip: "Register slash commands (/help, /status, /report) for quick access to core features." },
            { title: "Use Webhook Mode", tip: "Webhooks are more efficient than polling for production bots — faster response times, less server load." },
            { title: "Rate Limit Responses", tip: "Telegram limits 30 messages/second globally. Use message queuing to avoid hitting limits in large groups." },
            { title: "Implement Menu Buttons", tip: "Configure a persistent menu button that opens a web app or shows available commands for better UX." },
        ],
        setupSteps: [
            "Create a bot via BotFather and obtain your API token",
            "Configure the OpenClaw Telegram integration with your token",
            "Set up webhook URL pointing to your OpenClaw gateway",
            "Define conversation flows and AI agent behaviors",
            "Test with a small group before deploying publicly",
        ],
        gettingStarted: [
            { step: "Create Your Bot", detail: "Open Telegram, search for @BotFather, send /newbot, and follow the prompts. Save the token it gives you." },
            { step: "Paste Token Here", detail: "Click 'Connect' above and paste your bot token. We'll validate it automatically." },
            { step: "Configure Webhook", detail: "Once connected, OpenClaw sets up a webhook endpoint so your bot receives messages in real-time." },
            { step: "Build Your Agent", detail: "Go to Agents → create a new agent, then assign your Telegram bot as its messaging channel." },
        ],
    },
    {
        id: "whatsapp",
        serviceId: "whatsapp",
        name: "WhatsApp",
        tagline: "The world's most-used messenger",
        icon: <MessageCircle className="w-6 h-6" />,
        gradient: "from-emerald-500 to-green-600",
        borderColor: "border-emerald-500/30",
        glowColor: "shadow-emerald-500/20",
        users: "2.7B+",
        apiAvailable: true,
        docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
        credentialFields: [
            { key: "token", label: "Access Token", placeholder: "EAABs...", sensitive: true, required: true },
            { key: "username", label: "Phone Number ID", placeholder: "1234567890" },
            { key: "teamId", label: "Business Account ID", placeholder: "9876543210" },
        ],
        useCases: [
            {
                title: "Lead Generation & Nurturing",
                description: "Qualify leads with automated question flows, segment audiences, and run personalized drip campaigns. Recover abandoned carts with timed follow-up messages.",
                icon: <Star className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Order Tracking & Updates",
                description: "Send instant order confirmations, shipping notifications, delivery status updates, and payment reminders — all within the customer's favorite app.",
                icon: <ShoppingCart className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Appointment Booking",
                description: "Manage the entire booking lifecycle: check availability, schedule appointments, send reminders, and handle rescheduling — all conversationally.",
                icon: <Calendar className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Multilingual Support",
                description: "Automatically detect customer language and respond in their preferred language. Serve a global customer base without language barriers.",
                icon: <Globe className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Catalog & In-Chat Shopping",
                description: "Showcase products directly in WhatsApp. Customers browse, select, and complete purchases without leaving the conversation. Integrate with Shopify and WooCommerce.",
                icon: <ShoppingCart className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Broadcast Campaigns",
                description: "Send targeted promotional messages to segmented audiences using approved templates. Track open rates, click-through, and conversion metrics.",
                icon: <Megaphone className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Customer Feedback & Surveys",
                description: "Collect NPS scores, CSAT ratings, and detailed feedback through interactive WhatsApp surveys. Analyze sentiment with AI and route issues automatically.",
                icon: <BarChart3 className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Document Processing",
                description: "Receive documents (invoices, receipts, forms) via WhatsApp. AI extracts key data, validates information, and routes to the appropriate workflow.",
                icon: <FileText className="w-4 h-4" />,
                category: "automation",
            },
        ],
        bestPractices: [
            { title: "Respect Template Policies", tip: "WhatsApp requires pre-approved message templates for outbound messages. Plan your templates early and keep them conversational." },
            { title: "Use the 24-Hour Window", tip: "You can freely message users within 24 hours of their last message. After that, only approved templates can be sent." },
            { title: "Optimize for Mobile", tip: "Keep messages short and scannable. Use buttons and quick replies instead of asking users to type responses." },
            { title: "Integrate with CRM", tip: "Connect to HubSpot, Salesforce, or your CRM to enrich conversations with customer data and log interactions." },
            { title: "Use Interactive Messages", tip: "List messages and reply buttons increase engagement by 40%. Always prefer structured options over free-text input." },
            { title: "Implement Opt-In/Opt-Out", tip: "Always provide a clear way for users to opt out. This prevents spam reports and keeps your quality rating high." },
        ],
        setupSteps: [
            "Apply for WhatsApp Business API access via Meta",
            "Configure your business profile and verified phone number",
            "Connect the WhatsApp Cloud API to OpenClaw",
            "Create and submit message templates for approval",
            "Build conversational flows with AI-powered responses",
        ],
        gettingStarted: [
            { step: "Create Meta Business App", detail: "Go to developers.facebook.com → Create App → select Business type → add WhatsApp product." },
            { step: "Get API Credentials", detail: "In your app's WhatsApp settings, generate a permanent access token and note your Phone Number ID." },
            { step: "Connect to OpenClaw", detail: "Paste your access token and IDs above. We'll set up the webhook and message routing." },
            { step: "Submit Message Templates", detail: "Create templates for outbound messages. Meta reviews them within 24 hours." },
        ],
    },
    {
        id: "imessage",
        serviceId: "imessage",
        name: "iMessage",
        tagline: "Seamless in the Apple ecosystem",
        icon: <Apple className="w-6 h-6" />,
        gradient: "from-blue-500 to-indigo-600",
        borderColor: "border-blue-500/30",
        glowColor: "shadow-blue-500/20",
        users: "1.3B+",
        apiAvailable: false,
        docsUrl: "https://developer.apple.com/business-chat/",
        credentialFields: [
            { key: "token", label: "Relay Endpoint URL", placeholder: "http://localhost:8080/imessage", required: true },
            { key: "username", label: "Apple ID", placeholder: "your@apple.id" },
        ],
        useCases: [
            {
                title: "Personal AI Assistant",
                description: "Turn iMessage into your personal command center. Manage tasks, set reminders, get summaries, and execute actions — all by texting your AI agent.",
                icon: <Sparkles className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Smart Replies & Summarization",
                description: "AI-powered message summarization for group chats, smart reply suggestions based on context, and priority notification filtering.",
                icon: <MessagesSquare className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Task Management & Booking",
                description: "Book flights, cancel subscriptions, manage appointments, and handle email — directly from iMessage without switching apps.",
                icon: <Calendar className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Apple Shortcuts Integration",
                description: "Create powerful automation chains using Apple Shortcuts + AI. Trigger complex workflows from a single iMessage command.",
                icon: <Zap className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Apple Business Chat",
                description: "Enable customers to reach your business via Messages. Support Apple Pay integration for in-chat purchases and appointment scheduling.",
                icon: <Briefcase className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Family & Home Automation",
                description: "Control HomeKit devices, check security cameras, manage family calendars, and coordinate activities — all through natural language in iMessage.",
                icon: <Workflow className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Health & Fitness Coach",
                description: "Get personalized workout reminders, nutrition tips, and health summaries from Apple Health data — delivered conversationally through iMessage.",
                icon: <Star className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Travel Concierge",
                description: "AI concierge that tracks flights, suggests restaurants, books rides, and handles travel logistics — all without leaving your Messages app.",
                icon: <Globe className="w-4 h-4" />,
                category: "automation",
            },
        ],
        bestPractices: [
            { title: "Leverage Apple Intelligence", tip: "Use on-device AI models for privacy-first processing. Apple Intelligence can summarize, prioritize, and draft within the ecosystem." },
            { title: "Design for Natural Language", tip: "iMessage users expect conversational interactions. Make your bot feel like texting a capable friend, not using a command-line." },
            { title: "Use Rich Links & Tap Backs", tip: "Take advantage of iMessage's rich content features — link previews, tap-back reactions, and interactive widgets." },
            { title: "Respect Privacy First", tip: "Apple users value privacy highly. Process data on-device when possible and be transparent about what data you collect." },
            { title: "Integrate with Siri Suggestions", tip: "Let Siri learn from bot interactions to suggest actions proactively — like recurring orders or scheduled messages." },
        ],
        setupSteps: [
            "Set up OpenClaw with iMessage relay (requires macOS host)",
            "Configure message routing to your AI agent",
            "Create Apple Shortcuts for common AI actions",
            "Set up Apple Business Chat for customer-facing interactions",
            "Test end-to-end on iOS devices",
        ],
        gettingStarted: [
            { step: "Set Up macOS Relay", detail: "iMessage requires a macOS host. Install the OpenClaw iMessage relay on a Mac that stays online." },
            { step: "Configure Apple ID", detail: "Sign into iMessage with a dedicated Apple ID for your bot to avoid conflicts with personal messages." },
            { step: "Enter Relay URL", detail: "Paste the relay endpoint URL above. OpenClaw will route messages to and from iMessage through it." },
            { step: "Test & Deploy", detail: "Send a test message to your bot's Apple ID and verify the AI responds correctly." },
        ],
    },
    {
        id: "signal",
        serviceId: "signal",
        name: "Signal",
        tagline: "Privacy-first secure messaging",
        icon: <Shield className="w-6 h-6" />,
        gradient: "from-blue-600 to-blue-800",
        borderColor: "border-blue-600/30",
        glowColor: "shadow-blue-600/20",
        users: "100M+",
        apiAvailable: false,
        docsUrl: "https://signal.org/docs/",
        credentialFields: [
            { key: "token", label: "Signal CLI Endpoint", placeholder: "http://localhost:8081/signal", required: true },
            { key: "username", label: "Phone Number", placeholder: "+1234567890" },
        ],
        useCases: [
            {
                title: "Privacy-First AI Assistant",
                description: "Run a fully local AI assistant over Signal's end-to-end encrypted protocol. Your messages and data never leave your control.",
                icon: <Lock className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Secure Team Communications",
                description: "AI-powered workflow assistance for teams: meeting scheduling, discussion summaries, real-time translation, and smart task assignment.",
                icon: <Users className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Encrypted Document Workflows",
                description: "Share, collaborate on, and extract data from documents securely. AI can summarize, translate, and route documents within encrypted channels.",
                icon: <FileText className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Automated Smart Replies",
                description: "Set up context-aware auto-replies for when you're busy, traveling, or in meetings. Rules-based with AI fallback for complex messages.",
                icon: <MessagesSquare className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Whistleblower & Compliance Channels",
                description: "Create secure, anonymous reporting channels with AI-assisted intake, triage, and routing — all protected by Signal's encryption.",
                icon: <Shield className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Secure Healthcare Updates",
                description: "HIPAA-compliant patient notifications: appointment reminders, test results, prescription updates — all end-to-end encrypted.",
                icon: <Lock className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Encrypted Alerts Pipeline",
                description: "Route sensitive system alerts (security incidents, financial anomalies, threshold breaches) through Signal for guaranteed secure delivery.",
                icon: <Bell className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Private Research Assistant",
                description: "Search the web, summarize papers, and analyze data without exposing your queries. Perfect for journalists, lawyers, and researchers.",
                icon: <BookOpen className="w-4 h-4" />,
                category: "automation",
            },
        ],
        bestPractices: [
            { title: "Keep Everything Local", tip: "Signal's encryption means you should process messages locally. Use on-device AI models or self-hosted LLMs for maximum security." },
            { title: "Use Signal's REST API", tip: "Host a Signal CLI or REST API endpoint locally for bot integration. Never expose Signal credentials externally." },
            { title: "Minimize Data Retention", tip: "Store only what's necessary. Auto-delete conversation logs and implement strict data lifecycle policies." },
            { title: "Document Compliance", tip: "If using for business, ensure your AI integration complies with relevant regulations (GDPR, HIPAA, etc.)." },
            { title: "Use Disappearing Messages", tip: "Leverage Signal's disappearing messages feature for sensitive conversations. Set appropriate timeouts." },
        ],
        setupSteps: [
            "Register a dedicated Signal number for your bot",
            "Install signal-cli or signald on your server",
            "Connect Signal to OpenClaw via the gateway",
            "Configure local AI model for privacy-first processing",
            "Set up auto-reply rules and conversation triggers",
        ],
        gettingStarted: [
            { step: "Get a Dedicated Number", detail: "Register a separate phone number for your Signal bot. You can use a VoIP number or a prepaid SIM." },
            { step: "Install signal-cli", detail: "Set up signal-cli on your server: `apt install signal-cli` or use the Docker image." },
            { step: "Register & Connect", detail: "Register the number with signal-cli, then enter your endpoint URL above to connect to OpenClaw." },
            { step: "Configure Privacy Rules", detail: "Set up data retention policies, disappearing messages, and local AI processing rules." },
        ],
    },
    {
        id: "slack",
        serviceId: "slack",
        name: "Slack",
        tagline: "The enterprise collaboration hub",
        icon: <Hash className="w-6 h-6" />,
        gradient: "from-purple-500 to-fuchsia-600",
        borderColor: "border-purple-500/30",
        glowColor: "shadow-purple-500/20",
        users: "65M+",
        apiAvailable: true,
        docsUrl: "https://api.slack.com/docs",
        credentialFields: [
            { key: "token", label: "Bot Token", placeholder: "xoxb-...", sensitive: true, required: true },
            { key: "username", label: "Signing Secret", placeholder: "a1b2c3d4..." },
            { key: "teamId", label: "App ID", placeholder: "A01BCDE2FGH" },
        ],
        useCases: [
            {
                title: "Workflow Automation",
                description: "Trigger multi-step workflows from a single Slack message: create support tickets, update CRMs, notify stakeholders, and generate reports.",
                icon: <Workflow className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Enterprise Knowledge Bot (RAG)",
                description: "Build a Slack bot that answers questions from your company's knowledge base using Retrieval-Augmented Generation. Surface HR policies, SOPs, and technical docs instantly.",
                icon: <BookOpen className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Meeting Summarizer",
                description: "Automatically summarize Slack huddles, threads, and channels. Generate action items, flag blockers, and draft follow-up messages.",
                icon: <FileText className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Sales Pipeline Assistant",
                description: "Receive deal alerts, schedule follow-ups, get pipeline summaries, and log CRM updates — all from Slack. Turn conversations into revenue.",
                icon: <Briefcase className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Incident Response",
                description: "Triage incoming alerts, spin up incident channels, assign on-call engineers, track resolution progress, and generate postmortem reports.",
                icon: <Shield className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "HR & Onboarding Bot",
                description: "Automate employee onboarding: provision accounts, send welcome kits, schedule training sessions, and answer policy questions via AI.",
                icon: <Users className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Standup & Retro Bot",
                description: "Collect daily standups asynchronously, generate sprint summaries, facilitate retrospectives, and track team velocity trends.",
                icon: <Clock className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Data Analytics Assistant",
                description: "Query databases, generate charts, and share insights — all from a Slack command. Connect to BigQuery, Snowflake, or your data warehouse.",
                icon: <BarChart3 className="w-4 h-4" />,
                category: "automation",
            },
        ],
        bestPractices: [
            { title: "Minimize Noise", tip: "Use threads and ephemeral messages to keep channels clean. Only post to main channels for important updates." },
            { title: "Use Slack's Block Kit", tip: "Create rich, interactive messages with buttons, dropdowns, and modals for a polished user experience." },
            { title: "Implement Role-Based Access", tip: "Ensure your bot respects Slack workspace roles. Different channels should trigger different levels of AI authority." },
            { title: "Log Everything", tip: "Maintain audit logs of all AI actions taken via Slack for compliance and debugging purposes." },
            { title: "Handle Socket vs Events API", tip: "Use Socket Mode for development and Events API for production. Socket Mode doesn't require a public URL." },
            { title: "Implement Slash Commands", tip: "Register custom slash commands (/report, /ask, /create) for discoverable, consistent bot interactions." },
        ],
        setupSteps: [
            "Create a Slack App in your workspace's developer console",
            "Configure bot scopes and OAuth permissions",
            "Connect Slack's Events API to OpenClaw",
            "Build slash commands and interactive workflows",
            "Deploy to your workspace and invite the bot to channels",
        ],
        gettingStarted: [
            { step: "Create Slack App", detail: "Go to api.slack.com/apps → Create New App → From scratch. Select your workspace." },
            { step: "Configure Bot Scopes", detail: "Under OAuth & Permissions, add scopes: chat:write, channels:read, groups:read, im:read, im:write." },
            { step: "Install & Get Token", detail: "Install the app to your workspace. Copy the Bot User OAuth Token (xoxb-...) and paste it above." },
            { step: "Set Up Events", detail: "Configure the Events API URL to receive messages. OpenClaw provides the webhook endpoint automatically." },
        ],
    },
    {
        id: "discord",
        serviceId: "discord",
        name: "Discord",
        tagline: "Community-first communication",
        icon: <Gamepad2 className="w-6 h-6" />,
        gradient: "from-indigo-500 to-violet-600",
        borderColor: "border-indigo-500/30",
        glowColor: "shadow-indigo-500/20",
        users: "200M+",
        apiAvailable: true,
        docsUrl: "https://discord.com/developers/docs",
        credentialFields: [
            { key: "token", label: "Bot Token", placeholder: "MTI3...", sensitive: true, required: true },
            { key: "teamId", label: "Application ID", placeholder: "1234567890" },
        ],
        useCases: [
            {
                title: "Community Management",
                description: "Automate moderation, welcome new members, answer FAQs, and foster engagement with AI-powered conversation starters and role assignments.",
                icon: <Users className="w-4 h-4" />,
                category: "community",
            },
            {
                title: "Tier-1 Support Bot",
                description: "Handle common support questions automatically, create support tickets from Discord messages, and escalate complex issues to human moderators.",
                icon: <Headphones className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Onboarding Flows",
                description: "Guide new server members through setup: role selection, rule acknowledgment, introduction channels, and personalized resource recommendations.",
                icon: <Sparkles className="w-4 h-4" />,
                category: "community",
            },
            {
                title: "Content Moderation",
                description: "AI-powered real-time moderation: detect toxic language, spam, and unwanted content. Auto-warn, mute, or escalate based on severity.",
                icon: <Shield className="w-4 h-4" />,
                category: "community",
            },
            {
                title: "Event & Campaign Manager",
                description: "Schedule events, run polls, manage RSVPs, send reminders, and coordinate activities across your community with AI-assisted planning.",
                icon: <Calendar className="w-4 h-4" />,
                category: "community",
            },
            {
                title: "Music & Media Bot",
                description: "AI-curated playlists, voice channel DJ, media recommendations, and interactive music quizzes for community engagement.",
                icon: <Star className="w-4 h-4" />,
                category: "community",
            },
            {
                title: "Developer Community Hub",
                description: "Code review bot, documentation search, bug triage, release announcements, and automated issue tracking for developer communities.",
                icon: <Bot className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Analytics & Engagement Dashboard",
                description: "Track server growth, message activity, member engagement, and channel performance. Generate weekly reports and identify trending topics.",
                icon: <BarChart3 className="w-4 h-4" />,
                category: "community",
            },
        ],
        bestPractices: [
            { title: "Use Slash Commands", tip: "Discord's slash command system provides discoverability and autocomplete, making your bot intuitive to use." },
            { title: "Respect Rate Limits", tip: "Discord has strict rate limits. Use queuing and implement exponential backoff for message-heavy bots." },
            { title: "Leverage Embeds", tip: "Use rich embeds for structured responses — color-coded, with fields, thumbnails, and action buttons." },
            { title: "Scope Permissions Carefully", tip: "Request only the permissions your bot needs. Use per-channel overrides for sensitive areas." },
            { title: "Use Threads for Long Conversations", tip: "Auto-create threads for support conversations to keep channels organized and searchable." },
            { title: "Implement Autocomplete", tip: "Add autocomplete to slash commands for a premium UX. Users see suggestions as they type." },
        ],
        setupSteps: [
            "Create a Discord Application in the Developer Portal",
            "Add a Bot user and configure intents (Message Content, etc.)",
            "Generate an OAuth2 invite link with required scopes",
            "Connect Discord's Gateway to OpenClaw via websocket",
            "Implement slash commands and set up moderation rules",
        ],
        gettingStarted: [
            { step: "Create Discord Application", detail: "Go to discord.com/developers → New Application → name it → go to the Bot section and create a bot." },
            { step: "Enable Privileged Intents", detail: "Enable Message Content Intent, Server Members Intent, and Presence Intent in the Bot settings." },
            { step: "Copy Bot Token", detail: "Click 'Reset Token' in the Bot section, copy the token, and paste it above." },
            { step: "Invite to Your Server", detail: "Generate an invite link with proper scopes and invite the bot to your server." },
        ],
    },
    {
        id: "gmail",
        serviceId: "gmail",
        name: "Gmail",
        tagline: "Google's email powerhouse — 1.8B users",
        icon: <Mail className="w-6 h-6" />,
        gradient: "from-red-500 to-orange-500",
        borderColor: "border-red-500/30",
        glowColor: "shadow-red-500/20",
        users: "1.8B+",
        apiAvailable: true,
        docsUrl: "https://developers.google.com/gmail/api",
        credentialFields: [
            { key: "token", label: "OAuth Client ID", placeholder: "xxxx.apps.googleusercontent.com", required: true },
            { key: "username", label: "Client Secret", placeholder: "GOCSPX-...", sensitive: true },
            { key: "teamId", label: "Refresh Token", placeholder: "1//0e...", sensitive: true },
        ],
        useCases: [
            {
                title: "Smart Email Triage",
                description: "AI automatically categorizes, prioritizes, and summarizes incoming emails. Flag urgent items, snooze noise, and draft responses for review.",
                icon: <Sparkles className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Auto-Reply & Follow-Up",
                description: "Generate context-aware draft replies for common inquiries. Schedule follow-up reminders for unanswered emails and track response rates.",
                icon: <MessagesSquare className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Lead Capture from Inbox",
                description: "Parse inbound sales emails, extract lead details, score them with AI, and push qualified leads to your CRM. Auto-respond with initial outreach.",
                icon: <Star className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Customer Support via Email",
                description: "Route support emails to AI agents that can resolve common issues, look up order status, process refunds, and escalate complex cases.",
                icon: <Headphones className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Newsletter & Digest Generator",
                description: "Compile and send personalized email digests, newsletters, and updates. AI curates content based on recipient interests and engagement history.",
                icon: <Megaphone className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Invoice & Receipt Processing",
                description: "Automatically extract data from invoices, receipts, and financial emails. Log expenses, match to POs, and flag discrepancies.",
                icon: <FileText className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Email Campaign Analytics",
                description: "Track open rates, click-through, reply rates, and engagement patterns. AI provides actionable insights to optimize future campaigns.",
                icon: <BarChart3 className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Meeting Scheduler",
                description: "Parse meeting requests from emails, check Google Calendar availability, propose times, and send calendar invites — all automatically.",
                icon: <Calendar className="w-4 h-4" />,
                category: "automation",
            },
        ],
        bestPractices: [
            { title: "Use OAuth 2.0 Properly", tip: "Always use OAuth 2.0 with refresh tokens. Never store user passwords. Request minimal scopes (gmail.readonly, gmail.send, gmail.modify)." },
            { title: "Respect Gmail API Quotas", tip: "Gmail API has a 250 quota units/user/second limit. Batch requests and implement exponential backoff for rate limiting." },
            { title: "Handle Threading Correctly", tip: "Gmail uses thread IDs to group related messages. Always include In-Reply-To and References headers when sending replies." },
            { title: "Implement Push Notifications", tip: "Use Gmail's Pub/Sub push notifications instead of polling. It's faster and uses fewer API calls." },
            { title: "Sanitize HTML Content", tip: "Email HTML is notoriously unpredictable. Always sanitize HTML content before processing or displaying it." },
            { title: "Label-Based Routing", tip: "Use Gmail labels to organize AI-processed emails. Create labels like 'AI-Triaged', 'Needs-Reply', 'Auto-Responded' for workflow management." },
        ],
        setupSteps: [
            "Create a Google Cloud project and enable the Gmail API",
            "Configure OAuth 2.0 consent screen and credentials",
            "Generate refresh token via OAuth flow",
            "Connect Gmail credentials to OpenClaw integrations",
            "Configure email processing rules and AI agent assignment",
        ],
        gettingStarted: [
            { step: "Create Google Cloud Project", detail: "Go to console.cloud.google.com → create a project → enable the Gmail API under APIs & Services." },
            { step: "Set Up OAuth Credentials", detail: "Create OAuth 2.0 Client ID (desktop app type). Note down the Client ID and Client Secret." },
            { step: "Generate Refresh Token", detail: "Run the OAuth consent flow to authorize your account and obtain a refresh token for persistent access." },
            { step: "Connect to OpenClaw", detail: "Enter your Client ID, Client Secret, and Refresh Token above. OpenClaw handles token refresh automatically." },
        ],
    },
    {
        id: "outlook",
        serviceId: "outlook",
        name: "Outlook",
        tagline: "Microsoft's enterprise email & calendar",
        icon: <Mail className="w-6 h-6" />,
        gradient: "from-blue-600 to-cyan-500",
        borderColor: "border-blue-600/30",
        glowColor: "shadow-blue-600/20",
        users: "400M+",
        apiAvailable: true,
        docsUrl: "https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview",
        credentialFields: [
            { key: "token", label: "Application (Client) ID", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", required: true },
            { key: "username", label: "Client Secret", placeholder: "xxxxxxxxxxxxxxxxxxxx", sensitive: true },
            { key: "teamId", label: "Tenant ID", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
        ],
        useCases: [
            {
                title: "Enterprise Email Assistant",
                description: "AI-powered email management for organizations: auto-categorize, summarize threads, draft replies, and flag items requiring executive attention.",
                icon: <Briefcase className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Calendar & Meeting Intelligence",
                description: "Smart meeting scheduling, agenda preparation, post-meeting summary generation, and action item extraction from Outlook calendar and emails.",
                icon: <Calendar className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "IT Helpdesk via Email",
                description: "Auto-triage IT support requests, suggest solutions from knowledge base, reset passwords, provision accounts, and track ticket resolution.",
                icon: <Headphones className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Compliance & DLP Monitoring",
                description: "Scan outgoing emails for sensitive data (PII, financials, IP). Flag policy violations, quarantine suspicious attachments, and generate compliance reports.",
                icon: <Shield className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Sales Outreach Automation",
                description: "Coordinate multi-step email sequences, personalize outreach with AI, track engagement, and sync with Dynamics 365 or Salesforce.",
                icon: <Star className="w-4 h-4" />,
                category: "sales",
            },
            {
                title: "Shared Mailbox Management",
                description: "Intelligently route emails from shared mailboxes (info@, support@) to the right team member. Load-balance, track SLAs, and prevent duplicate responses.",
                icon: <Users className="w-4 h-4" />,
                category: "support",
            },
            {
                title: "Approval Workflows",
                description: "Route approval requests (POs, time-off, expenses) through email. AI pre-validates, managers approve via email buttons, and results sync back to systems.",
                icon: <Workflow className="w-4 h-4" />,
                category: "automation",
            },
            {
                title: "Cross-Platform Sync",
                description: "Sync Outlook contacts, calendars, and tasks with other platforms. Keep Teams, SharePoint, and third-party tools in perfect alignment.",
                icon: <Globe className="w-4 h-4" />,
                category: "automation",
            },
        ],
        bestPractices: [
            { title: "Use Microsoft Graph API", tip: "Access Outlook via Microsoft Graph for a unified endpoint. It provides mail, calendar, contacts, and more through a single API." },
            { title: "Implement Differential Sync", tip: "Use delta queries to get only changed messages since the last sync. This reduces API calls dramatically." },
            { title: "Handle Multi-Tenant Auth", tip: "For enterprise deployment, use multi-tenant Azure AD app registration. Support both personal and organizational accounts." },
            { title: "Use Change Notifications", tip: "Subscribe to webhook-based change notifications instead of polling. Microsoft Graph supports rich notifications with resource data." },
            { title: "Respect Throttling Limits", tip: "Graph API returns 429 (Too Many Requests) when throttled. Always implement retry-after logic and request batching." },
            { title: "Secure with Managed Identity", tip: "When running on Azure, use managed identity instead of client secrets. It eliminates credential management overhead." },
        ],
        setupSteps: [
            "Register an app in Azure Active Directory (Entra ID)",
            "Configure API permissions (Mail.Read, Mail.Send, Calendars.ReadWrite)",
            "Generate client secret or certificate",
            "Connect Outlook credentials to OpenClaw",
            "Set up email processing workflows and AI agent rules",
        ],
        gettingStarted: [
            { step: "Register Azure AD App", detail: "Go to portal.azure.com → Azure Active Directory → App registrations → New registration." },
            { step: "Configure Permissions", detail: "Under API Permissions, add Microsoft Graph (delegated): Mail.Read, Mail.Send, Calendars.ReadWrite." },
            { step: "Generate Client Secret", detail: "Under Certificates & Secrets, create a new client secret. Copy the value immediately — it's shown only once." },
            { step: "Connect to OpenClaw", detail: "Enter your Application ID, Client Secret, and Tenant ID above. We'll handle the OAuth flow." },
        ],
    },
];

// ── Category Filters ─────────────────────────────────────────────────────────

const CATEGORIES = [
    { id: "all", label: "All", icon: <Sparkles className="w-3.5 h-3.5" /> },
    { id: "automation", label: "Automation", icon: <Zap className="w-3.5 h-3.5" /> },
    { id: "support", label: "Support", icon: <Headphones className="w-3.5 h-3.5" /> },
    { id: "sales", label: "Sales & Marketing", icon: <ShoppingCart className="w-3.5 h-3.5" /> },
    { id: "community", label: "Community", icon: <Users className="w-3.5 h-3.5" /> },
    { id: "email", label: "Email", icon: <Mail className="w-3.5 h-3.5" /> },
];

// ── Connect Form ─────────────────────────────────────────────────────────────

function ConnectForm({
    platform,
    status,
    onSave,
    onDisconnect,
    onClose,
}: {
    platform: Platform;
    status: IntegrationStatus | null;
    onSave: (fields: Record<string, string>) => Promise<void>;
    onDisconnect: () => Promise<void>;
    onClose: () => void;
}) {
    const [fields, setFields] = useState<Record<string, string>>({});
    const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({});
    const [saving, setSaving] = useState(false);
    const [disconnecting, setDisconnecting] = useState(false);

    const isConnected = status?.configured ?? false;

    const handleSave = async () => {
        setSaving(true);
        try {
            await onSave(fields);
            setFields({});
        } finally {
            setSaving(false);
        }
    };

    const handleDisconnect = async () => {
        if (!window.confirm(`Disconnect ${platform.name}? You can reconnect anytime.`)) return;
        setDisconnecting(true);
        try {
            await onDisconnect();
        } finally {
            setDisconnecting(false);
        }
    };

    const requiredFields = platform.credentialFields.filter((f) => f.required);
    const allRequiredFilled = requiredFields.every((f) => (fields[f.key] || "").trim().length > 0);

    return (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
            {isConnected ? (
                <>
                    <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                        <span className="font-medium text-sm text-emerald-400">Connected</span>
                        {status?.updatedAt && (
                            <span className="text-[10px] text-muted-foreground ml-auto">
                                since {new Date(status.updatedAt).toLocaleDateString()}
                            </span>
                        )}
                    </div>
                    <div className="space-y-1.5 text-xs">
                        {status?.preview && (
                            <div className="flex gap-2">
                                <span className="text-muted-foreground">Token:</span>
                                <span className="font-mono">{status.preview}</span>
                            </div>
                        )}
                        {status?.username && (
                            <div className="flex gap-2">
                                <span className="text-muted-foreground">{platform.credentialFields[1]?.label || "Username"}:</span>
                                <span className="font-mono">{status.username}</span>
                            </div>
                        )}
                        {status?.teamId && (
                            <div className="flex gap-2">
                                <span className="text-muted-foreground">{platform.credentialFields[2]?.label || "ID"}:</span>
                                <span className="font-mono">{status.teamId}</span>
                            </div>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
                            Close
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleDisconnect}
                            disabled={disconnecting}
                            className="text-xs"
                        >
                            {disconnecting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Trash2 className="w-3 h-3 mr-1" />}
                            Disconnect
                        </Button>
                    </div>
                </>
            ) : (
                <>
                    <p className="text-sm font-medium flex items-center gap-2">
                        <Plug className="w-4 h-4 text-primary" />
                        Connect {platform.name}
                    </p>
                    <div className="space-y-2.5">
                        {platform.credentialFields.map((field) => (
                            <div key={field.key} className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                                    {field.label}
                                    {field.required && <span className="text-red-400">*</span>}
                                </label>
                                <div className="relative">
                                    <input
                                        type={field.sensitive && !showSensitive[field.key] ? "password" : "text"}
                                        value={fields[field.key] || ""}
                                        onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                        placeholder={field.placeholder}
                                        className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono text-xs pr-8"
                                    />
                                    {field.sensitive && (
                                        <button
                                            type="button"
                                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            onClick={() => setShowSensitive((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                                        >
                                            {showSensitive[field.key] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleSave}
                            disabled={!allRequiredFilled || saving}
                            className="text-xs"
                        >
                            {saving ? (
                                <Loader2 className="w-3 h-3 animate-spin mr-1" />
                            ) : (
                                <Plug className="w-3 h-3 mr-1" />
                            )}
                            {saving ? "Connecting..." : "Connect"}
                        </Button>
                        <a
                            href={platform.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-auto text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
                        >
                            <ExternalLink className="w-3 h-3" />
                            Docs
                        </a>
                    </div>
                </>
            )}
        </div>
    );
}

// ── Platform Card ────────────────────────────────────────────────────────────

function PlatformCard({
    platform,
    activeCategory,
    integrationStatus,
    onConnect,
    onDisconnect,
}: {
    platform: Platform;
    activeCategory: string;
    integrationStatus: IntegrationStatus | null;
    onConnect: (serviceId: string, fields: Record<string, string>) => Promise<void>;
    onDisconnect: (serviceId: string) => Promise<void>;
}) {
    const [expanded, setExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState<"usecases" | "practices" | "setup" | "getting-started">("usecases");
    const [showConnect, setShowConnect] = useState(false);

    const isConnected = integrationStatus?.configured ?? false;

    const filteredUseCases =
        activeCategory === "all"
            ? platform.useCases
            : platform.useCases.filter((uc) => uc.category === activeCategory);

    const tabs = [
        { id: "usecases" as const, label: `Use Cases (${platform.useCases.length})` },
        { id: "practices" as const, label: "Best Practices" },
        { id: "getting-started" as const, label: "Getting Started" },
        { id: "setup" as const, label: "Setup Guide" },
    ];

    return (
        <div
            className={`rounded-2xl border ${platform.borderColor} bg-card/80 backdrop-blur-sm overflow-hidden transition-all duration-300 hover:shadow-lg group`}
        >
            {/* Card Header */}
            <div
                className={`bg-gradient-to-r ${platform.gradient} px-5 py-4 flex items-center justify-between cursor-pointer`}
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center text-white shadow-lg">
                        {platform.icon}
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-white font-bold text-lg leading-tight">{platform.name}</h3>
                            {isConnected && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/20 text-white text-[10px] font-semibold backdrop-blur-sm">
                                    <CheckCircle2 className="w-3 h-3" /> Connected
                                </span>
                            )}
                        </div>
                        <p className="text-white/70 text-xs">{platform.tagline}</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <div className="text-right hidden sm:block">
                        <p className="text-white/90 text-xs font-medium">{platform.users} users</p>
                        <p className="text-white/60 text-[10px]">
                            API: {platform.apiAvailable ? "✅ Official" : "🔧 Custom"}
                        </p>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        className={`h-8 px-3 text-xs font-medium border backdrop-blur-sm transition-all ${isConnected
                            ? "bg-white/20 border-white/30 text-white hover:bg-white/30"
                            : "bg-white/10 border-white/20 text-white hover:bg-white/20"
                            }`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowConnect(!showConnect);
                            if (!expanded) setExpanded(true);
                        }}
                    >
                        {isConnected ? (
                            <>
                                <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Manage
                            </>
                        ) : (
                            <>
                                <Plug className="w-3.5 h-3.5 mr-1" /> Connect
                            </>
                        )}
                    </Button>
                    {expanded ? (
                        <ChevronUp className="w-5 h-5 text-white/70" />
                    ) : (
                        <ChevronDown className="w-5 h-5 text-white/70" />
                    )}
                </div>
            </div>

            {/* Quick Stats */}
            <div className="px-5 py-3 flex items-center gap-4 border-b border-border/50">
                <span className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{platform.useCases.length}</span> use cases
                </span>
                <span className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{platform.bestPractices.length}</span> best practices
                </span>
                <span className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{platform.setupSteps.length}</span> setup steps
                </span>
                {isConnected && integrationStatus?.updatedAt && (
                    <span className="ml-auto text-[10px] text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        Connected {new Date(integrationStatus.updatedAt).toLocaleDateString()}
                    </span>
                )}
            </div>

            {/* Connect Form (inline, above content) */}
            {showConnect && (
                <div className="px-5 pt-4">
                    <ConnectForm
                        platform={platform}
                        status={integrationStatus}
                        onSave={async (fields) => {
                            await onConnect(platform.serviceId, fields);
                        }}
                        onDisconnect={async () => {
                            await onDisconnect(platform.serviceId);
                            setShowConnect(false);
                        }}
                        onClose={() => setShowConnect(false)}
                    />
                </div>
            )}

            {/* Expanded Content */}
            {expanded && (
                <div className="animate-in slide-in-from-top-2 duration-200">
                    {/* Tabs */}
                    <div className="flex border-b border-border/50 overflow-x-auto">
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex-shrink-0 px-4 py-2.5 text-xs font-medium transition-colors whitespace-nowrap ${activeTab === tab.id
                                    ? "text-primary border-b-2 border-primary bg-primary/5"
                                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                                    }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    <div className="p-5">
                        {/* Use Cases Tab */}
                        {activeTab === "usecases" && (
                            <div className="space-y-3">
                                {filteredUseCases.length === 0 ? (
                                    <p className="text-sm text-muted-foreground text-center py-4">
                                        No use cases in this category for {platform.name}.
                                    </p>
                                ) : (
                                    filteredUseCases.map((uc) => (
                                        <div
                                            key={uc.title}
                                            className="rounded-lg border border-border/50 p-3.5 hover:bg-accent/30 transition-colors group/uc"
                                        >
                                            <div className="flex items-start gap-3">
                                                <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${platform.gradient} flex items-center justify-center text-white shrink-0 mt-0.5 opacity-80 group-hover/uc:opacity-100 transition-opacity`}>
                                                    {uc.icon}
                                                </div>
                                                <div className="min-w-0">
                                                    <h4 className="font-semibold text-sm">{uc.title}</h4>
                                                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{uc.description}</p>
                                                    <span className="inline-block mt-2 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                                        {uc.category}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}

                        {/* Best Practices Tab */}
                        {activeTab === "practices" && (
                            <div className="space-y-3">
                                {platform.bestPractices.map((bp, idx) => (
                                    <div key={bp.title} className="flex gap-3 items-start">
                                        <div className={`w-6 h-6 rounded-full bg-gradient-to-br ${platform.gradient} flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-0.5`}>
                                            {idx + 1}
                                        </div>
                                        <div>
                                            <h4 className="font-semibold text-sm">{bp.title}</h4>
                                            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{bp.tip}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Getting Started Tab */}
                        {activeTab === "getting-started" && (
                            <div className="space-y-4">
                                {platform.gettingStarted.map((gs, idx) => (
                                    <div key={gs.step} className="flex gap-3 items-start">
                                        <div className={`w-7 h-7 rounded-lg bg-gradient-to-br ${platform.gradient} flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5`}>
                                            {idx + 1}
                                        </div>
                                        <div>
                                            <h4 className="font-semibold text-sm">{gs.step}</h4>
                                            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{gs.detail}</p>
                                        </div>
                                    </div>
                                ))}
                                <div className="mt-4 pt-4 border-t border-border/50 flex items-center gap-2">
                                    <a
                                        href={platform.docsUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-primary hover:underline flex items-center gap-1"
                                    >
                                        <ExternalLink className="w-3.5 h-3.5" />
                                        Official {platform.name} Docs
                                    </a>
                                    {!isConnected && (
                                        <Button
                                            size="sm"
                                            className="ml-auto text-xs"
                                            onClick={() => {
                                                setShowConnect(true);
                                            }}
                                        >
                                            <Plug className="w-3.5 h-3.5 mr-1" /> Connect Now
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Setup Guide Tab */}
                        {activeTab === "setup" && (
                            <ol className="space-y-2.5">
                                {platform.setupSteps.map((step, idx) => (
                                    <li key={idx} className="flex gap-3 items-start">
                                        <span className={`w-6 h-6 rounded-full bg-gradient-to-br ${platform.gradient} flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-0.5`}>
                                            {idx + 1}
                                        </span>
                                        <span className="text-sm text-foreground/90 leading-relaxed">{step}</span>
                                    </li>
                                ))}
                            </ol>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Main Page Component ──────────────────────────────────────────────────────

export function ChannelsGuidePage() {
    const [searchQuery, setSearchQuery] = useState("");
    const [activeCategory, setActiveCategory] = useState("all");

    // Integration status for all platforms
    const [integrationStatuses, setIntegrationStatuses] = useState<Record<string, IntegrationStatus>>({});
    const [loadingIntegrations, setLoadingIntegrations] = useState(true);

    // Fetch integration status on mount
    const fetchIntegrations = useCallback(async () => {
        try {
            const res = await apiFetch("/api/integrations");
            const data = await res.json();
            setIntegrationStatuses(data.integrations || {});
        } catch {
            // Silently fail — just show "Not Connected"
        } finally {
            setLoadingIntegrations(false);
        }
    }, []);

    useEffect(() => {
        fetchIntegrations();
    }, [fetchIntegrations]);

    // Connect a platform
    const handleConnect = useCallback(async (serviceId: string, fields: Record<string, string>) => {
        await apiFetch("/api/integrations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                service: serviceId,
                token: fields.token || "",
                username: fields.username || undefined,
                teamId: fields.teamId || undefined,
            }),
        });
        await fetchIntegrations();
    }, [fetchIntegrations]);

    // Disconnect a platform
    const handleDisconnect = useCallback(async (serviceId: string) => {
        await apiFetch(`/api/integrations?service=${serviceId}`, { method: "DELETE" });
        await fetchIntegrations();
    }, [fetchIntegrations]);

    const filteredPlatforms = useMemo(() => {
        if (!searchQuery.trim()) return PLATFORMS;
        const q = searchQuery.toLowerCase();
        return PLATFORMS.filter(
            (p) =>
                p.name.toLowerCase().includes(q) ||
                p.tagline.toLowerCase().includes(q) ||
                p.useCases.some(
                    (uc) =>
                        uc.title.toLowerCase().includes(q) ||
                        uc.description.toLowerCase().includes(q)
                )
        );
    }, [searchQuery]);

    const totalUseCases = PLATFORMS.reduce((sum, p) => sum + p.useCases.length, 0);
    const connectedCount = PLATFORMS.filter((p) => integrationStatuses[p.serviceId]?.configured).length;

    return (
        <div className="flex-1 min-h-0 overflow-y-auto">
            {/* Hero Section */}
            <div className="relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/5" />
                <div className="absolute top-0 right-0 w-96 h-96 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
                <div className="absolute bottom-0 left-0 w-72 h-72 bg-primary/3 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />

                <div className="relative px-6 pt-8 pb-6">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center">
                            <MessagesSquare className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold tracking-tight">Messaging Channels</h1>
                            <p className="text-sm text-muted-foreground">
                                Connect, configure, and deploy AI agents across every messaging platform
                            </p>
                        </div>
                    </div>

                    {/* Stats */}
                    <div className="flex gap-6 mt-4 mb-6">
                        <div className="text-center">
                            <p className="text-2xl font-bold text-primary">{PLATFORMS.length}</p>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Platforms</p>
                        </div>
                        <div className="text-center">
                            <p className="text-2xl font-bold text-primary">{totalUseCases}</p>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Use Cases</p>
                        </div>
                        <div className="text-center">
                            <p className="text-2xl font-bold text-primary">
                                {PLATFORMS.reduce((sum, p) => sum + p.bestPractices.length, 0)}
                            </p>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Best Practices</p>
                        </div>
                        <div className="text-center">
                            <p className={`text-2xl font-bold ${connectedCount > 0 ? "text-emerald-500" : "text-muted-foreground"}`}>
                                {loadingIntegrations ? "..." : connectedCount}
                            </p>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Connected</p>
                        </div>
                    </div>

                    {/* Search */}
                    <div className="relative max-w-xl">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search platforms, use cases, or keywords..."
                            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-border bg-background/80 backdrop-blur-sm text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
                        />
                    </div>

                    {/* Category Filters */}
                    <div className="flex flex-wrap gap-2 mt-4">
                        {CATEGORIES.map((cat) => (
                            <button
                                key={cat.id}
                                onClick={() => setActiveCategory(cat.id)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${activeCategory === cat.id
                                    ? "bg-primary text-primary-foreground shadow-md shadow-primary/25"
                                    : "bg-accent/50 text-muted-foreground hover:bg-accent hover:text-foreground"
                                    }`}
                            >
                                {cat.icon}
                                {cat.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Platform Cards */}
            <div className="px-6 pb-8 space-y-4">
                {filteredPlatforms.length === 0 ? (
                    <div className="text-center py-12">
                        <Search className="w-8 h-8 text-muted-foreground/50 mx-auto mb-3" />
                        <p className="text-sm text-muted-foreground">
                            No platforms match your search. Try different keywords.
                        </p>
                    </div>
                ) : (
                    filteredPlatforms.map((platform) => (
                        <PlatformCard
                            key={platform.id}
                            platform={platform}
                            activeCategory={activeCategory}
                            integrationStatus={integrationStatuses[platform.serviceId] || null}
                            onConnect={handleConnect}
                            onDisconnect={handleDisconnect}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
