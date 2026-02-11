export class SessionContinuation {
    constructor(coreMemories, config) {
        this.cm = coreMemories;
        const defaults = {
            enabled: true,
            thresholds: { silent: 2, hint: 6, prompt: 24 },
            prioritizeFlagged: true,
            maxMemoriesToShow: 3,
        };
        // Avoid shallow-merging `thresholds` (a partial override could otherwise drop required keys).
        this.config = {
            ...defaults,
            ...config,
            thresholds: {
                ...defaults.thresholds,
                ...config?.thresholds,
            },
        };
    }
    async checkSession(userId, lastSessionTimestamp) {
        if (!this.config.enabled) {
            return {
                mode: "silent",
                shouldPrompt: false,
                context: { topMemories: [], unfinishedTasks: [] },
            };
        }
        const gapHours = (Date.now() - lastSessionTimestamp) / (1000 * 60 * 60);
        let mode;
        if (gapHours < this.config.thresholds.silent) {
            mode = "silent";
        }
        else if (gapHours < this.config.thresholds.hint) {
            mode = "hint";
        }
        else {
            mode = "prompt";
        }
        const flashEntries = this.cm.getFlashEntries();
        const topMemories = flashEntries
            .filter((e) => this.config.prioritizeFlagged ? e.userFlagged || e.emotionalSalience > 0.7 : true)
            .toSorted((a, b) => b.emotionalSalience - a.emotionalSalience)
            .slice(0, this.config.maxMemoriesToShow);
        // Prefer the most recent entry for "last topic" rather than relying on storage order.
        const mostRecent = flashEntries.toSorted((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
        // Only treat explicit task/action entries as unfinished; don't label arbitrary memories as tasks.
        const unfinishedTasks = flashEntries
            .filter((e) => e.type === "task" || e.type === "action" || e.content.startsWith("Task created:"))
            .toSorted((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, 3);
        const lastTopic = mostRecent?.content;
        const context = { topMemories, lastTopic, unfinishedTasks };
        let message;
        if (mode === "hint") {
            message = this.buildHintMessage(context);
        }
        else if (mode === "prompt") {
            message = this.buildPromptMessage(context);
        }
        return { mode, shouldPrompt: mode === "prompt", message, context };
    }
    buildHintMessage(context) {
        const { topMemories } = context;
        if (topMemories.length === 0) {
            return undefined;
        }
        const top = topMemories[0];
        if (top.emotionalSalience > 0.8) {
            return `👋 Hey! Still working on ${this.extractTopic(top.content)}?`;
        }
        return `👋 Hey!`;
    }
    buildPromptMessage(context) {
        const { topMemories, unfinishedTasks } = context;
        let message = `👋 Welcome back!\n\n`;
        if (topMemories.length > 0) {
            message += `**Last time we were working on:**\n`;
            topMemories.forEach((m) => {
                const icon = m.emotionalSalience > 0.8 ? "🎯" : "📝";
                message += `${icon} ${this.summarizeEntry(m)}\n`;
            });
            message += `\n`;
        }
        if (unfinishedTasks.length > 0) {
            message += `**Open tasks:**\n`;
            unfinishedTasks.forEach((t) => {
                message += `⏳ ${this.summarizeEntry(t)}\n`;
            });
            message += `\n`;
        }
        if (topMemories.length > 0) {
            message += `Want to continue with ${this.extractTopic(topMemories[0].content)} or start fresh?`;
        }
        else {
            message += `What would you like to work on?`;
        }
        return message;
    }
    extractTopic(content) {
        // Extract first sentence or first 40 chars as topic
        const stopChars = /[.?!]/;
        let topic = content.split(stopChars, 1)[0];
        const match = content.match(/(?:working on|building|launching|focus on)\s+(.+)/i);
        if (match) {
            topic = match[1].trim().split(stopChars, 1)[0];
        }
        if (topic.length > 40) {
            topic = topic.substring(0, 40) + "...";
        }
        return topic;
    }
    summarizeEntry(entry) {
        let text = entry.content;
        if (text.length > 60) {
            text = text.substring(0, 57) + "...";
        }
        if (entry.emotionalSalience > 0.8) {
            text += " (high priority)";
        }
        return text;
    }
}
export async function getSessionContinuationMessage(coreMemories, lastSessionTime) {
    const sc = new SessionContinuation(coreMemories);
    const result = await sc.checkSession("user", lastSessionTime);
    return result.message;
}
//# sourceMappingURL=session-continuation.js.map